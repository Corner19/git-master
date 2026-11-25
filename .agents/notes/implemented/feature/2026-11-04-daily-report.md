# Agent Note: 日报跨越项目内全部仓库，多仓同提交只记一条

Status: implemented

## 问题

已有的「今日提交 + 日报总结」（工具栏 ⌚）只回答「今天这个仓库里发生了什么」：它用
`readTodayCommits` 遍历 `discoverRepositories` 的结果，但把每条提交压成
`{ project, subject }` —— `project` 是仓库的 `rel`，同一个提交在两个检出里出现就记两条，
而且读不出那个仓库对应哪个远端地址。一个项目常常对应多个仓库地址（子模块、平级克隆、
同一上游的两份检出），于是「今天到底做了什么」在跨仓场景下既重复又缺地址。

另外它只覆盖「今天 00:00–24:00」，周末和补看某一天都不行，也没有保留任何本地记录：
`draftDailySummary` 返回一段文本，对话框关掉就没了。

## 决策

把日报拆成一个不依赖宿主的引擎 `lib/daily-report.js`，`main.js` 只做接线；面板加一个
`日报` 标签，与 `提交 / 日志 / 总览 / 控制台` 并列。

- **引擎与宿主解耦**：`createDailyReport({ dataDir, git, discoverRepositories, workspace,
  systemPrompt, models, complete, notify, clock })`，所有外部依赖注入。因此
  `tools/daily-report-regression.mjs` 能在纯 Node 里对着真实仓库跑完整采集与调度，不需要
  `pi`、不需要 GUI。`main.js` 已 3427 行，再往里塞采集/存储/调度只会把最大的模块变得更大。
- **多仓地址是一等数据**：逐仓库读 `git remote -v`（push 优先，没有则取第一个），
  每条提交带 `repos[]`。报告结构是 `项目 → repositories[{rel,remote,branch,commitCount}]
  → commits[{hash,subject,repos[]}]`，所以「一个项目多个地址」在设置里（勾选框旁显示地址）
  和明细里（每条提交的「所在仓库」）都看得见，而不是被折成一个数字。
- **同 sha 只算一条**：`dedupeCommits` 按提交 id 折叠，保留全部 `repos`，并把
  `stats.duplicates` 单独记下来。仓库数因此不会被两份检出灌水。
- **窗口是可配置的工作日半开区间**：`[上一工作日 HH:mm, 当日 HH:mm)`，周一回溯到周五，
  周末预览落在周五窗口。两端都用本地日历字段构造（`new Date(y, m, d, h, min)`），
  不是 `now - 24h` —— 边界是墙上时间，DST 那天减 24 小时会差一小时。
- **调度是常驻服务**：`contributes.services` 里声明 `daily-report`，`start` 里挂 30 秒轮询，
  命中配置的那一分钟才生成；`lastTriggerKey` 挡住同一分钟内的第二次 tick，磁盘上已有当日
  报告则是跨重启的第二道闸。休眠/关机错过就跳过，不补发。
- **无提交不是空报告**：`{ ok: true, empty: true }`，不调用模型、不落盘，面板直接说
  「该区间内没有提交」。这条沿用 ⌚ 对话框对空输入的处理：模型不该被问「总结什么都没有的一天」。
- **送模型的只有提交主题与仓库名**：`sanitizeText` 去掉代码块与 diff hunk，掩掉五类凭据形状
  （Bearer / key=value / 私钥块 / `ghp_` / `sk-`），并且采集时就把结果写进内存对象，
  所以落盘与送模型看到的是同一份已脱敏文本 —— 事后再过滤一遍等于有两个真相。
- **超限就拒绝，不截断**：载荷超过 60000 字符回 `REPORT_TOO_LARGE` 并说明怎么处置。
  与既有 `draftDailySummary` 的契约一致；静默截断会让「覆盖不完整」这件事消失。
- **本地 90 天**：`<dataDir>/daily-report/reports/report-YYYY-MM-DD.json`，日期先校验再拼
  路径（`parseDateKey` 拒绝 `2026-02-30` 与任何带 `/` 的输入），生成后与每次 service `start`
  时各清一次。

## 后果

- 面板多一个 `日报` 标签：左侧 90 天列表，右侧一份报告（摘要、警告、逐条提交、仓库地址、
  删除与重新生成），齿轮里是启用/时间/模型/作者/仓库勾选。它是常驻挂载、按需重画的，
  因为切标签重建会丢掉选中的那天。
- 清单多一项权限 `background.service` 与一条 `contributes.services`；版本 0.4.2 → 0.5.0。
  按 README 已记录的实测，新权限**不会**被热重载或卡片 Reload 授予，必须走
  `··· → 加载本地插件` 重选目录。
- `draftDailySummary` 的中文提示词提为模块常量 `DAILY_SUMMARY_SYSTEM`，⌚ 与日报共用一份，
  于是 `tools/daily-summary-regression.mjs` 的切片起点从函数名改成常量名（断言不变）。
- `tools/commit-layout-regression.mjs` 的桩上下文补齐 `reportSurface` / `reportView`
  与 `report` 模式：`applyMode` 现在会重置第五个面，测试照着它的真实依赖建桩。
- 仍然是「不持有 API Key、不发起网络请求、无遥测」：`delivery.status` 只有 `stored`，
  报告是本地产物。要接邮件/IM 时新增一个 `deliver` 通道即可，报告模型不用改。
- 不迁移的：会话任务证据（需要 `session.read` / `desktop.control`，与 Git 插件的权限面不符）、
  未提交改动的归属。日报只讲提交。

## Alternatives considered

- **复用 `readTodayCommits` 并扩字段**：它绑定「今天 00:00–24:00」`与单窗口，加参数就要把
  「窗口从哪来、去哪存、什么时候跑」一并塞进 `main.js`，而那是三个新职责。新建引擎模块，
  老通道一行不动，否决扩现有函数。
- **每仓库一份日报**：子模块的一天和父仓的一天被拆成两条记录，读的人要自己做加法；
  跨仓同提交还会重复计数。按项目聚合、按仓库列证据，否决按仓库拆分。
- **给 41 个 `git/*` 通道加 `repoRoot` 让日报走 `withRepo`**：日报的语义就是「整个工作区」，
  跟着 Root 选择器收窄会静默丢仓库。日报通道直接不经过 `withRepo`，否决复用当前仓。
- **超长时截断 + 标注**（原插件的做法）：目标仓已有 `REPORT_TOO_LARGE` 的拒绝契约，两套口径
  并存比一种更糟；截断后的摘要看起来完整、实际不是，最坏的一种诚实。改为拒绝，否决截断。
- **`setTimeout` 算到下一个 17:20 再执行**：长定时器跨休眠不可靠，时钟跳变、进程重启都要重算，
  而 30 秒轮询只要比较时分。轮询 + 一分钟窗口 + 当日已存在即跳过，更少状态达成同样语义，否决长定时器。
- **把凭据脱敏放在送模型前一刻**：那样磁盘上的 JSON 仍是明文，一份本地文件就成了唯一的泄露面。
  采集时脱敏一次，两处共用，否决事后过滤。
