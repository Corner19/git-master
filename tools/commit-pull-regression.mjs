#!/usr/bin/env node
// Run: node tools/commit-pull-regression.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../src/commit-view.js", import.meta.url), "utf8");
const start = source.indexOf("    function paintToolbar() {");
const end = source.indexOf("     function paintChangesHeader()", start);
assert.ok(start >= 0 && end > start, "real toolbar render function exists");
function node(props = {}) {
  return {
    ...props, children: [], classes: new Set(),
    classList: { add(name) { this.owner.classes.add(name); } },
    append(...items) { this.children.push(...items); },
  };
}
const toolbar = node();
const state = { syncing: null, busy: false, repo: { branch: {} } };
let finish;
let calls = 0;
let refreshes = 0;
const reports = [];
const context = vm.createContext({
  state, toolbar, repoHolder: node(), branchHolder: node(),
  PIG: { clear(target) { target.children = []; }, spinner: () => node() },
  h: (_tag, props) => node(props), t: (key) => key, tip: (key) => key, KEYS: {},
  iconButton(name, title, onclick, options) {
    const button = node({ name, title, onclick, ...options });
    button.classList.owner = button;
    return button;
  },
  stageSelected() {}, rollbackSelected() {}, canStageSelected: () => false,
  canUnstageSelected: () => false, repositoryLabel: () => "repo",
  invoke(channel) {
    assert.equal(channel, "git/pull", "fetch-icon button directly runs pull");
    calls++;
    return new Promise((resolve, reject) => { finish = { resolve, reject }; });
  },
  report(result, action) { reports.push({ result, action }); return result.ok; },
  async refresh() { refreshes++; },
});
vm.runInContext(source.slice(start, end), context);
const paint = () => vm.runInContext("paintToolbar()", context);
const pull = () => toolbar.children.find((button) => button.title === "pull");
paint();
assert.equal(pull().name, "fetch", "pull uses the fetch icon");
const titles = toolbar.children.filter((button) => button.title).map((button) => button.title);
assert.deepEqual(titles.slice(0, 3), ["refresh", "pull", "push"]);
for (const result of [{ ok: true }, { ok: false, pullHint: "conflict" }]) {
  const button = pull();
  const pending = button.onclick();
  assert.equal(state.syncing, "pull");
  assert.ok(pull().classes.has("busy"), "pull displays a spinner while running");
  assert.ok(toolbar.children.filter((item) => item.onclick).every((item) => item.disabled));
  const count = calls;
  await button.onclick();
  assert.equal(calls, count, "repeated clicks cannot start another pull");
  finish.resolve(result);
  await pending;
  assert.equal(state.syncing, null);
  assert.equal(pull().disabled, false);
  assert.equal(reports.at(-1).result, result);
  assert.equal(reports.at(-1).action, "pull");
}
assert.equal(refreshes, 2, "success and conflict both refresh repository state");
const pending = pull().onclick();
finish.reject(new Error("bridge failure"));
await assert.rejects(pending, /bridge failure/);
assert.equal(state.syncing, null, "exceptions release the busy state");
assert.equal(pull().disabled, false);
state.busy = true;
paint();
assert.equal(pull().disabled, true, "commit operations disable pull");
const count = calls;
await pull().onclick();
assert.equal(calls, count);
console.log("PASS: single repo fetch-icon pull routing");

// Multi-repo toolbar pull regression
let pullReposCalledWith = null;
let reportPullOutcomesCalledWith = null;
context.state.busy = false;
context.state.syncing = null;
context.state.allRepos = [{ root: "/path/to/repoA", rel: "repoA" }, { root: "/path/to/repoB", rel: "repoB" }];
context.PIG.pullRepos = async (targets) => {
  pullReposCalledWith = targets;
  return [{ ok: true, rel: "repoA" }, { ok: true, rel: "repoB" }];
};
context.PIG.reportPullOutcomes = (outcomes) => {
  reportPullOutcomesCalledWith = outcomes;
};
paint();
const multiPending = pull().onclick();
assert.equal(state.syncing, "pull");
await multiPending;
assert.equal(state.syncing, null);
assert.deepEqual(pullReposCalledWith, context.state.allRepos, "pullRepos receives allRepos targets");
assert.equal(reportPullOutcomesCalledWith.length, 2, "reportPullOutcomes reports both repo outcomes");
console.log("PASS: multi-repo fetch-icon pull routing, busy guard, and outcome reporting");
