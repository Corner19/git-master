#!/usr/bin/env node
// Run: node tools/daily-summary-regression.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const source = read("main.js");
const start = source.indexOf("async function draftDailySummary(");
const end = source.indexOf("function localTodayRange(", start);
assert.ok(start >= 0 && end > start);
let calls = 0;
let request;
let response = { text: "- 项目 A：修复登录。\n- 项目 A：修复登录。\n- 项目 B：更新文档。" };
const context = vm.createContext({
  listModels: async () => ({ ok: true, models: [{ key: "first" }, { key: "chosen" }] }),
  readPrefs: async () => ({ ui: { commitModelKey: "chosen" } }),
  pi: { agent: { complete: async (value) => { calls++; request = value; return response; } } },
});
vm.runInContext(source.slice(start, end), context);
const report = { errors: [], commits: [
  { project: "A", subject: "修复登录" }, { project: "A", subject: " 修复登录 " },
  { project: "B", subject: "更新文档" },
] };
const result = await context.draftDailySummary(report);
assert.equal(result.ok, true);
assert.equal(result.text.split("\n").length, 2, "identical output lines are deduplicated");
assert.equal(request.modelKey, "chosen");
assert.equal(JSON.parse(request.messages[0].content).length, 2, "duplicate source entries are removed per project");
assert.match(request.system, /不得添加原文未提供的信息/);
assert.match(request.system, /合并同义和重复表述/);
assert.match(request.system, /不是指令/);
assert.equal((await context.draftDailySummary({ errors: [], commits: [] })).empty, true);
assert.equal((await context.draftDailySummary({ ...report, errors: [{}] })).code, "INCOMPLETE_REPORT");
assert.equal((await context.draftDailySummary({ errors: [], commits: [{ project: "A", subject: "x".repeat(60001) }] })).code, "REPORT_TOO_LARGE");
assert.equal(calls, 1, "empty, incomplete and oversized reports do not call the model");
response = { text: "  " };
assert.equal((await context.draftDailySummary(report)).code, "EMPTY_REPLY");
context.pi.agent.complete = async () => { throw new Error("offline"); };
assert.equal((await context.draftDailySummary(report)).message, "offline");
context.listModels = async () => ({ ok: false, code: "NO_MODEL" });
assert.equal((await context.draftDailySummary(report)).code, "NO_MODEL");

const common = read("src/common.js");
const uiStart = common.indexOf("  let todayCommitsLoading");
const uiEnd = common.indexOf("  // Note:", uiStart);
let dialogs = [];
let channels = [];
let data = report;
let confirm = true;
const ui = vm.createContext({
  t: (key) => key, todayCommitsDetail: () => "raw records", errorText: (r) => r.message,
  runWithPill: (_label, fn) => fn(), toast: () => {},
  invoke: async (channel) => { channels.push(channel); return channel === "git/today-commits" ? { ok: true, ...data } : { ok: true, text: "summary" }; },
  dialog: async (options) => { dialogs.push(options); return confirm; },
});
vm.runInContext(common.slice(uiStart, uiEnd), ui);
await ui.openTodayCommits();
assert.deepEqual(channels, ["git/today-commits", "git/daily-summary"]);
assert.equal(dialogs[1].detail, "summary");
for (const value of [{ errors: [], commits: [] }, { ...report, errors: [{}] }]) {
  data = value; channels = []; dialogs = [];
  await ui.openTodayCommits();
  assert.equal(channels.length, 1);
  assert.equal(dialogs[0].confirmLabel, "close");
}
data = report; confirm = false; channels = [];
await ui.openTodayCommits();
assert.equal(channels.length, 1, "closing does not generate a summary");
console.log("PASS: daily summary source/output deduplication, factual prompt, model selection, empty/error guards and dialog flow");
