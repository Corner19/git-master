#!/usr/bin/env node
// Run: node tools/today-commits-regression.mjs
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import vm from "node:vm";
process.env.TZ = "Asia/Shanghai";
const source = readFileSync(new URL("../main.js", import.meta.url), "utf8");
const first = source.indexOf("function localTodayRange(");
const last = source.indexOf("async function readLog(", first);
assert.ok(first >= 0 && last > first);
const scratch = mkdtempSync(join(process.env.PI_SCRATCH_DIR || tmpdir(), "today-commits-"));
const git = (root, args, env = {}) => execFileSync("git", args, { cwd: root, encoding: "utf8", env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
const context = vm.createContext({ Date, runGit: async (args, options) => {
  try { return { ok: true, stdout: git(options.cwd, args) }; }
  catch (error) { return { ok: false, message: String(error.stderr) }; }
} });
vm.runInContext(source.slice(first, last), context);
const now = new Date("2026-09-15T12:00:00+08:00");
try {
  const { mkdirSync } = await import("node:fs");
  function repo(name) {
    const root = join(scratch, name);
    mkdirSync(root);
    git(root, ["init", "-q"]);
    git(root, ["config", "user.name", "Test"]);
    git(root, ["config", "user.email", "test@example.com"]);
    return { root, name, rel: name };
  }
  function commit(repo, subject, date) {
    git(repo.root, ["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", subject], { GIT_AUTHOR_DATE: "2026-09-01T12:00:00+08:00", GIT_COMMITTER_DATE: date });
  }
  const a = repo("project-a"), b = repo("project-b"), empty = repo("empty");
  commit(a, "yesterday", "2026-09-14T23:59:59+08:00");
  commit(a, "midnight", "2026-09-15T00:00:00+08:00");
  commit(a, "out-of-order-old", "2026-09-13T12:00:00+08:00");
  commit(a, "last-second", "2026-09-15T23:59:59+08:00");
  commit(a, "tomorrow", "2026-09-16T00:00:00+08:00");
  git(a.root, ["branch", "duplicate-ref"]);
  commit(b, "offset-date", "2026-09-14T18:00:00-04:00");
  const result = await context.readTodayCommits([a, b, empty], now);
  assert.equal(result.projectCount, 3);
  assert.equal(result.errors.length, 0, "empty repository is not a failure");
  assert.deepEqual(Array.from(result.commits, (c) => c.subject), ["last-second", "offset-date", "midnight"]);
  assert.deepEqual(Array.from(result.commits, (c) => c.project), ["project-a", "project-b", "project-a"]);
  assert.equal(result.start, Date.parse("2026-09-15T00:00:00+08:00"));
  assert.equal(result.end, Date.parse("2026-09-16T00:00:00+08:00"));
  assert.equal((await context.readTodayCommits([a, b], new Date("2026-09-20T12:00:00+08:00"))).commits.length, 0);
  process.env.TZ = "America/New_York";
  const dst = context.localTodayRange(new Date("2026-03-08T12:00:00-04:00"));
  assert.equal(dst.end - dst.start, 23 * 60 * 60 * 1000, "DST uses next local midnight, not +24h");
  context.runGit = async () => ({ ok: true, stdout: "", truncated: true });
  assert.equal((await context.readTodayCommits([a], now)).errors.length, 1);
  process.env.TZ = "Asia/Shanghai";
  context.runGit = async () => ({ ok: false, message: "unreadable repository" });
  assert.equal((await context.readTodayCommits([a], now)).errors[0].message, "unreadable repository");
  context.runGit = async (args) => {
    assert.ok(!args.some((arg) => arg.startsWith("--max-count")), "daily report has no history-page count cap");
    return { ok: true, stdout: Array.from({ length: 501 }, (_, i) => `hash${i}\0${result.start / 1000}\0message ${i}\0`).join("") };
  };
  assert.equal((await context.readTodayCommits([a], now)).commits.length, 501);
  const common = readFileSync(new URL("../src/common.js", import.meta.url), "utf8");
  const uiStart = common.indexOf("  function todayCommitsDetail(");
  const uiEnd = common.indexOf("  let todayCommitsLoading", uiStart);
  const ui = vm.createContext({ Date, t: (key) => key, tf: (key, values) => `${key}: ${values.projects}/${values.commits}` });
  vm.runInContext(common.slice(uiStart, uiEnd), ui);
  const detail = ui.todayCommitsDetail(result);
  assert.ok(detail.includes("project-a") && detail.includes("project-b") && detail.includes("offset-date"));
  assert.ok(!detail.includes("yesterday") && !detail.includes("tomorrow"));
  const blank = { ...result, commits: [], errors: [] };
  assert.ok(ui.todayCommitsDetail(blank).includes("todayCommitsEmpty"));
  assert.ok(!ui.todayCommitsDetail({ ...blank, errors: [{ project: "failed", message: "error" }] }).includes("todayCommitsEmpty"));
  console.log("PASS: real multi-project Git history, branch deduplication, local midnight boundaries, timezone offsets, DST, empty state and partial failure");
} finally { rmSync(scratch, { recursive: true, force: true }); }
