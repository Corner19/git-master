#!/usr/bin/env node
/**
 * Daily report regression — the engine against real repositories.
 *
 * Run: node tools/daily-report-regression.mjs
 *
 * The point of building real repositories rather than stubbing `git` is the same
 * one `tools/harness.mjs` makes: the interesting behaviour lives in the
 * interaction with Git (which commits a window contains, what a clone shares,
 * what a remote is called), and a stub would only assert my own assumptions.
 * The two places a stub is used are marked: the payload guard, where 320 real
 * commits would only make the suite slow, and the delivery of model failures,
 * where the model itself is the boundary.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

process.env.TZ = "Asia/Shanghai";

const require = createRequire(import.meta.url);
const engineModule = require("../lib/daily-report.js");
const {
  RETENTION_DAYS,
  MAX_PAYLOAD_CHARS,
  DEFAULT_SCHEDULE,
  defaultConfig,
  normalizeConfig,
  parseSchedule,
  parseDateKey,
  localDateKey,
  isWeekend,
  reportInterval,
  inInterval,
  sanitizeText,
  parseLog,
  dedupeCommits,
  createStore,
  createDailyReport,
} = engineModule;

const SYSTEM = "你是日报编辑。仅依据用户提供的 JSON 提交记录生成简体中文日报总结。";

// -------------------------------------------------------------- schedule ---

{
  // A Monday report reaches back over the weekend to Friday 17:20 (D07 / A06).
  const monday = reportInterval(new Date(2026, 10, 2, 18, 0), DEFAULT_SCHEDULE); // 2026-11-02 is a Monday
  assert.equal(monday.reportDate, "2026-11-02");
  assert.equal(monday.from, new Date(2026, 9, 30, 17, 20).getTime(), "Monday starts at Friday 17:20");
  assert.equal(monday.to, new Date(2026, 10, 2, 17, 20).getTime());

  // A Tuesday report covers exactly the previous day, same wall clock.
  const tuesday = reportInterval(new Date(2026, 10, 3, 18, 0), DEFAULT_SCHEDULE);
  assert.equal(tuesday.from, new Date(2026, 10, 2, 17, 20).getTime());
  assert.equal(tuesday.to, new Date(2026, 10, 3, 17, 20).getTime());

  // Both weekend days preview Friday's window rather than inventing one.
  const saturday = reportInterval(new Date(2026, 9, 31, 12, 0), DEFAULT_SCHEDULE);
  const sunday = reportInterval(new Date(2026, 10, 1, 12, 0), DEFAULT_SCHEDULE);
  assert.equal(saturday.from, new Date(2026, 9, 30, 17, 20).getTime());
  assert.equal(saturday.reportDate, "2026-10-31");
  assert.equal(sunday.from, new Date(2026, 9, 30, 17, 20).getTime());

  // A configured time moves both ends together.
  const custom = reportInterval(new Date(2026, 10, 3, 9, 0), "09:30");
  assert.equal(custom.to, new Date(2026, 10, 3, 9, 30).getTime());
  assert.equal(custom.from, new Date(2026, 10, 2, 9, 30).getTime());

  // Half-open: the closing instant belongs to the next report (A06).
  assert.equal(inInterval(tuesday.from, tuesday), true, "the opening instant is included");
  assert.equal(inInterval(tuesday.to, tuesday), false, "the closing instant is excluded");
  assert.equal(inInterval(tuesday.to - 1, tuesday), true);

  assert.deepEqual(parseSchedule("17:20"), { hour: 17, minute: 20 });
  assert.deepEqual(parseSchedule("7:05"), { hour: 7, minute: 5 });
  for (const bad of ["", "25:00", "17:60", "abc", null, undefined, "17h20"]) {
    assert.deepEqual(parseSchedule(bad), { hour: 17, minute: 20 }, `schedule ${JSON.stringify(bad)} falls back`);
  }
  assert.equal(isWeekend(new Date(2026, 10, 1)), true);
  assert.equal(isWeekend(new Date(2026, 10, 2)), false);

  // Date keys are validated, not merely parsed: February 30th is not a day.
  assert.equal(localDateKey(parseDateKey("2026-11-03")), "2026-11-03");
  for (const bad of ["2026-02-30", "2026-13-01", "../../etc/passwd", "2026-1-3", "", null]) {
    assert.equal(parseDateKey(bad), null, `date ${JSON.stringify(bad)} is rejected`);
  }
}

// ------------------------------------------------------------- sanitizer ---

{
  // Code fences and diff hunks never leave this function (D09).
  const fenced = "修复\n```js\nconst token = 'abc';\n```\n完成";
  assert.ok(!sanitizeText(fenced).includes("const token"), "fenced code is dropped");
  assert.ok(!sanitizeText("a\n@@ -1,4 +1,5 @@\n+b\nc").includes("@@ -1,4"), "hunk headers are dropped");

  // Credential shapes are masked; the rest of the sentence survives (A10).
  const masked = sanitizeText("deploy ghp_abcdefghijklmnopqrstuvwxyz012345 for api_key=abcdefghijklmnopqrst done");
  assert.ok(!masked.includes("ghp_"), "GitHub token masked");
  assert.ok(!masked.includes("abcdefghijklmnopqrst"), "keyed value masked");
  assert.ok(masked.includes("deploy") && masked.includes("done"), "surrounding words survive");
  assert.ok(sanitizeText("-----BEGIN RSA PRIVATE KEY-----\nx\n-----END RSA PRIVATE KEY-----").includes("[REDACTED]"));

  // Ordinary prose is not collateral damage.
  assert.equal(sanitizeText("fix token refresh"), "fix token refresh");
  assert.equal(sanitizeText("  spaced \n\n out  "), "spaced out");

  // Length is bounded and the cut is visible.
  const long = sanitizeText("x".repeat(300));
  assert.equal(long.length, 161);
  assert.ok(long.endsWith("…"));

  // Field/record separators make a subject with spaces unambiguous.
  const parsed = parseLog(`abc123\u001fabc\u001f1767225600\u001f2026-01-01T12:00:00+08:00\u001fDev@Example.com\u001fDev\u001ffeat: add login flow\u001e\n`);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].subject, "feat: add login flow");
  assert.equal(parsed[0].email, "dev@example.com", "author email is lowercased for comparison");
  assert.equal(parsed[0].at, 1767225600 * 1000);
  assert.deepEqual(parseLog(""), []);
  assert.deepEqual(parseLog("garbage without separators"), []);

  // Dedupe keeps one entry per commit id and remembers every repository (A04).
  const one = { hash: "a1", repo: "web" };
  const same = { hash: "a1", repo: "web-copy" };
  const other = { hash: "b2", repo: "api" };
  const merged = dedupeCommits([one, same, other]);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged[0].repos, ["web", "web-copy"]);
  assert.deepEqual(merged[1].repos, ["api"]);
  assert.equal(dedupeCommits([one, same]).length, 1, "the same repo twice is still one commit");
  assert.deepEqual(dedupeCommits([]), []);

  // Config is rebuilt from a known shape, never merged blindly.
  assert.deepEqual(normalizeConfig({}), defaultConfig());
  const normalized = normalizeConfig({
    enabled: "yes",
    schedule: "9:5",
    modelKey: "  fast  ",
    authorEmails: [" Dev@Example.com ", "dev@example.com", "not-an-email", 42],
    excludeRepos: ["vendor/lib", "", 7],
  });
  assert.equal(normalized.enabled, false, "only a real boolean enables the scheduler");
  assert.equal(normalized.schedule, "09:05");
  assert.equal(normalized.modelKey, "fast");
  assert.deepEqual(normalized.authorEmails, ["dev@example.com"], "deduped, lowercased, invalid dropped");
  assert.deepEqual(normalized.excludeRepos, ["vendor/lib"]);
  assert.deepEqual(normalizeConfig(null), defaultConfig());
  assert.deepEqual(normalizeConfig("nonsense"), defaultConfig());
}

// ------------------------------------------------------------------ storage ---

{
  const dir = join(mkdtempSync(join(tmpdir(), "report-store-")), "reports");
  const store = createStore(dir);

  assert.equal(store.get("2026-11-03"), null, "a missing report is not an error");
  assert.equal(store.remove("2026-11-03"), false);
  for (const bad of ["../../etc/passwd", "2026-02-30", "", null]) {
    assert.equal(store.get(bad), null, `path-shaped date ${JSON.stringify(bad)} never reaches the filesystem`);
    assert.equal(store.remove(bad), false);
  }

  assert.throws(() => store.save({ reportDate: "../../evil" }), /valid reportDate/);

  const now = new Date(2026, 10, 3, 18, 0);
  const day = (offset) => new Date(now.getTime() - offset * 24 * 60 * 60 * 1000);
  const stamp = (offset) => localDateKey(day(offset));
  store.save({ reportDate: stamp(0), generatedAt: day(0).toISOString(), summary: "today", commits: [1, 2], repositories: [1] });
  store.save({ reportDate: stamp(89), generatedAt: day(89).toISOString(), summary: "recent" });
  store.save({ reportDate: stamp(91), generatedAt: day(91).toISOString(), summary: "stale" });

  const listed = store.list();
  assert.equal(listed.length, 3);
  assert.equal(listed[0].reportDate, stamp(0), "newest report date first");
  assert.deepEqual([listed[0].commits, listed[0].repositories], [2, 1]);

  assert.equal(store.clean(now), 1, "only the report past the window is removed (D13 / A15)");
  assert.equal(store.get(stamp(91)), null);
  assert.ok(store.get(stamp(89)), "89 days is still inside a 90-day window");
  assert.equal(RETENTION_DAYS, 90);
}

// ------------------------------------------------------------ real repos ---

const scratch = mkdtempSync(join(tmpdir(), "daily-report-"));
// An empty HOME, so no machine-level `user.email` can decide what these tests
// see: "this repository declares no identity" has to mean exactly that.
const fakeHome = join(scratch, "home");
mkdirSync(fakeHome, { recursive: true });
const gitEnv = {
  ...process.env,
  HOME: fakeHome,
  XDG_CONFIG_HOME: join(fakeHome, ".config"),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
};
const git = (cwd, args, env = {}) => execFileSync("git", args, {
  cwd, encoding: "utf8", env: { ...gitEnv, ...env }, stdio: ["ignore", "pipe", "pipe"],
});

/** The adapter the engine gets: real git, resolved failures like `runGit`. */
const gitAdapter = async (args, options) => {
  try {
    return { ok: true, stdout: git(options.cwd, args) };
  } catch (error) {
    return { ok: false, message: String(error.stderr || error.message || error) };
  }
};

