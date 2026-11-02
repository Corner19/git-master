#!/usr/bin/env node
/**
 * tools/git-multi.mjs
 * 多 Git 仓库一键批量管理脚本 (Node.js 原生零依赖)
 *
 * 用法:
 *   node tools/git-multi.mjs status [目录]
 *   node tools/git-multi.mjs pull [目录]
 *   node tools/git-multi.mjs commit [目录] -m "提交说明"
 *   node tools/git-multi.mjs push [目录]
 *   node tools/git-multi.mjs sync [目录] -m "提交说明"
 */

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const BLUE = "\x1b[34m";
const CYAN = "\x1b[36m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "dist-publish", "build",
  "coverage", ".cache", ".idea", ".vscode", "vendor"
]);

function scanGitRepos(root, depth = 0, maxDepth = 4) {
  if (depth > maxDepth) return [];
  const repos = [];
  try {
    const entries = fs.readdirSync(root, { withFileTypes: true });
    if (entries.some((e) => e.name === ".git")) {
      return [root];
    }
    for (const e of entries) {
      if (e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) {
        repos.push(...scanGitRepos(path.join(root, e.name), depth + 1, maxDepth));
      }
    }
  } catch {
    // 忽略权限受限目录
  }
  return repos.sort();
}

async function runGit(args, cwd) {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      timeout: 120000,
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_MERGE_AUTOEDIT: "no" },
    });
    return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (err) {
    return {
      ok: false,
      stdout: (err.stdout ?? "").toString().trim(),
      stderr: (err.stderr ?? "").toString().trim(),
      message: err.message,
    };
  }
}

async function inspectRepo(repo) {
  const name = path.basename(repo);
  const branchRes = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], repo);
  const branch = branchRes.ok ? branchRes.stdout : "UNKNOWN";

  const statusRes = await runGit(["status", "--porcelain"], repo);
  const isDirty = Boolean(statusRes.stdout);

  let ahead = 0;
  let behind = 0;
  const upstreamRes = await runGit(["rev-parse", "--abbrev-ref", "@{upstream}"], repo);
  const hasUpstream = upstreamRes.ok;

  if (hasUpstream) {
    const countRes = await runGit(["rev-list", "--left-right", "--count", "HEAD...@{upstream}"], repo);
    if (countRes.ok) {
      const parts = countRes.stdout.split(/\s+/);
      if (parts.length === 2) {
        ahead = parseInt(parts[0], 10) || 0;
        behind = parseInt(parts[1], 10) || 0;
      }
    }
  }

  return { path: repo, name, branch, isDirty, ahead, behind, hasUpstream };
}

// ------------------------------ 子命令实现 ------------------------------

async function handleStatus(repos) {
  console.log(`\n${BOLD}${"=".repeat(85)}${RESET}`);
  console.log(`${BOLD}${"多仓库状态看板".padStart(45)}${RESET}`);
  console.log(`${BOLD}${"=".repeat(85)}${RESET}`);
  console.log(`${BOLD}${"仓库名称".padEnd(25)} | ${"当前分支".padEnd(16)} | ${"工作区状态".padEnd(12)} | 同步状态${RESET}`);
  console.log("-".repeat(85));

  for (const repo of repos) {
    const info = await inspectRepo(repo);
    const dirtyStr = info.isDirty ? `${YELLOW}有未提交修改${RESET}` : `${GREEN}工作区干净${RESET}`;
    const syncParts = [];
    if (!info.hasUpstream) {
      syncParts.append ? syncParts.append() : syncParts.push(`${YELLOW}无远程追踪分支${RESET}`);
    } else {
      if (info.ahead > 0) syncParts.push(`${CYAN}待推 ↑${info.ahead}${RESET}`);
      if (info.behind > 0) syncParts.push(`${RED}待拉 ↓${info.behind}${RESET}`);
      if (info.ahead === 0 && info.behind === 0) syncParts.push(`${GREEN}已与远端同步${RESET}`);
    }
    console.log(`${info.name.padEnd(25)} | ${info.branch.padEnd(16)} | ${dirtyStr.padEnd(21)} | ${syncParts.join(", ")}`);
  }
  console.log(`${BOLD}${"=".repeat(85)}${RESET}\n`);
}

async function handlePull(repos) {
  console.log(`\n${BOLD}🚀 开始一键拉取所有项目 (共 ${repos.length} 个)...${RESET}\n`);
  let success = 0;
  let upToDate = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < repos.length; i++) {
    const repo = repos[i];
    const info = await inspectRepo(repo);
    process.stdout.write(`[${i + 1}/${repos.length}] ${info.name} (${info.branch}) ... `);

    if (info.branch === "HEAD") {
      console.log(`${YELLOW}跳过 (Detached HEAD)${RESET}`);
      skipped++;
      continue;
    }
    if (!info.hasUpstream) {
      console.log(`${YELLOW}跳过 (未关联远程分支)${RESET}`);
      skipped++;
      continue;
    }

    let pullRes = await runGit(["pull"], repo);
    if (!pullRes.ok && /Need to specify how to reconcile/i.test(`${pullRes.stdout}\n${pullRes.stderr}`)) {
      pullRes = await runGit(["pull", "--no-rebase", "--no-edit"], repo);
    }

    if (pullRes.ok) {
      if (pullRes.stdout.includes("Already up to date") || pullRes.stdout.includes("已经是最新的")) {
        console.log(`${BLUE}已经是最新${RESET}`);
        upToDate++;
      } else {
        console.log(`${GREEN}拉取成功 ✓${RESET}`);
        success++;
      }
    } else {
      const errLine = (pullRes.stderr || pullRes.stdout).split("\n").pop() || "拉取失败";
      console.log(`${RED}失败: ${errLine}${RESET}`);
      failed++;
    }
  }

  console.log(`\n拉取统计: 总计 ${repos.length} | ${GREEN}更新: ${success}${RESET} | ${BLUE}最新: ${upToDate}${RESET} | ${YELLOW}跳过: ${skipped}${RESET} | ${RED}失败: ${failed}${RESET}\n`);
}

