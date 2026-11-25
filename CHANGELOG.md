 # Changelog

## 未发布

- 新增**会话修改**：将 `new-Beginner/pi-diff-view` 固定提交 `c1d94a8`（v1.4.50）的会话子系统并入本插件。
  Agent 扩展按轮次采集明确的 Write/Edit 与单文件替换快照；回答末尾显示变更卡片，运行任务期间在输入框
  上方显示净增删浮窗；新增 `会话修改` 视图，提供统一/并排差异、行级评论与有界历史恢复。
- 不引入上游的独立本地 Git 页面；Git 操作仍使用原有 Git / Commit 视图。
- 新增 `agent.extension`、`renderer.extension`、`desktop.control` 三项权限。`desktop.control` 仅用于
  目录发现与 `agent/getStatus`、`session/get` 两项只读状态查询；不读取宿主 JSONL、review-changes、
  app.asar，不联网、无遥测。权限扩张后需通过「加载本地插件」重新授权，普通 Reload 会静默丢权限。
- 新增 `tools/build-session-diff.mjs`、`tools/check-session-runtime.mjs` 与
  `tools/session-diff-regression.mjs`；vendored 源码和运行产物随仓库固定，不依赖运行时 npm。

- 修复：仓库没有变化时，提交（变更/差异）与日志面板不再每 3.5 秒整块重画——之前每次
  心跳会拆掉重建约 2,500 个节点（含子模块时还会露出"行数不一致"的中间帧），表现为面板
  自己抖一下、鼠标下的行闪一下。现在重画前先比对状态指纹，未变化就不画；子模块状态改为
  绘制前取回，标题栏不再闪"…"；diff 内容相同时不再重建。日志与分支面板同理，相对时间
  改为每分钟刷新一次。
  （见 `.agents/notes/implemented/bug-fix/2026-11-05-idle-repaint-jitter.md`）

## 0.5.0 — 2026-11-05

- 新增**日报**：工作面板左侧的独立入口 + Git 工具窗口的 `日报` 标签页。跨项目内全部仓库汇总当天
  提交，同一提交在多个检出出现只记一条并保留全部仓库与地址；用你选定的模型一次性提炼，本地保留 90 天。
- Git 窗口的日志工具栏按钮顺序改为与提交工具栏一致（仓库 → 分支 → 刷新 → 拉取 → 推送 → 今日提交 → 储藏）。
- 一键生成 / 重新生成任意一天、复制摘要、删除历史；设置里可选模型、作者邮箱，以及把某些仓库
  排除在日报之外。
- 可选工作日定时生成（默认 17:20），作为常驻服务运行；错过的时间点直接跳过、不补发。当天没有
  提交时不调用模型、不落盘。
- 送进模型的只有提交主题与仓库名：代码块、diff hunk 与五类凭据形状在采集时即被过滤/掩码，
  磁盘上的明细同样是脱敏后的文本。
  （见 `.agents/notes/implemented/feature/2026-11-04-daily-report.md`）
## 0.4.0 — 2026-11-02

- 品牌全面升级为 **Git Master（全能 Git）**，插件 ID 更新为 `io.github.corner19.git-master`。
- 多仓库能力突破：新增多仓库一键拉取（`git/pull-all`）与故障隔离，支持子模块与平级仓库批量拉取。
- 新增独立的命令行运维工具 `tools/git-multi.mjs`，支持在终端一键 `status`、`pull`、`commit`、`push`、`sync` 批量同步管理所有仓库。
- 工具栏拉取按钮智能化：当工作区存在多个仓库或子模块时，自动触发多仓批量拉取与结果分类汇总。

## 0.3.1

- 将提交与 Git 合并为一个 Git 工作面板入口，默认上下分屏同时显示提交区与日志区。
- 支持拖动分隔条，以及单独查看提交、日志和控制台；独立窗口和兼容页面入口也使用统一布局。
- 合并版使用独立版本号，避免与旧版双入口的 0.3.0 安装包混淆。
 ## 0.3.0 — 2026-09-14

 - Git 操作补齐（对标 IDEA 日志／分支面板，见
   `.agents/notes/implemented/feature/2026-09-14-git-operations-parity.md`）：
   Branches 面板加 HEAD 行、Tags／Remotes／Stashes 组与 `/` 文件夹折叠；
   分支右键补合并／变基／改名／upstream／删除；提交右键补复制提交信息／与
   HEAD 比较；工具栏补用户／日期／路径服务端过滤、Go to HEAD 与 Fetch＋Pull
   快捷按钮；提交视图分支弹层跟随。`git/log` 支持 author／since／until／
   search／paths；新增 `git/tags`、`git/remotes`、`git/merge`、`git/rebase`、
   `git/branch-delete`、`git/branch-rename`、`git/branch-upstream`、
   `git/tag-delete`、`git/tag-push`、`git/stash-show`、`git/compare`，
   `git/fetch` 支持 `prune`。harness 198 条全绿（新增 34 条行为回归）。
 - 远端分支检出改为 IDEA 行为：`git/checkout` 加 `track` 意图位，建本地跟踪分支
   并附着 HEAD（已存在则落到本地同名分支；裸 revision 仍 detach）。
 - 生成提交信息改按已勾选／已暂存范围取 diff，多仓聚合一次描述，与实际提交一致；
   日志提交者过滤支持指定人（名单按提交数排序加手输）。harness 208 条全绿。
 

## 0.2.0 — 2026-09-12

首个对外发布版本。发布 ID 为 `io.github.corner19.git-master`
（插件数据目录按 ID 隔离，提交信息历史与视图选项从空开始）。

- 提交 / Git 双工具窗口：Staged / Unstaged / Unversioned Files /
  Merge Conflicts 分组目录树，hunk 级暂存、取消暂存与丢弃，
  图形化 Log、分支面板、储藏与 Console。
- 多仓库聚合：子模块与嵌套仓库统一显示、逐仓提交；
  Push 对话框逐仓显示去向并支持 Push All。
- 远端同步：推送被拒 / 分叉 / 冲突的分类补救说明；
  force push 只允许 `--force-with-lease`。
- 宿主模型生成提交信息：语言菜单（跟随仓库历史 / 简体中文 / English），
  回复落框前强制整形（空行、行宽、项目符号）。
- 在 PI-Desktop 0.14.6 上验证；`engines` 声明 `>= 0.8.0`。

First public release under `io.github.corner19.git-master`
(per-plugin prefs start fresh).
Commit/Git tool windows, multi-repo aggregation, classified push/pull
remedies with lease-only force push, and host-model commit-message drafting.
Verified on PI-Desktop 0.14.6.
