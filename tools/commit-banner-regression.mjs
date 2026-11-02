#!/usr/bin/env node
/** Run: node tools/commit-banner-regression.mjs
 * Exercise the real input handler and render functions with a minimal DOM stub.
 * Use tools/smoke.mjs commit zh-CN for the corresponding browser fixture.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../src/commit-view.js", import.meta.url), "utf8");
function node(tag = "div", props = {}, children = []) {
  return {
    tag, ...props, children: [...children],
    classList: { add() {}, remove() {} },
    append(...items) { this.children.push(...items); },
  };
}
const state = {
  message: "", amend: false, busy: false, repo: null,
  recentCommit: {
    hash: "603f5a30000000000000000000000000000000000",
    subject: "feat: 为文件存储组件与通用文件接口集成Swagger(OpenAPI)文档支持",
  },
};
const host = node();
const button = node("button");
let mutations = 0;
const context = vm.createContext({
  state, recentCommitContainer: host, commitButton: button,
  commitMenuButton: node("button"), summary: node(),
  PIG: {
    clear(target) { if (target === host) mutations++; target.children = []; },
    tf(key) { return key; }, spinner() { return node(); },
  },
  h: node, icon: () => node("svg"), t: (key) => key,
  totalCounts: () => ({ staged: 1, unstaged: 0, untracked: 0, conflicted: 0 }),
  stagedTargets: () => [{}], OPERATION_KEYS: {},
  paintToolbar() {}, paintChangesHeader() {}, paintChanges() {},
  paintDiff() {}, paintGenerate() {}, branchWidget: null,
  reportedFailure: false, toast(message) { throw new Error(message); },
});
function section(start, end) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first, `missing source section: ${start}`);
  return source.slice(first, last);
}
vm.runInContext(section("    function paintCommit() {", "    function operationButton("), context);
vm.runInContext(section("    function paintAll() {", "    // ----------------------------------------------------------- actions"), context);
const handler = source.match(/oninput: (\(event\) => \{ state\.message = event\.target\.value; paintCommit\(\); \})/);
assert.ok(handler, "real commit message input handler exists");
const input = vm.runInContext(`(${handler[1]})`, context);
vm.runInContext("paintAll()", context);
assert.equal(host.children.length, 1, "initial refresh shows one recent commit card");
const card = host.children[0];
mutations = 0;
const text = "最新提交 603f5a3 feat: 为文件存储组件与通用文件接口集成Swagger(OpenAPI)文档支持";
for (let i = 1; i <= text.length; i++) {
  input({ target: { value: text.slice(0, i) } });
  assert.equal(host.children[0], card, "typing must retain the card and its animation");
  assert.equal(button.disabled, false, "nonempty message enables commit");
}
for (const value of ["", "   ", "\n"]) {
  input({ target: { value } });
  assert.equal(button.disabled, true, "empty/whitespace message disables commit");
}
assert.equal(mutations, 0, "input never clears the recent commit host");
state.amend = true;
input({ target: { value: "" } });
assert.equal(button.disabled, false, "amend remains available without a message");
state.recentCommit = { hash: "abcdef123", subject: "next commit" };
vm.runInContext("paintAll()", context);
assert.notEqual(host.children[0], card, "refresh updates the recent commit card");
assert.equal(host.children[0].children[1].text, "abcdef1");
assert.equal(host.children[0].children[2].text, "next commit");
state.recentCommit = null;
vm.runInContext("paintAll()", context);
assert.equal(host.children.length, 0, "refresh removes a missing recent commit");
console.log("PASS: continuous input preserves the recent commit card; button state and refresh remain correct");

const diffButton = card.children[3].children[0];
const patch = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n";
let response = { ok: true, text: patch };
const overlays = [];
const errors = [];
context.invoke = async (channel, payload) => {
  assert.equal(channel, "git/commit-diff");
  assert.equal(payload.hash, "603f5a30000000000000000000000000000000000");
  return response;
};
context.PIG.gitView = { openDiffOverlay: (title, text) => overlays.push({ title, text }) };
context.PIG.errorText = (result) => result?.message || "Git output";
context.toast = (message, kind) => errors.push({ message, kind });
await diffButton.onclick();
assert.equal(overlays.length, 1, "successful commit diff opens the diff overlay");
assert.equal(overlays[0].text, patch, "overlay receives the API text field");
assert.ok(overlays[0].title.startsWith("603f5a3 "));
assert.equal(errors.length, 0, "success never shows Git output as an error");
response = { ok: true, text: "" };
await diffButton.onclick();
assert.equal(overlays.length, 2, "empty successful diff still opens the viewer");
assert.equal(overlays[1].text, "");
assert.equal(errors.length, 0);
response = { ok: false, message: "Unknown commit" };
await diffButton.onclick();
assert.equal(overlays.length, 2, "failure does not open a diff overlay");
assert.deepEqual(errors, [{ message: "Unknown commit", kind: "error" }]);
console.log("PASS: recent commit diff handles API text, empty diffs and errors correctly");