async function handleCommit(repos, message) {
  console.log(`\n${BOLD}📦 开始一键批量提交代码...${RESET}`);
  console.log(`提交信息: ${CYAN}"${message}"${RESET}\n`);
  let committed = 0;
  let failed = 0;

  for (let i = 0; i < repos.length; i++) {
    const repo = repos[i];
    const info = await inspectRepo(repo);
    if (!info.isDirty) continue;

    process.stdout.write(`[${i + 1}/${repos.length}] 提交 ${info.name} ... `);
    const addRes = await runGit(["add", "-A"], repo);
    if (!addRes.ok) {
      console.log(`${RED}git add 失败${RESET}`);
      failed++;
      continue;
    }

    const commitRes = await runGit(["commit", "-m", message], repo);
    if (commitRes.ok) {
      console.log(`${GREEN}提交成功 ✓${RESET}`);
      committed++;
    } else {
      const errLine = (commitRes.stderr || commitRes.stdout).split("\n").pop() || "提交失败";
      console.log(`${RED}提交失败: ${errLine}${RESET}`);
      failed++;
    }
  }

  console.log(`\n提交统计: ${GREEN}已提交仓库: ${committed}${RESET} | 无修改跳过: ${repos.length - committed - failed} | ${RED}失败: ${failed}${RESET}\n`);
}

async function handlePush(repos) {
  console.log(`\n${BOLD}⬆️  开始一键推送所有仓库...${RESET}\n`);
  let pushed = 0;
  let failed = 0;

  for (let i = 0; i < repos.length; i++) {
    const repo = repos[i];
    const info = await inspectRepo(repo);
    if (info.ahead === 0 && info.hasUpstream) continue;

    process.stdout.write(`[${i + 1}/${repos.length}] 推送 ${info.name} (${info.branch}) ... `);
    let pushRes;
    if (!info.hasUpstream) {
      pushRes = await runGit(["push", "-u", "origin", info.branch], repo);
    } else {
      pushRes = await runGit(["push"], repo);
    }

    if (pushRes.ok) {
      console.log(`${GREEN}推送成功 ✓${RESET}`);
      pushed++;
    } else {
      const errLine = (pushRes.stderr || pushRes.stdout).split("\n").pop() || "推送失败";
      console.log(`${RED}推送失败: ${errLine}${RESET}`);
      failed++;
    }
  }

  console.log(`\n推送统计: ${GREEN}成功推送: ${pushed}${RESET} | 无需推送: ${repos.length - pushed - failed} | ${RED}失败: ${failed}${RESET}\n`);
}

async function main() {
  const args = process.argv.slice(2);
  const action = args[0];

  if (!action || !["status", "pull", "commit", "push", "sync"].includes(action)) {
    console.log(`
${BOLD}多 Git 仓库一键批量管理工具${RESET}

用法:
  node tools/git-multi.mjs <action> [目标目录] [选项]

可用操作:
  status   查看所有仓库的状态大盘 (分支/修改/待推待拉)
  pull     一键拉取所有仓库最新代码
  commit   一键暂存并提交所有有修改的仓库 (需指定 -m "说明")
  push     一键推送所有仓库的本地提交
  sync     一键全流程同步 (Pull -> 自动提交 -> Push)

参数选项:
  -m, --message <msg>   commit / sync 的提交信息 (默认: "chore: batch update")

示例:
  node tools/git-multi.mjs status /Users/me/projects
  node tools/git-multi.mjs pull /Users/me/projects
  node tools/git-multi.mjs commit /Users/me/projects -m "fix: 同步公共配置"
  node tools/git-multi.mjs sync /Users/me/projects -m "chore: 每日自动同步"
`);
    process.exit(1);
  }

  let dirArg = ".";
  let message = "chore: batch update";

  for (let i = 1; i < args.length; i++) {
    if (args[i] === "-m" || args[i] === "--message") {
      message = args[i + 1] || message;
      i++;
    } else if (!args[i].startsWith("-")) {
      dirArg = args[i];
    }
  }

  const targetDir = path.resolve(dirArg);
  const repos = scanGitRepos(targetDir);

  if (repos.length === 0) {
    console.log(`${YELLOW}未在指定路径下检测到任何 Git 仓库: ${targetDir}${RESET}`);
    return;
  }

  console.log(`🔍 扫描路径: ${targetDir} (共发现 ${repos.length} 个 Git 仓库)`);

  if (action === "status") {
    await handleStatus(repos);
  } else if (action === "pull") {
    await handlePull(repos);
  } else if (action === "commit") {
    await handleCommit(repos, message);
  } else if (action === "push") {
    await handlePush(repos);
  } else if (action === "sync") {
    await handlePull(repos);
    await handleCommit(repos, message);
    await handlePush(repos);
  }
}

main().catch((err) => {
  console.error("执行异常:", err);
  process.exit(1);
});
