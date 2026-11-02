#!/usr/bin/env node
/** Run: node tools/commit-layout-regression.mjs */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../src/git-view.js", import.meta.url), "utf8");
const start = source.indexOf("    function applyMode(newMode) {");
const end = source.indexOf("    function paintTabs() {", start);
assert.ok(start >= 0 && end > start, "unified mode handler exists");
const surface = () => ({ style: {}, classList: { add() {}, remove() {} } });
const commitSurface = surface();
const prefs = new Map([["pig.commit_split_ratio", "65"]]);
const context = vm.createContext({
  mode: "split", commitSurface, splitter: surface(), logSurface: surface(),
  consoleSurface: surface(), commitView: {}, logView: {}, consoleView: {},
  localStorage: { getItem: (key) => prefs.get(key), setItem: (key, value) => prefs.set(key, value) },
  paintTabs() {},
});
vm.runInContext(source.slice(start, end), context);
for (const mode of ["split", "commit", "log", "commit", "split", "console", "commit"]) {
  vm.runInContext(`applyMode(${JSON.stringify(mode)})`, context);
  if (mode === "commit") {
    assert.equal(commitSurface.style.height, "100%", "commit fills the available height");
    assert.equal(commitSurface.style.maxHeight, "none", "commit leaves no reserved log space below");
  } else if (mode === "split") {
    assert.equal(commitSurface.style.height, "65%", "split restores the saved ratio");
    assert.equal(commitSurface.style.maxHeight, "calc(100% - 80px)", "split reserves room for the log");
  }
}
console.log("PASS: commit fills its container; split restores the log reservation across mode switches");
