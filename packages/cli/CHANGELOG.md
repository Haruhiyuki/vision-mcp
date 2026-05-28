# @vision-mcp/cli

## 0.3.0

### Minor Changes

- 实现 postcondition "信号 → AX → OCR → 视觉" 短路链。前面的能验出执行成功就不付后面的成本。

  - `waitForCondition` 按 condition 类型按需收集数据：用户配 `window_title_should_match` 只付信号成本（~5ms），配 `text_should_appear` 才付 OCR，配 `state_should_be` 才全收集（capture + OCR + AX + visual_hash）。
  - `WorkflowStep` 加 `postcondition` 字段，覆盖 control.postcondition。runtime 在 runWorkflow 时优先用 step.postcondition。
  - `harvest_session` 自动给每个 step 加 `state_should_be: <next_state>` postcondition（从 perform_action 历史记录的 state_after 推断），让沉淀出来的 workflow 复用时真做视觉/AX 验证而不只看 RPC ok。
  - `text_should_disappear` 用 `atom.min_confidence`（之前硬编码 0.6 忽略 schema 字段）。
  - `visual_diff_should_be` 默认 `max_similarity` 0.95 → 0.85（之前 5% 变化就算"变了"太宽松，弹小提示就过；现在要 15% 才认为有实质变化）。

### Patch Changes

- Updated dependencies
  - @vision-mcp/core@0.3.0
  - @vision-mcp/server@0.3.0

## 0.2.2

### Patch Changes

- 修 cli `appsRoot()` 拿到含未展开 `${VAR}` 字面值（典型如 plugin .mcp.json 用 `${CLAUDE_PLUGIN_ROOT}/examples`，但 host 没在 plugin context 下 spawn server 导致变量不展开）时，直接用字面路径让 file system 操作全数 silent fail——list_apps 返空、init 写到字面目录、perform_action 找不到 action 等连锁怪问题。现在 cli 自动检测未展开 `${...}` 并 fallback 到 `~/.vision-mcp/apps` + stderr warn 指出根因，避免静默失败。
- Updated dependencies
  - @vision-mcp/core@0.2.2
  - @vision-mcp/server@0.2.2

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
