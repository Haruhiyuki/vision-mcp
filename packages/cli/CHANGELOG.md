# @vision-mcp/cli

## 0.2.1

### Patch Changes

- 修复 macOS capsule.raise 报 ok 但窗口没真切前台的死锁。Swift helper 的 `window.activate` / `window.raise` 现在内部 polling 等到目标 PID 真成为 frontmost（timeout 1500ms），超时返回 `{ok: false, reason: "foreground_timeout", target_pid, frontmost_pid, hint}`。JS adapter `raiseWindow` 检查 ok=false 直接抛 `GEOMETRY_MISMATCH` 带详细诊断。`ERROR_HINTS.GEOMETRY_MISMATCH` 改写为分情况提示，明确 foreground_timeout 是焦点窃取保护、repair_minimal 救不了，让用户手动 cmd+tab 一次。
- Updated dependencies
  - @vision-mcp/core@0.2.1
  - @vision-mcp/server@0.2.1

## 0.2.0

### Minor Changes

- P0 fix: 修复 MCP SDK 1.29 把所有工具 `taskSupport` 硬编码为 `forbidden`，导致 Claude Code 等 host 把 vision-mcp 工具集对 agent / subagent 完全锁住的问题。新版本 client 看到 `taskSupport: optional`，工具立即可用。

  P1 feat: 新增 `vision_map.harvest_session` 一键沉淀——agent 跑完一串 `perform_action` 后直接调此工具自动把成功步骤串成新 workflow，不必重述 action_id / params。

  Skill 文档加 Precondition 检查：subagent 启动后必须先 `vision_map.list_apps` 验证工具可用，不可用立即停手汇报上游。

### Patch Changes

- Updated dependencies
  - @vision-mcp/core@0.2.0
  - @vision-mcp/server@0.2.0

## 0.1.1

### Patch Changes

- 修 @vision-mcp/cli 0.1.0 中 `scripts/` 目录漏打包导致 `npm install` 时 postinstall 报 `Cannot find module 'scripts/postinstall.mjs'`，整个安装失败、cli 没装上的问题。0.1.0 完全不可用，请升级到 0.1.1。
- Updated dependencies
  - @vision-mcp/core@0.1.1
  - @vision-mcp/server@0.1.1
