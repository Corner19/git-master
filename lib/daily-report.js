"use strict";
/**
 * Daily report engine (日报) for Git Master.
 *
 * A project's day is spread over every repository it holds — the workspace's
 * own repository, its submodules, and clones that merely live inside it — and
 * one commit often shows up in more than one of them (two checkouts of the same
 * upstream, a submodule plus a sibling copy). Collection therefore runs per
 * repository, every commit is tagged with the repository it came from and that
 * repository's remote address, and identical commit ids are collapsed once at
 * the end while keeping every place they were seen. That is what "one project,
 * several repository addresses" means here: the report is per project, the
 * evidence is per repository.
 *
 * What reaches the model is commit subjects and repository names only — after
 * sanitizing. No file contents, no diffs, no raw tool output, no credentials.
 *
 * Nothing in this file knows about `pi`, `spawn` or the host: everything that
 * touches the outside world is injected (`git`, `discoverRepositories`,
 * `workspace`, `complete`, `models`, `notify`, `clock`), so the whole engine
 * runs from a plain Node process — which is what `tools/daily-report-regression.mjs` does.
 *
 * Note: 日报按「项目 → 多仓库 → 提交去重」建模，而不是给每个仓库单独出日报；同 sha 在多仓出现只记一条并保留全部 repo/remote — 见 .agents/notes/implemented/feature/2026-11-04-daily-report.md
 */

const fs = require("node:fs");
const path = require("node:path");

/** Local detailed history is kept this long, then deleted. */
const RETENTION_DAYS = 90;
/** Default trigger time: after the working day, before the evening. */
const DEFAULT_SCHEDULE = "17:20";
/** How often the scheduler looks at the clock; the window is one minute. */
const TICK_MS = 30_000;
/** Upper bound on the prompt payload; over this the run is refused, not trimmed. */
const MAX_PAYLOAD_CHARS = 60_000;
/** A commit subject is one line of a report, not a document. */
const MAX_SUBJECT_CHARS = 160;

const FS_CHAR = "\u001f";
const RS_CHAR = "\u001e";
const LOG_FORMAT = ["%H", "%h", "%ct", "%cI", "%ae", "%an", "%s"].join("%x1f") + "%x1e";
const REPORT_FILE = /^report-(\d{4})-(\d{2})-(\d{2})\.json$/;
const DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

// --------------------------------------------------------------- schedule ---

/**
 * `HH:mm`, falling back to the default for anything that is not a real time.
 * A wrong schedule must not quietly mean "never runs" or "runs every minute".
 */
function parseSchedule(value) {
  // One or two digits on both sides: a person typing "9:5" means 09:05, and the
  // normalised config below is what everything else reads.
  const match = /^(\d{1,2}):(\d{1,2})$/.exec(String(value ?? "").trim());
  if (!match) return { hour: 17, minute: 20 };
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return { hour: 17, minute: 20 };
  return { hour, minute };
}

function localDateKey(date) {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * `YYYY-MM-DD` as local noon, or null.
 *
 * Noon keeps the key away from both midnights: a date that only means "which
 * day" has no business landing inside a DST gap, and the round-trip check below
 * is what rejects `2026-02-30` instead of silently rolling it to March 2nd.
 */
function parseDateKey(value) {
  const match = DATE_KEY.exec(String(value ?? "").trim());
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12, 0, 0, 0);
  if (Number.isNaN(date.getTime())) return null;
  if (localDateKey(date) !== match[0]) return null;
  return date;
}

function isWeekend(date) {
  const day = date.getDay();
  return day === 0 || day === 6;
}

/**
 * The half-open window a report covers: `[previous workday HH:mm, this day HH:mm)`.
 *
 * Monday reaches back to Friday because the weekend is not a workday; a weekend
 * preview also lands on Friday's window. Both ends are built from local calendar
 * fields rather than by subtracting milliseconds — the boundary is a wall-clock
 * time, and on a DST day "minus 24h" is an hour off.
 */
function reportInterval(now = new Date(), schedule = DEFAULT_SCHEDULE) {
  const { hour, minute } = parseSchedule(schedule);
  const to = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0);
  const day = to.getDay();
  const back = day === 1 ? 3 : day === 0 ? 2 : 1;
  const from = new Date(to.getFullYear(), to.getMonth(), to.getDate() - back, hour, minute, 0, 0);
  return {
    from: from.getTime(),
    to: to.getTime(),
    reportDate: localDateKey(to),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  };
}