function initRepo(name, email = "dev@example.com") {
  const root = join(scratch, name);
  mkdirSync(root, { recursive: true });
  git(scratch, ["init", "-q", "--initial-branch=main", name]);
  if (email) git(root, ["config", "user.email", email]);
  git(root, ["config", "user.name", "Dev"]);
  git(root, ["config", "commit.gpgsign", "false"]);
  return root;
}

function commit(root, subject, iso, authorEmail) {
  const env = { GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso };
  if (authorEmail) {
    env.GIT_AUTHOR_NAME = "Other";
    env.GIT_AUTHOR_EMAIL = authorEmail;
    env.GIT_COMMITTER_NAME = "Other";
    env.GIT_COMMITTER_EMAIL = authorEmail;
  }
  git(root, ["commit", "--allow-empty", "-q", "-m", subject], env);
}

function makeEngine({ dataDir, repos, complete, models, clock = () => new Date(2026, 10, 3, 18, 0) }) {
  const engine = createDailyReport({
    dataDir,
    git: gitAdapter,
    discoverRepositories: async () => repos,
    workspace: async () => scratch,
    systemPrompt: SYSTEM,
    models: models ?? (async () => [{ key: "first" }, { key: "chosen" }]),
    complete,
    clock,
  });
  return engine;
}

