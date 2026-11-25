# 上游源码快照

本目录保存 `https://github.com/new-Beginner/pi-diff-view` 的固定提交：

- commit: `c1d94a8f8fe55b152ead69ba108dd4ded44a89ca`
- version: `1.4.50`
- license: MIT（见 `LICENSE`、`THIRD_PARTY_NOTICES.md`、`licenses/`）

只迁移会话修改能力；源仓库的独立本地 Git 页面不进入本项目。构建与集成所需的适配如下：

- `src/main.ts`：移除 `diff-view.open` 命令与 `gitManage` 分发；`openPanel` 改为 `pi.ui.revealView({ viewId: "session" })`；将构建产物所在的 `lib/session-diff` 映射回插件根目录，保证 Agent 采集器与主进程 locator 使用同一根目录。
- `src/agent/capture.ts`：默认 `pluginRoot` 指向插件根目录；采集降级提示改为 Git Master 文案。
- `src/renderer/plugin-review-adapter.ts`：工作面板页签与 launcher DOM 标识改为 `io.github.corner19.git-master/session`。
- `src/view/index.tsx`：移除“本地 Git”页签与 `GitWorkspace`，只保留会话修改。
- `src/view/ReviewApp.tsx`：无会话标识时不再回退到 Git scope。
- 测试适配：`plugin-review-adapter` 使用本插件 launcher 标识；`application-performance` 改为验证会话面不暴露
  `gitManage`；`capture-maintenance-entry` 读取本插件 `manifest.json`。其余上游测试保留原样。

源码快照是构建输入；运行时产物见 `lib/session-diff/` 与 `views/session.html`。
