#!/usr/bin/env node
// Run: node tools/icon-consistency-regression.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const common = read("src/common.js");
const commit = read("src/commit-view.js");
const history = read("src/git-view.js");
const css = read("src/theme.css");
const start = common.indexOf("  const ICONS = {");
const end = common.indexOf("  /** A toolbar button", start);
assert.ok(start >= 0 && end > start);
const context = vm.createContext({
  SVG_NS: "http://www.w3.org/2000/svg",
  document: { createElementNS(_namespace, tag) {
    return { tag, attributes: {}, children: [],
      setAttribute(key, value) { this.attributes[key] = value; },
      append(child) { this.children.push(child); },
    };
  } },
});
vm.runInContext(common.slice(start, end) + "\nglobalThis.icons = ICONS; globalThis.renderIcon = icon;", context);
for (const [page, source] of [["commit", commit], ["history", history]]) {
  for (const match of source.matchAll(/\b(?:icon|iconButton|syncButton)\("([\w]+)"/g)) {
    assert.ok(context.icons[match[1]], `${page}: undefined icon ${match[1]}`);
  }
  for (const [name, action] of [["refresh", "refresh"], ["push", "push"]]) {
    assert.ok(source.includes(`syncButton("${name}", ${action === "refresh" ? 'tip("refresh", KEYS.refresh)' : `t("${action}")`}, "${action}"`), `${page}: shared ${action} icon`);
  }
  assert.ok(source.includes('syncButton("fetch", t("pull"), "pull"'), `${page}: pull directly uses fetch icon`);
  assert.doesNotMatch(source, /syncButton\("arrowDown", t\("pull"\)/, `${page}: no separate pull button`);
  assert.match(source, /class: "disclosure", "data-open"[^\n]+icon\("chevronRight", 12\)/);
  assert.match(source, /class: "row-icon"[^\n]+icon\("folder", 13\)/);
  assert.doesNotMatch(source, /icon\("chevronRight", 11\)/);
}
assert.match(commit, /icon\("diff", 13\)/);
assert.match(history, /iconButton\("diff",[^\n]+size: 13/);
for (const size of [12, 13, 16]) {
  const svg = context.renderIcon("diff", size);
  assert.equal(svg.attributes.width, String(size));
  assert.equal(svg.attributes.height, String(size));
  assert.equal(svg.attributes.class, "ui-icon");
  assert.equal(svg.attributes.stroke, "currentColor");
  assert.equal(svg.attributes["stroke-width"], "1.35");
  assert.equal(svg.attributes["stroke-linecap"], "round");
  assert.equal(svg.attributes["stroke-linejoin"], "round");
}
assert.equal(context.renderIcon("refresh").attributes.width, "16");
assert.match(css, /\.ui-icon\s*\{[^}]*flex-shrink: 0;/);
assert.match(css, /\.disclosure\s*\{[^}]*width: 12px;[^}]*flex-shrink: 0;/);
console.log("PASS: both pages use defined shared icons, matching action sizes and SVG styling");