try {
  const origin = join(scratch, "origin.git");
  git(scratch, ["init", "-q", "--bare", "origin.git"]);

  // repo-a: two commits inside the window (one exactly on the opening instant).
  const repoA = initRepo("repo-a");
  git(repoA, ["remote", "add", "origin", origin]);
  commit(repoA, "feat: add login flow", "2026-11-02T17:20:00+08:00");
  commit(repoA, "fix: retry token refresh", "2026-11-03T17:00:00+08:00");
  git(repoA, ["push", "-q", "origin", "main"]);

  // repo-b: a second checkout of the same upstream — identical commits, other address.
  git(scratch, ["clone", "-q", origin, "repo-b"]);
  const repoB = join(scratch, "repo-b");
  git(repoB, ["config", "user.email", "dev@example.com"]);
  git(repoB, ["config", "user.name", "Dev"]);
  git(repoB, ["config", "commit.gpgsign", "false"]);
  git(repoB, ["remote", "set-url", "origin", join(scratch, "mirror.git")]);

  // repo-c: its own commit inside the window, plus one exactly on the closing
  // instant which must fall into the NEXT report.
  const repoC = initRepo("repo-c");
  commit(repoC, "docs: describe the engine", "2026-11-03T15:00:00+08:00");
  commit(repoC, "chore: boundary commit", "2026-11-03T17:20:00+08:00");

  // repo-d: a colleague's commit, which is not ours to report.
  const repoD = initRepo("repo-d");
  commit(repoD, "someone else's work", "2026-11-03T12:00:00+08:00", "colleague@example.com");

  const allRepos = [
    { root: repoA, name: "repo-a", rel: "repo-a" },
    { root: repoB, name: "repo-b", rel: "repo-b" },
    { root: repoC, name: "repo-c", rel: "repo-c" },
    { root: repoD, name: "repo-d", rel: "repo-d" },
  ];

  // --- the day's report across several repositories -----------------------
  const dataDir = join(scratch, "data");
  let calls = 0;
  let request = null;
  const engine = makeEngine({
    dataDir,
    repos: allRepos,
    // Deterministic, deduplicated-on-purpose reply: the engine collapses repeats.
    complete: async (input) => { calls += 1; request = input; return { text: "- 修复登录。\n- 修复登录。\n- 补充文档。", modelKey: "chosen" }; },
  });
  const saved = engine.writeConfig({ enabled: true, modelKey: "chosen", authorEmails: ["dev@example.com"] });
  assert.equal(saved.ok, true);
  assert.equal(saved.config.schedule, "17:20");

  const result = await engine.generate();
  assert.equal(result.ok, true, JSON.stringify(result));
  const report = result.report;
  assert.equal(report.reportDate, "2026-11-03");
  assert.equal(report.trigger, "manual");
  assert.equal(report.delivery.status, "stored", "a report is a local artefact");
  assert.equal(calls, 1, "exactly one model call per report (D15)");
  assert.equal(request.modelKey, "chosen", "the configured model is used (D10)");
  assert.equal(request.system, SYSTEM);

  // Three commits for the day: two in repo-a (both also present in the clone at
  // repo-b) and one in repo-c. The shared pair collapses to one record each,
  // carrying both repositories — that is the multi-address case (A04).
  const subjects = report.commits.map((entry) => entry.subject);
  assert.deepEqual(subjects.sort(), ["docs: describe the engine", "feat: add login flow", "fix: retry token refresh"].sort());
  const shared = report.commits.find((entry) => entry.subject === "feat: add login flow");
  assert.deepEqual(shared.repos.sort(), ["repo-a", "repo-b"], "a clone's copy is the same commit, not new work");
  assert.equal(report.stats.commits, 3);
  assert.equal(report.stats.repositories, 4);
  assert.equal(report.stats.duplicates, 2, "both commits of the clone are duplicates, not extra work");

  // The closing instant belongs to the next report; a colleague's commit is not ours.
  assert.ok(!subjects.includes("chore: boundary commit"), "the boundary commit is excluded (A06)");
  assert.ok(!subjects.includes("someone else's work"), "another author's commit is excluded (D02)");

  // Per-repository evidence carries the address the reader needs.
  const byRel = Object.fromEntries(report.repositories.map((entry) => [entry.rel, entry]));
  assert.equal(byRel["repo-a"].remote, origin, "the push URL is the address shown");
  assert.equal(byRel["repo-b"].remote, join(scratch, "mirror.git"), "each checkout keeps its own address");
  assert.equal(byRel["repo-a"].branch, "main");
  assert.equal(byRel["repo-a"].commitCount, 2);
  assert.equal(byRel["repo-c"].commitCount, 1);
  assert.equal(byRel["repo-d"].commitCount, 0, "repo-d's only in-window commit belongs to a colleague");

  // The summary is deduplicated; the payload holds subjects only (D09).
  assert.equal(report.summary, "- 修复登录。\n- 补充文档。");
  const payload = JSON.parse(request.messages[0].content);
  assert.deepEqual([...new Set(payload.map((entry) => entry.project))].sort(), ["repo-a", "repo-c"]);
  assert.deepEqual(Object.keys(payload[0]).sort(), ["description", "project"], "nothing but subject and repository leaves the machine");
  assert.ok(!request.messages[0].content.includes(origin), "the remote URL is never sent to the model");

  // Stored, listed, retrievable, deletable.
  assert.ok(engine.get("2026-11-03"));
  assert.equal(engine.list().length, 1);
  assert.equal(engine.list()[0].commits, 3);
  assert.equal(engine.remove("2026-11-03"), true);
  assert.equal(engine.get("2026-11-03"), null);

  // --- secrets never reach the model or the disk --------------------------
  const secretRoot = initRepo("repo-secret");
  commit(secretRoot, "wire ghp_abcdefghijklmnopqrstuvwxyz012345 into deploy", "2026-11-03T10:00:00+08:00");
  commit(secretRoot, "set token=abcdefghijklmnopqrst for the gateway", "2026-11-03T11:00:00+08:00");
  let leaked = null;
  const secretDir = join(scratch, "data-secret");
  const secretEngine = makeEngine({
    dataDir: secretDir,
    repos: [{ root: secretRoot, name: "repo-secret", rel: "repo-secret" }],
    complete: async (input) => { leaked = input.messages[0].content; return { text: "- 完成部署配置。" }; },
  });
  secretEngine.writeConfig({ modelKey: "chosen" });
  const secretResult = await secretEngine.generate();
  assert.equal(secretResult.ok, true, JSON.stringify(secretResult));
  assert.ok(!leaked.includes("ghp_"), "a GitHub token never reaches the model");
  assert.ok(!leaked.includes("abcdefghijklmnopqrst"), "a keyed value never reaches the model");
  assert.ok(leaked.includes("[REDACTED]"), "the redaction is visible, not silent erasure");

  const onDisk = readFileSync(join(secretDir, "reports", "report-2026-11-03.json"), "utf8");
  assert.ok(!onDisk.includes("ghp_"), "a token is not persisted either");
  assert.ok(!onDisk.includes("abcdefghijklmnopqrst"));

  // --- an empty day is not an empty report (D11 / A08) -------------------
  const emptyDir = join(scratch, "data-empty");
  let emptyCalls = 0;
  const emptyEngine = makeEngine({
    dataDir: emptyDir,
    repos: [{ root: repoC, name: "repo-c", rel: "repo-c" }],
    clock: () => new Date(2026, 11, 20, 18, 0),
    complete: async () => { emptyCalls += 1; return { text: "- 不该出现。" }; },
  });
  const emptyResult = await emptyEngine.generate();
  assert.equal(emptyResult.ok, true);
  assert.equal(emptyResult.empty, true);
  assert.equal(emptyCalls, 0, "no commits means no model call");
  assert.deepEqual(emptyEngine.list(), [], "and no file is written");

  // --- failure paths keep their own codes -------------------------------
  const failDir = join(scratch, "data-fail");
  const failEngine = makeEngine({ dataDir: failDir, repos: allRepos, complete: async () => ({ text: "   " }) });
  failEngine.writeConfig({ modelKey: "chosen" });
  assert.equal((await failEngine.generate()).code, "EMPTY_REPLY");
  assert.deepEqual(failEngine.list(), [], "a failed run stores nothing");

  const throwing = makeEngine({ dataDir: join(scratch, "data-throw"), repos: allRepos, complete: async () => { throw new Error("offline"); } });
  throwing.writeConfig({ modelKey: "chosen" });
  const thrown = await throwing.generate();
  assert.equal(thrown.message, "offline");
  assert.equal(thrown.ok, false);

  for (const listing of [async () => [], async () => { throw Object.assign(new Error("denied"), { code: "PERMISSION_DENIED" }); }]) {
    const noModel = makeEngine({ dataDir: join(scratch, "data-nomodel"), repos: allRepos, complete: async () => ({ text: "x" }), models: listing });
    const outcome = await noModel.generate();
    assert.equal(outcome.ok, false);
    assert.ok(["NO_MODEL", "PERMISSION_DENIED"].includes(outcome.code), outcome.code);
  }

  // A date that is not a date never reaches the filesystem.
  for (const bad of ["../../etc/passwd", "2026-02-30"]) {
    const outcome = await engine.generate({ date: bad });
    assert.equal(outcome.code, "INVALID_DATE", `${bad} is refused`);
  }

  // Reported failures are surfaced, not silently dropped (A05).
  const brokenEngine = makeEngine({
    dataDir: join(scratch, "data-broken"),
    repos: [{ root: join(scratch, "does-not-exist"), name: "gone", rel: "gone" }, { root: repoA, name: "repo-a", rel: "repo-a" }],
    complete: async () => ({ text: "- 完成。" }),
  });
  brokenEngine.writeConfig({ modelKey: "chosen" });
  const broken = await brokenEngine.generate();
  assert.equal(broken.ok, true, "one unreadable repository does not sink the day");
  assert.equal(broken.report.warnings.length, 1);
  assert.ok(broken.report.warnings[0].startsWith("gone:"), broken.report.warnings[0]);
  assert.equal(broken.report.commits.length, 2, "the readable repository still contributes");

  // --- payload guard: refuse, never truncate silently (A11) --------------
  // Stubbed on purpose: 320 real commits would only make this suite slow.
  const bulkRepos = [{ root: join(scratch, "bulk"), name: "bulk", rel: "bulk" }];
  const bulkRecord = (index) => [
    `hash${index}`.padEnd(40, "0"), `short${index}`, String(Math.floor(new Date(2026, 10, 3, 10, 0).getTime() / 1000)),
    "2026-11-03T10:00:00+08:00", "dev@example.com", "Dev", "x".repeat(150),
  ].join("\u001f") + "\u001e\n";
  const bulkGit = async (args) => {
    if (args[0] === "log") return { ok: true, stdout: Array.from({ length: 400 }, (_, index) => bulkRecord(index)).join("") };
    if (args[0] === "remote") return { ok: true, stdout: "" };
    if (args[0] === "config") return { ok: true, stdout: "dev@example.com" };
    return { ok: true, stdout: "main" };
  };
  let bulkCalls = 0;
  const bulkEngine = createDailyReport({
    dataDir: join(scratch, "data-bulk"),
    git: bulkGit,
    discoverRepositories: async () => bulkRepos,
    workspace: async () => scratch,
    systemPrompt: SYSTEM,
    models: async () => [{ key: "chosen" }],
    complete: async () => { bulkCalls += 1; return { text: "- 汇总。" }; },
    clock: () => new Date(2026, 10, 3, 18, 0),
  });
  bulkEngine.writeConfig({ modelKey: "chosen" });
  const bulk = await bulkEngine.generate();
  assert.equal(bulk.ok, false);
  assert.equal(bulk.code, "REPORT_TOO_LARGE");
  assert.ok(Number(/need (\d+) characters/.exec(bulk.message)?.[1]) > MAX_PAYLOAD_CHARS);
  assert.equal(bulkCalls, 0, "an oversized day never reaches the model");
  assert.deepEqual(bulkEngine.list(), [], "and leaves nothing behind");

  // --- the scheduler only fires inside its one-minute window (D06 / A07) --
  const tickDir = join(scratch, "data-tick");
  let tickCalls = 0;
  const tickEngine = makeEngine({
    dataDir: tickDir,
    repos: [{ root: repoA, name: "repo-a", rel: "repo-a" }],
    complete: async () => { tickCalls += 1; return { text: "- 完成。" }; },
  });
  tickEngine.writeConfig({ enabled: false, modelKey: "chosen" });
  assert.equal((await tickEngine.tick(new Date(2026, 10, 3, 17, 20))).code, "DISABLED");

  tickEngine.writeConfig({ enabled: true, modelKey: "chosen" });
  assert.equal((await tickEngine.tick(new Date(2026, 10, 1, 17, 20))).code, "WEEKEND", "Saturday produces nothing");
  assert.equal((await tickEngine.tick(new Date(2026, 10, 3, 17, 19))).code, "NOT_DUE");
  assert.equal((await tickEngine.tick(new Date(2026, 10, 3, 17, 21))).code, "NOT_DUE", "a late wake-up is skipped, not caught up");
  assert.equal(tickCalls, 0);

  const fired = await tickEngine.tick(new Date(2026, 10, 3, 17, 20));
  assert.equal(fired.ok, true, JSON.stringify(fired));
  assert.equal(fired.report.trigger, "scheduled");
  assert.equal(tickCalls, 1);

  assert.equal((await tickEngine.tick(new Date(2026, 10, 3, 17, 20))).code, "ALREADY_RAN", "the second tick inside the same minute is a no-op");
  assert.equal(tickCalls, 1, "and does not call the model again");

  // A report already on disk is the guard that survives a restart.
  const restartDir = join(scratch, "data-restart");
  const restartStore = createStore(join(restartDir, "reports"));
  restartStore.save({ reportDate: "2026-11-03", generatedAt: new Date(2026, 10, 3, 17, 20).toISOString(), summary: "earlier" });
  let restartCalls = 0;
  const restartEngine = makeEngine({
    dataDir: restartDir,
    repos: [{ root: repoA, name: "repo-a", rel: "repo-a" }],
    complete: async () => { restartCalls += 1; return { text: "- 完成。" }; },
  });
  restartEngine.writeConfig({ enabled: true, modelKey: "chosen" });
  assert.equal((await restartEngine.tick(new Date(2026, 10, 3, 17, 20))).code, "ALREADY_RAN");
  assert.equal(restartCalls, 0);

  // Writing config does not let a bad shape through.
  const wiped = restartEngine.writeConfig({ schedule: "99:99", authorEmails: ["nope"] });
  assert.equal(wiped.config.schedule, "17:20");
  assert.deepEqual(wiped.config.authorEmails, []);

  // A project with no configured and no declared identity still reports, with a warning.
  const anonRoot = initRepo("repo-anon", "");
  commit(anonRoot, "anonymous work", "2026-11-03T09:00:00+08:00", "anon@example.com");
  const anonEngine = makeEngine({
    dataDir: join(scratch, "data-anon"),
    repos: [{ root: anonRoot, name: "repo-anon", rel: "repo-anon" }],
    complete: async () => ({ text: "- 匿名提交。" }),
  });
  anonEngine.writeConfig({ modelKey: "chosen" });
  const anon = await anonEngine.generate();
  assert.equal(anon.ok, true, JSON.stringify(anon));
  assert.equal(anon.report.commits.length, 1, "with no identity, every author is included");
  assert.ok(anon.report.warnings.some((warning) => warning.includes("No author email")));

  // A repository the user unchecked contributes nothing and is not even read.
  const excludedEngine = makeEngine({
    dataDir: join(scratch, "data-excluded"),
    repos: [{ root: repoA, name: "repo-a", rel: "repo-a" }, { root: repoC, name: "repo-c", rel: "repo-c" }],
    complete: async () => ({ text: "- 完成。" }),
  });
  excludedEngine.writeConfig({ modelKey: "chosen", excludeRepos: ["repo-a"] });
  const excluded = await excludedEngine.generate();
  assert.equal(excluded.ok, true, JSON.stringify(excluded));
  assert.deepEqual(excluded.report.repositories.map((entry) => entry.rel), ["repo-c"]);
  assert.deepEqual(excluded.report.commits.map((entry) => entry.subject), ["docs: describe the engine"]);

  const noneIncluded = makeEngine({ dataDir: join(scratch, "data-none"), repos: [{ root: repoA, name: "repo-a", rel: "repo-a" }] });
  noneIncluded.writeConfig({ excludeRepos: ["repo-a"] });
  assert.equal((await noneIncluded.generate()).code, "NO_REPOSITORY");

  // generate() is single-flight: a second call while one is running is refused.
  let release = null;
  const slow = makeEngine({
    dataDir: join(scratch, "data-slow"),
    repos: [{ root: repoA, name: "repo-a", rel: "repo-a" }],
    complete: () => new Promise((resolve) => { release = () => resolve({ text: "- 完成。" }); }),
  });
  slow.writeConfig({ modelKey: "chosen" });
  const first = slow.generate();
  await new Promise((resolve) => setTimeout(resolve, 60));
  const second = await slow.generate();
  assert.equal(second.code, "BUSY");
  release();
  assert.equal((await first).ok, true);
  assert.equal(slow.running, false, "the guard is released");

  console.log("PASS: multi-repository collection, shared-commit dedupe, remote addresses, author filter, sanitized payload, empty/failure guards, 90-day retention, one-minute scheduling and single-flight generation");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
