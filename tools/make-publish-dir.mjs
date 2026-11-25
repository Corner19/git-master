#!/usr/bin/env node
/**
 * Assemble a clean publish directory with only the files PI-Desktop needs
 * at runtime.
 *
 * `PluginPack` ships everything under the packed directory except `.git`
 * (it does not read `.gitignore`, and there is no exclude file — verified
 * 2026-09-12: packing the repo root produced a 2.1 MB / 46-file archive
 * containing `.smoke/`, `.memories/`, `tools/`, `src/` and friends).
 * So releases are packed from the directory this script builds, never from
 * the repo root:
 *
 *   node tools/build.mjs && node tools/make-publish-dir.mjs
 *   # then PluginCheck + PluginPack on dist-publish/<plugin-id>/
 */

import { cpSync, copyFileSync, mkdirSync, readFileSync, rmSync, statSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));

const RUNTIME_FILES = [
  "manifest.json",
  "main.js",
  // Required by `main.js` at load time: the report engine is a separate file, and
  // an archive without it fails with "Cannot find module" the moment the plugin
  // is loaded — the whole reason this list exists.
  "lib/daily-report.js",
  // Session-diff runtime: main-process backend, Agent capture extension,
  // renderer-slot module and the self-contained review view.
  "lib/session-diff/main.cjs",
  "lib/session-diff/agent.mjs",
  "lib/session-diff/renderer.mjs",
  "views/commit.html",
  "views/git.html",
  "views/report.html",
  "views/session.html",
  "renderer/index.html",
  "README.md",
  "LICENSE",
  "CHANGELOG.md",
];
const RUNTIME_COPIES = [
  { from: "vendor/pi-diff-view/LICENSE", to: "licenses/pi-diff-view-LICENSE" },
  { from: "vendor/pi-diff-view/THIRD_PARTY_NOTICES.md", to: "licenses/pi-diff-view-THIRD_PARTY_NOTICES.md" },
  { from: "vendor/pi-diff-view/licenses", to: "licenses" },
];
const COPIES = [
  ...RUNTIME_FILES.map(file => ({ from: file, to: file })),
  ...RUNTIME_COPIES,
];

function fileCount(directory) {
  return readdirSync(directory, { withFileTypes: true }).reduce((sum, entry) => {
    if (!entry.isDirectory()) return sum + 1;
    return sum + fileCount(join(directory, entry.name));
  }, 0);
}

const out = join(root, "dist-publish", manifest.id);
rmSync(out, { recursive: true, force: true });

let total = 0;
let stagedFiles = 0;
for (const copy of COPIES) {
  const src = join(root, copy.from);
  const dest = join(out, copy.to);
  mkdirSync(dirname(dest), { recursive: true });
  if (statSync(src).isDirectory()) {
    cpSync(src, dest, { recursive: true });
    stagedFiles += fileCount(dest);
  } else {
    copyFileSync(src, dest);
    stagedFiles += 1;
  }
  total = 0;
  for (const file of walk(out)) total += statSync(file).size;
  process.stdout.write(`staged ${copy.to}\n`);
}
process.stdout.write(`publish dir: ${out} (${stagedFiles} files, ${(total / 1024).toFixed(1)} KB)\n`);

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const full = join(directory, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

const installedDir = join(process.env.HOME || "", ".pi-desktop", "plugins", "installed", manifest.id);
try {
  if (statSync(installedDir).isDirectory()) {
    for (const copy of COPIES) {
      const src = join(out, copy.to);
      const dest = join(installedDir, copy.to);
      mkdirSync(dirname(dest), { recursive: true });
      if (statSync(src).isDirectory()) cpSync(src, dest, { recursive: true });
      else copyFileSync(src, dest);
    }
    process.stdout.write(`synced to local installed plugin: ${installedDir}\n`);
  }
} catch {}
