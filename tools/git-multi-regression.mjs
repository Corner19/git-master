#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pig-multi-reg-"));
console.log(`Setting up multi-repo test environment in: ${scratch}`);

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

function runCli(args) {
  const cli = path.resolve("tools/git-multi.mjs");
  const raw = execFileSync(process.execPath, [cli, ...args], {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  return raw.replace(/\x1b\[[0-9;]*m/g, "");
}

try {
  const remotesDir = path.join(scratch, "remotes");
  const reposDir = path.join(scratch, "repos");
  fs.mkdirSync(remotesDir, { recursive: true });
  fs.mkdirSync(reposDir, { recursive: true });

  const r1 = path.join(reposDir, "repo1-normal");
  const r2 = path.join(reposDir, "repo2-detached");
  const r3 = path.join(reposDir, "repo3-noupstream");
  const r4 = path.join(reposDir, "repo4-diverged");

  // repo1: 正常仓库
  const rem1 = path.join(remotesDir, "rem1.git");
  fs.mkdirSync(rem1, { recursive: true });
  git(rem1, ["init", "--bare"]);
  fs.mkdirSync(r1, { recursive: true });
  git(r1, ["init", "-b", "main"]);
  git(r1, ["config", "user.name", "tester"]);
  git(r1, ["config", "user.email", "tester@example.com"]);
  fs.writeFileSync(path.join(r1, "file1.txt"), "v1\n");
  git(r1, ["add", "."]);
  git(r1, ["commit", "-m", "init r1"]);
  git(r1, ["remote", "add", "origin", rem1]);
  git(r1, ["push", "-u", "origin", "main"]);

  // repo2: 游离头指针 (detached HEAD)
  fs.mkdirSync(r2, { recursive: true });
  git(r2, ["init", "-b", "main"]);
  git(r2, ["config", "user.name", "tester"]);
  git(r2, ["config", "user.email", "tester@example.com"]);
  fs.writeFileSync(path.join(r2, "file2.txt"), "v1\n");
  git(r2, ["add", "."]);
  git(r2, ["commit", "-m", "r2 c1"]);
  const c1 = git(r2, ["rev-parse", "HEAD"]);
  fs.writeFileSync(path.join(r2, "file2.txt"), "v2\n");
  git(r2, ["commit", "-am", "r2 c2"]);
  git(r2, ["checkout", c1]); // 此时进入 detached HEAD

  // repo3: 本地有提交，但无 upstream 远程分支
  fs.mkdirSync(r3, { recursive: true });
  git(r3, ["init", "-b", "feature"]);
  git(r3, ["config", "user.name", "tester"]);
  git(r3, ["config", "user.email", "tester@example.com"]);
  fs.writeFileSync(path.join(r3, "file3.txt"), "v1\n");
  git(r3, ["add", "."]);
  git(r3, ["commit", "-m", "r3 init"]);

  // repo4: 产生远程与本地冲突 (diverged conflict)
  const rem4 = path.join(remotesDir, "rem4.git");
  fs.mkdirSync(rem4, { recursive: true });
  git(rem4, ["init", "--bare"]);
  fs.mkdirSync(r4, { recursive: true });
  git(r4, ["init", "-b", "main"]);
  git(r4, ["config", "user.name", "tester"]);
  git(r4, ["config", "user.email", "tester@example.com"]);
  fs.writeFileSync(path.join(r4, "conflict.txt"), "base\n");
  git(r4, ["add", "."]);
  git(r4, ["commit", "-m", "r4 base"]);
  git(r4, ["remote", "add", "origin", rem4]);
  git(r4, ["push", "-u", "origin", "main"]);

  // 在远端制造一个不兼容提交
  const tempClone = path.join(scratch, "temp4");
  git(scratch, ["clone", rem4, tempClone]);
  git(tempClone, ["config", "user.name", "remote-author"]);
  git(tempClone, ["config", "user.email", "remote@example.com"]);
  fs.writeFileSync(path.join(tempClone, "conflict.txt"), "remote change\n");
  git(tempClone, ["commit", "-am", "remote edit"]);
  git(tempClone, ["push", "origin", "main"]);

  // 本地 r4 也修改同一文件并提交，造成分叉与冲突
  fs.writeFileSync(path.join(r4, "conflict.txt"), "local change\n");
  git(r4, ["commit", "-am", "local edit"]);

  // ---------------- 测试 1: status 看板 ----------------
  console.log("Round 1.1: Testing status看板...");
  const statusOut = runCli(["status", reposDir]);
  assert.ok(statusOut.includes("repo1-normal"), "lists repo1");
  assert.ok(statusOut.includes("repo2-detached"), "lists repo2");
  assert.ok(statusOut.includes("repo3-noupstream"), "lists repo3");
  assert.ok(statusOut.includes("repo4-diverged"), "lists repo4");
  assert.ok(statusOut.includes("无远程追踪分支"), "detects no upstream on repo3");

  // ---------------- 测试 2: commit 批量提交 ----------------
  console.log("Round 1.2: Testing commit批量提交...");
  // 制造改动：在 repo1 修改一个文件，repo3 保持干净
  fs.writeFileSync(path.join(r1, "file1.txt"), "v2 modified\n");
  const commitOut = runCli(["commit", reposDir, "-m", "feat: batch update files"]);
  assert.ok(commitOut.includes("提交 repo1-normal ... 提交成功"), "repo1 committed");
  assert.ok(commitOut.includes("无修改跳过: 3"), "other 3 repos skipped without modification");

  // ---------------- 测试 3: pull 批量拉取与故障隔离 ----------------
  console.log("Round 1.3: Testing pull批量拉取与单仓故障隔离...");
  // 给 repo1 远端塞一个新提交
  const temp1 = path.join(scratch, "temp1");
  git(scratch, ["clone", rem1, temp1]);
  git(temp1, ["config", "user.name", "colleague"]);
  git(temp1, ["config", "user.email", "colleague@example.com"]);
  fs.writeFileSync(path.join(temp1, "new_from_remote.txt"), "hello\n");
  git(temp1, ["add", "."]);
  git(temp1, ["commit", "-m", "colleague commit"]);
  git(temp1, ["push", "origin", "main"]);

  const pullOut = runCli(["pull", reposDir]);
  assert.ok(pullOut.includes("repo1-normal (main) ... 拉取成功"), "repo1 pulled successfully");
  assert.ok(pullOut.includes("repo2-detached (UNKNOWN) ... 跳过 (Detached HEAD)") || pullOut.includes("跳过 (Detached HEAD)"), "repo2 safely skipped");
  assert.ok(pullOut.includes("repo3-noupstream (feature) ... 跳过 (未关联远程分支)"), "repo3 safely skipped");
  assert.ok(pullOut.includes("repo4-diverged (main) ... 失败:"), "repo4 reported failure due to conflict");
  assert.ok(fs.existsSync(path.join(r1, "new_from_remote.txt")), "file pulled into repo1");
  // ---------------- 测试 4: push 批量推送 ----------------
  console.log("Round 1.4: Testing push批量推送...");
  const pushOut = runCli(["push", reposDir]);
  assert.ok(pushOut.includes("推送 repo1-normal (main) ... 推送成功"), "repo1 pushed");

  console.log("PASS: Round 1 (CLI edge cases, isolation, status, commit, pull, push)");
  console.log("PASS: Round 1 (CLI edge cases, isolation, status, commit, pull)");
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