/** Half-open: a commit at exactly `to` belongs to the next report, not this one. */
function inInterval(timestamp, interval) {
  return timestamp >= interval.from && timestamp < interval.to;
}

// -------------------------------------------------------------- sanitizer ---

/**
 * Credential-shaped strings that must never reach the model.
 *
 * Deliberately a short list of well-known shapes and a 12-character minimum on
 * a keyed value: a fuzzier rule would eat ordinary words, and an over-reach here
 * only redacts a phrase, it never invents one.
 */
const SECRET_PATTERNS = [
  /bearer\s+[A-Za-z0-9._-]{16,}/gi,
  /\b(?:api[_-]?key|secret|token|password|passwd|authorization)\b\s*[:=]\s*['"]?[A-Za-z0-9._-]{12,}['"]?/gi,
  /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bsk-[A-Za-z0-9]{20,}\b/g,
];
const FENCED_CODE = /```[\s\S]*?```/g;
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@.*$/gm;

/**
 * One safe line of text: code fences and diff hunks dropped (D09), credentials
 * masked (A10), whitespace collapsed, length bounded.
 */
function sanitizeText(value, limit = MAX_SUBJECT_CHARS) {
  let text = String(value ?? "");
  if (!text) return "";
  text = text.replace(FENCED_CODE, " ");
  text = text.replace(HUNK_HEADER, " ");
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, "[REDACTED]");
  text = text.replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

// ------------------------------------------------------------------ commits ---

/**
 * Field-separated records, so a subject containing anything but FS/RS survives.
 * Git puts a newline between records, hence the leading-newline strip.
 */
function parseLog(stdout) {
  const commits = [];
  for (const record of String(stdout ?? "").split(RS_CHAR)) {
    const line = record.replace(/^\n+/, "");
    if (!line) continue;
    const parts = line.split(FS_CHAR);
    if (parts.length < 7) continue;
    const [hash, short, seconds, iso, email, name, subject] = parts;
    const at = Number(seconds) * 1000;
    if (!hash || !Number.isFinite(at)) continue;
    commits.push({
      hash,
      short,
      at,
      iso,
      email: String(email ?? "").trim().toLowerCase(),
      name: String(name ?? "").trim(),
      subject: sanitizeText(subject),
    });
  }
  return commits;
}

/**
 * One entry per commit id, carrying every repository that reported it.
 *
 * Identical ids are the same commit seen twice — two clones of one upstream, a
 * submodule and its parent's copy, a worktree pair — so collapsing them is what
 * stops "N repositories" from inflating the day's work (A04). Repositories stay
 * in first-seen order so the primary one, the one the reader recognises, is
 * first.
 */
function dedupeCommits(commits) {
  const byHash = new Map();
  for (const commit of commits) {
    if (!commit?.hash) continue;
    const seen = byHash.get(commit.hash);
    if (!seen) {
      byHash.set(commit.hash, { ...commit, repos: commit.repo ? [commit.repo] : [] });
      continue;
    }
    if (commit.repo && !seen.repos.includes(commit.repo)) seen.repos.push(commit.repo);
  }
  return [...byHash.values()];
}

/** Newest first, de-duplicated — the same rule the commit-message draft uses. */
function uniqueLines(text) {
  const lines = String(text ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return [...new Set(lines)].join("\n");
}

// ------------------------------------------------------------------ storage ---

/**
 * Reports on disk, one file per report date, under the plugin's own data
 * directory. Never the workspace: a report outlives the project it describes and
 * must not be something a user commits by accident.
 */
function createStore(dir) {
  const fileFor = (date) => path.join(dir, `report-${date}.json`);

  function save(report) {
    const date = String(report?.reportDate ?? "");
    if (!parseDateKey(date)) throw new Error("A report needs a valid reportDate.");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(fileFor(date), JSON.stringify(report, null, 2), "utf8");
    return report;
  }

  /** Null for a date that is not a date — before any path is built from it. */
  function get(date) {
    if (!parseDateKey(String(date ?? ""))) return null;
    try {
      return JSON.parse(fs.readFileSync(fileFor(String(date)), "utf8"));
    } catch {
      return null;
    }
  }

  function remove(date) {
    if (!parseDateKey(String(date ?? ""))) return false;
    try {
      fs.unlinkSync(fileFor(String(date)));
      return true;
    } catch {
      return false;
    }
  }

  /** Summaries for the history list: newest report date first. */
  function list() {
    let files;
    try {
      files = fs.readdirSync(dir);
    } catch {
      return [];
    }
    const reports = [];
    for (const file of files) {
      const match = REPORT_FILE.exec(file);
      if (!match) continue;
      const report = get(`${match[1]}-${match[2]}-${match[3]}`);
      if (!report) continue;
      reports.push({
        reportDate: report.reportDate,
        generatedAt: report.generatedAt,
        trigger: report.trigger,
        status: report.delivery?.status ?? "stored",
        commits: Array.isArray(report.commits) ? report.commits.length : 0,
        repositories: Array.isArray(report.repositories) ? report.repositories.length : 0,
        summary: String(report.summary ?? "").split("\n")[0] ?? "",
      });
    }
    return reports.sort((left, right) => String(right.reportDate).localeCompare(String(left.reportDate)));
  }

  /** Drop reports older than the retention window; returns how many went (D13). */
  function clean(now = new Date()) {
    const cutoff = now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
    let files;
    try {
      files = fs.readdirSync(dir);
    } catch {
      return 0;
    }
    let removed = 0;
    for (const file of files) {
      const match = REPORT_FILE.exec(file);
      if (!match) continue;
      const report = get(`${match[1]}-${match[2]}-${match[3]}`);
      const at = report?.generatedAt ? Date.parse(report.generatedAt) : NaN;
      if (Number.isFinite(at) && at < cutoff && remove(report.reportDate)) removed += 1;
    }
    return removed;
  }

  return { dir, fileFor, save, get, remove, list, clean };
}

// ------------------------------------------------------------------- config ---

function defaultConfig() {
  return { enabled: false, schedule: DEFAULT_SCHEDULE, modelKey: "", authorEmails: [], excludeRepos: [] };
}

/**
 * Stored config is untrusted input: every field is rebuilt from a known shape
 * rather than merged, so a malformed file can never widen what the engine does.
 */
function normalizeConfig(value) {
  const source = value && typeof value === "object" ? value : {};
  const emails = Array.isArray(source.authorEmails) ? source.authorEmails : [];
  const excluded = Array.isArray(source.excludeRepos) ? source.excludeRepos : [];
  const { hour, minute } = parseSchedule(source.schedule);
  const clean = (list, pattern, limit) => [...new Set(list
    .filter((entry) => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry && pattern.test(entry)))].slice(0, limit);
  return {
    enabled: source.enabled === true,
    schedule: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
    modelKey: typeof source.modelKey === "string" ? source.modelKey.trim().slice(0, 200) : "",
    authorEmails: clean(emails.map((email) => (typeof email === "string" ? email.toLowerCase() : "")), /^[^@\s]+@[^@\s]+$/, 20),
    excludeRepos: clean(excluded, /^[^\\\u0000]{1,300}$/, 200),
  };
}

// ------------------------------------------------------------------- engine ---

/**
 * @param {object} options
 * @param {string} options.dataDir        plugin data directory; reports live under `<dataDir>/reports`
 * @param {(args: string[], opts: {cwd: string}) => Promise<{ok: boolean, stdout?: string, message?: string}>} options.git
 * @param {(workspace: string) => Promise<Array<{root: string, name: string, rel: string}>>} options.discoverRepositories
 * @param {() => Promise<string|null>} options.workspace
 * @param {string} options.systemPrompt   the factual summarizer prompt, shared with the dialog summary
 * @param {() => Promise<Array<{key: string}>>} [options.models]
 * @param {(input: object) => Promise<{text?: string, modelKey?: string}>} [options.complete]
 * @param {(message: string) => void} [options.notify]
 * @param {() => Date} [options.clock]
 */
function createDailyReport(options) {
  const dataDir = options.dataDir;
  const git = options.git;
  const discoverRepositories = options.discoverRepositories;
  const workspace = options.workspace;
  const systemPrompt = options.systemPrompt;
  const models = options.models ?? null;
  const complete = options.complete ?? null;
  const notify = options.notify ?? (() => {});
  const clock = options.clock ?? (() => new Date());

  const store = createStore(path.join(dataDir, "reports"));
  const configFile = path.join(dataDir, "config.json");

  let timer = null;
  let running = false;
  let lastTriggerKey = "";

  function readConfig() {
    try {
      return normalizeConfig(JSON.parse(fs.readFileSync(configFile, "utf8")));
    } catch {
      return defaultConfig();
    }
  }

  function writeConfig(patch) {
    const next = normalizeConfig({ ...readConfig(), ...(patch && typeof patch === "object" ? patch : {}) });
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(configFile, JSON.stringify(next, null, 2), "utf8");
    } catch (error) {
      return { ok: false, code: "CONFIG_WRITE_FAILED", message: String(error?.message ?? error), config: next };
    }
    return { ok: true, config: next };
  }

  /**
   * The address a report names for a repository: the push URL when there is one,
   * otherwise the first remote of any kind.
   *
   * Split on the tab Git writes, not on whitespace, so a local path with spaces
   * in it stays one value.
   */
  function pickRemote(stdout) {
    const parsed = [];
    for (const line of String(stdout ?? "").split("\n")) {
      const tab = line.indexOf("\t");
      if (tab < 0) continue;
      const name = line.slice(0, tab).trim();
      const rest = line.slice(tab + 1).trim();
      const match = /^(.*)\s+\((push|fetch)\)$/.exec(rest);
      if (match) parsed.push({ name, url: match[1].trim(), kind: match[2] });
    }
    return (parsed.find((entry) => entry.kind === "push") ?? parsed[0])?.url ?? "";
  }

  /**
   * What a repository is called, where it points and what identity it declares —
   * three `git` reads, no log. Split out because the settings form needs exactly
   * this and must not pay for a history walk to render a checkbox.
   */
  async function describeRepository(repo) {
    const root = repo.root;
    const rel = repo.rel && repo.rel !== "." ? repo.rel : repo.name;
    const result = { rel, name: repo.name, root, remote: "", branch: "", email: "" };

    const remotes = await git(["remote", "-v"], { cwd: root });
    if (remotes?.ok) result.remote = pickRemote(remotes.stdout);

    const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: root });
    if (branch?.ok) result.branch = String(branch.stdout ?? "").trim();

    const identity = await git(["config", "user.email"], { cwd: root });
    if (identity?.ok) result.email = String(identity.stdout ?? "").trim().toLowerCase();

    return result;
  }

  /**
   * One repository's contribution: its address, its branch, the identity commits
   * would be authored under, and every commit its log can reach.
   */
  async function readRepository(repo, interval) {
    const described = await describeRepository(repo);
    const result = { ...described, commits: [], error: "" };
    const root = described.root;
    const rel = described.rel;

    // One second of slack on the lower bound; `inInterval` is the authority, so
    // a commit landing in that slack second is still excluded.
    const log = await git([
      "log",
      "--all",
      `--since-as-filter=@${Math.floor(interval.from / 1000) - 1}`,
      `--format=${LOG_FORMAT}`,
    ], { cwd: root });
    if (!log?.ok) {
      result.error = String(log?.message ?? "git log failed");
      return result;
    }
    result.commits = parseLog(log.stdout).map((commit) => ({
      ...commit,
      repo: rel,
      remote: result.remote,
      branch: result.branch,
    }));
    return result;
  }

  async function resolveModel(preferred) {
    if (!models) return { ok: false, code: "NO_MODEL", message: "No model is available." };
    let listing;
    try {
      listing = await models();
    } catch (error) {
      return { ok: false, code: String(error?.code ?? "MODEL_LIST_FAILED"), message: String(error?.message ?? error) };
    }
    if (!Array.isArray(listing) || !listing.length) {
      return { ok: false, code: "NO_MODEL", message: "No model is available." };
    }
    return { ok: true, model: listing.find((entry) => entry.key === preferred) ?? listing[0] };
  }

  /**
   * Build and store one report. `date` (YYYY-MM-DD) previews another day; the
   * window itself still comes from the configured schedule.
   *
   * A day with no commits is not an empty report: no model call, no file, and
   * `empty: true` so the UI can say so plainly instead of showing a blank page
   * (D11 / A08).
   */
  async function generate(request = {}) {
    if (running) return { ok: false, code: "BUSY", message: "A report is already being generated." };
    running = true;
    try {
      const config = readConfig();
      const base = request.date ? parseDateKey(request.date) : clock();
      if (!base) return { ok: false, code: "INVALID_DATE", message: "Invalid report date." };
      const interval = reportInterval(base, config.schedule);

      const workspaceRoot = await workspace();
      if (!workspaceRoot) return { ok: false, code: "NO_WORKSPACE", message: "No workspace is open." };

      let discovered;
      try {
        discovered = await discoverRepositories(workspaceRoot);
      } catch (error) {
        return { ok: false, code: "REPOSITORY_DISCOVERY_FAILED", message: String(error?.message ?? error) };
      }
      const relOf = (repo) => (repo.rel && repo.rel !== "." ? repo.rel : repo.name);
      const included = (Array.isArray(discovered) ? discovered : []).filter((repo) => !config.excludeRepos.includes(relOf(repo)));
      if (!included.length) {
        return { ok: false, code: "NO_REPOSITORY", message: "No repository is included in the report." };
      }

      const warnings = [];
      const repositories = [];
      const collected = [];
      const detected = [];
      for (const repo of included) {
        const read = await readRepository(repo, interval);
        repositories.push({ rel: read.rel, name: read.name, remote: read.remote, branch: read.branch, commitCount: 0 });
        if (read.email) detected.push(read.email);
        if (read.error) warnings.push(`${read.rel}: ${read.error}`);
        collected.push(...read.commits);
      }

      // A configured list wins; otherwise the identities the repositories
      // themselves declare, so a fresh install reports its own commits without
      // any setup.
      const authors = config.authorEmails.length ? config.authorEmails : [...new Set(detected)];
      if (!authors.length) warnings.push("No author email is configured or detected; every author is included.");
      const inWindow = collected.filter((commit) => inInterval(commit.at, interval));
      const mine = authors.length ? inWindow.filter((commit) => authors.includes(commit.email)) : inWindow;
      const commits = dedupeCommits(mine);

      for (const repository of repositories) {
        repository.commitCount = commits.filter((commit) => commit.repos.includes(repository.rel)).length;
      }

      if (!commits.length) return { ok: true, empty: true, interval, repositories, warnings };
      if (!complete) return { ok: false, code: "NO_MODEL", message: "No model is available." };

      const resolved = await resolveModel(config.modelKey);
      if (!resolved.ok) return resolved;

      // Same shape the dialog summary consumes: `{ project, description }` per
      // commit. The project is the repository, because a project here is the
      // workspace and a repository is what a reader recognises.
      const entries = commits.map((commit) => ({ project: commit.repo, description: commit.subject }));
      const content = JSON.stringify(entries);
      if (content.length > MAX_PAYLOAD_CHARS) {
        return {
          ok: false,
          code: "REPORT_TOO_LARGE",
          message: `Today's commits need ${content.length} characters; exclude a repository or shorten the window.`,
        };
      }

      let text;
      try {
        const result = await complete({
          modelKey: resolved.model.key,
          system: systemPrompt,
          messages: [{ role: "user", content }],
        });
        text = String(result?.text ?? "").trim();
      } catch (error) {
        return { ok: false, code: String(error?.code ?? "FAILED"), message: String(error?.message ?? error) };
      }
      if (!text) return { ok: false, code: "EMPTY_REPLY", message: "The model returned nothing." };

      const now = clock();
      const report = {
        version: 1,
        reportDate: interval.reportDate,
        interval,
        generatedAt: now.toISOString(),
        trigger: request.trigger === "scheduled" ? "scheduled" : "manual",
        modelKey: resolved.model.key,
        summary: uniqueLines(text),
        commits: commits.map((commit) => ({
          hash: commit.hash,
          short: commit.short,
          at: commit.at,
          subject: commit.subject,
          repos: commit.repos,
        })),
        repositories,
        stats: {
          repositories: repositories.length,
          commits: commits.length,
          duplicates: mine.length - commits.length,
          authors: [...new Set(commits.map((commit) => commit.email))].length,
        },
        warnings,
        // The delivery slot exists and stays `stored` for now: the report is a
        // local artefact, and adding a channel later must not change the model.
        delivery: { status: "stored", updatedAt: now.toISOString() },
      };

      try {
        store.save(report);
        store.clean(now);
      } catch (error) {
        return { ok: false, code: "STORAGE_FAILED", message: String(error?.message ?? error) };
      }
      return { ok: true, report };
    } finally {
      running = false;
    }
  }

  /**
   * One look at the clock.
   *
   * The window is the whole configured minute, so a machine suspended through
   * 17:20 and woken at 18:40 never matches and nothing is produced late (D06 /
   * A07). `lastTriggerKey` keeps the two ticks inside the same minute from both
   * firing, and the stored report is the second guard across restarts.
   */
  async function tick(at = clock()) {
    const config = readConfig();
    if (!config.enabled) return { ok: false, code: "DISABLED" };
    if (isWeekend(at)) return { ok: false, code: "WEEKEND" };
    const { hour, minute } = parseSchedule(config.schedule);
    if (at.getHours() !== hour || at.getMinutes() !== minute) return { ok: false, code: "NOT_DUE" };
    const interval = reportInterval(at, config.schedule);
    const key = `${interval.reportDate} ${config.schedule}`;
    if (lastTriggerKey === key) return { ok: false, code: "ALREADY_RAN" };
    lastTriggerKey = key;
    if (store.get(interval.reportDate)) return { ok: false, code: "ALREADY_RAN" };

    const result = await generate({ trigger: "scheduled" });
    try {
      if (result.ok === true && result.empty) notify(`${interval.reportDate}: no commits, no report.`);
      else if (result.ok === true) notify(`${interval.reportDate}: daily report ready.`);
      else notify(`Daily report failed: ${result.message ?? result.code}`);
    } catch {
      // A failed notification must not take the scheduler down with it.
    }
    return result;
  }

  function startScheduler() {
    if (timer) return;
    timer = setInterval(() => {
      tick().catch(() => {});
    }, TICK_MS);
    // The host keeps the process alive for the service; this timer must not be
    // the reason the process cannot exit.
    if (typeof timer.unref === "function") timer.unref();
    tick().catch(() => {});
  }

  function stopScheduler() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }

  /**
   * Every repository the next report would cover, with its address — what the
   * settings form renders and what makes "one project, several repository
   * addresses" visible before any report exists.
   */
  async function describe() {
    const workspaceRoot = await workspace();
    if (!workspaceRoot) return { ok: false, code: "NO_WORKSPACE", message: "No workspace is open." };
    let discovered;
    try {
      discovered = await discoverRepositories(workspaceRoot);
    } catch (error) {
      return { ok: false, code: "REPOSITORY_DISCOVERY_FAILED", message: String(error?.message ?? error) };
    }
    const repositories = [];
    const detectedAuthors = [];
    for (const repo of Array.isArray(discovered) ? discovered : []) {
      const described = await describeRepository(repo);
      if (described.email) detectedAuthors.push(described.email);
      repositories.push({
        rel: described.rel,
        name: described.name,
        remote: described.remote,
        branch: described.branch,
        email: described.email,
      });
    }
    return { ok: true, workspace: workspaceRoot, repositories, detectedAuthors: [...new Set(detectedAuthors)] };
  }

  return {
    dataDir,
    store,
    readConfig,
    writeConfig,
    describe,
    generate,
    tick,
    startScheduler,
    stopScheduler,
    list: () => store.list(),
    get: (date) => store.get(date),
    remove: (date) => store.remove(date),
    clean: () => store.clean(clock()),
    get running() {
      return running;
    },
  };
}

// Only what something outside this file actually reaches for: the engine factory
// and the pure pieces the regression suite asserts directly. `TICK_MS`,
// `MAX_SUBJECT_CHARS` and `uniqueLines` stay private — exporting "for symmetry"
// is how a module's surface stops meaning anything.
module.exports = {
  RETENTION_DAYS,
  DEFAULT_SCHEDULE,
  MAX_PAYLOAD_CHARS,
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
};
