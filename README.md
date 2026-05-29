# Vision-MCP

为 Agent 提供的高性能桌面软件交互框架，在通过 Agent 使用桌面软件时，该框架可以在长期尺度上节约 ~93% 的 token 成本，并带来数十倍的性能提升。

Vision-MCP 使用 AX/UIA+OCR+视觉模型混合架构，智能抉择适用工具；并通过“探索-操作-沉淀-复用”的流程闭环，在 Agent 操作软件时封装日后可复用的指令列表。

包含一套开箱即用的 skill + MCP server + helper。

## 工作原理

Vision-MCP 主要做了两件事，其一是让 Agent 在流程中沉淀指令化操作方法，其二是在 Agent 理解软件操作的过程中引入混合探索架构。

### 流程沉淀

第一次要求 Agent 完成某项 GUI 操作任务时，Agent 会在开展这项工作的同时探索其操作路径上的界面结构、可点击元素、状态切换，并沉淀为 `vision-mcp.yaml`，包括每个可独立执行的 action，以及用多个 action 封装的 workflow。每个 action 和 workflow 都可以用指令触发。

Agent 通过调用工具渐进式地发现可用指令，就如同通过 MCP 使用软件一样方便。

第N次让 Agent 执行相同软件上的操作时，Agent 便会读取 action 和 workflow 并尽可能多复用。Agent 会按照优先级尝试利用现有 workflow、通过现有 action 组建新的 workflow、利用现有 action 推进至需进一步探索的状态。Agent 会在使用和探索中持续对 `vision-mcp.yaml` 进行补充优化。

### 混合探索架构

在 Agent 需要探索一款软件时，Vision-MCP 向 Agent 提供预先封装好的混合架构能力，优先使用更加高效、准确的方案对软件进行探索。对于良好支持 UIA、AX 的应用，读取其结构树。对于非原生应用，视觉模型作为永远可用的兜底方案。OCR作为介于两者之间的方案，既能够混合使用以增加准确率，也可以用于独立完成一些任务的验证。

## 快速开始

**Claude Code**：

```bash
# 在 Claude Code 内
/plugin marketplace add Haruhiyuki/vision-mcp
/plugin install vision-mcp@vision-mcp
```

**其他 MCP host**（Codex / Cursor / Cline / OpenClaw / Hermes Agent / 自建 stdio host）— 在 MCP 配置里加：

```jsonc
{
  "mcpServers": {
    "vision-mcp": {
      "command": "npx",
      "args": ["-y", "@vision-mcp/cli@latest", "serve", "--apps-root", "${HOME}/.vision-mcp/apps"]
    }
  }
}
```


各 host 具体配置文件位置 / macOS Windows 权限 / 故障排查见 [INSTALL.md](INSTALL.md)。

## 核心能力

### 平台支持

| 能力 | macOS | Windows |
| ---- | ----- | ------- |
| Helper | Swift + ScreenCaptureKit + AX + Vision + IOKit（1134 行） | PowerShell 5.1 + Win32 + UIA + System.Drawing + WinRT（1466 行） |
| 现代截图 | SCKit `SCScreenshotManager`（macOS 14+） | `PrintWindow PW_RENDERFULLCONTENT`（Win 8.1+） |
| AX 树 | AXUIElement + osascript fallback | UIA TreeWalker + **MSAA fallback** + interactive_only / skip_empty / viewport 剪枝 |
| OCR | Vision framework | **Windows.Media.Ocr** (WinRT) + `recognize_window`（PrintWindow path，屏外可用） |
| 输入 | NSPasteboard 粘贴 + CGEvent | SendInput VK_PACKET（绕过 IME 不污染剪贴板）+ modifier 支持 |
| 强制前台 | `NSWorkspace.activate` | `SwitchToThisWindow`（Alt+Tab API）+ AttachThreadInput + Alt-key 抖动 4 招兜底 |
| 健康监控 | `health.snapshot` (mach_task_basic_info) | `health.snapshot` (GetGuiResources GDI/USER) + `doctor --watch` |
| 自检 | `vision-mcp doctor` | `vision-mcp doctor` |
| 兼容性测试 | swift compile + tests | PS 5.1 / pwsh 7 检测 + OCR 语言包检测 + UIPI elevation 检测 |

详 [`platform-macos.md`](skills/vision-mcp/references/platform-macos.md) / [`platform-windows.md`](skills/vision-mcp/references/platform-windows.md)。

### MCP 工具

| 类别 | 工具 |
|------|------|
| **发现**  | `list_apps` / `list_workflows` / `describe` / `describe_workflow` / `describe_action` / `list_actions` |
| **执行**  | `run_workflow` / `perform_action` |
| **底层动作** | `click_at` / `type_text` / `press_key` / `scroll` |
| **探索 / 视觉** | `snapshot` / `annotated`（网格 + #N 候选）/ `click-text`（OCR） |
| **AX/UIA** | `ax-press`（macOS AXPress / Windows UIA InvokePattern，跨平台） |
| **持续修正** | `vision-mcp patch` 一行命令固化偏差；`patches` 列出已应用 |
| **窗口管理** | `displays` / `capsule` / `restore` / `live-view`（浏览器实时看 + 接管） |
| **诊断** | `doctor [--watch sec]`（OS / Helper / DPI / OCR 语言 / elevation / GDI leak 检测） |
| **修复** | `repair_minimal --max-level 3`（runtime L0-L3 自动 ladder） |

### vision-mcp.yaml map 抽象

- **state** — UI 页面节点；`kind: page/menu/dialog/modal/tooltip/system_modal`；多 anchor 类型（OCR/AX/visual_hash/window_title）+ `match_policy: any_anchor/all_anchors/score`
- **region** + `inherit_regions` — 跨 state 共享 UI 区域（sidebar / toolbar / **kbd 虚拟快捷键集**）
- **collection** + `enumeration` — 同质 N 元素（4×2 卡片网格 / 17 行游戏列表 / 双按钮对话框）单条声明，`<state>.<id>[N]:<action_type>` 寻址
- **multi-locator** — `accessibility → ocr_text → nearby_text → image_patch → bbox_norm → vlm` 优先级链；按 app 类型选档数（原生 4 档 / CEF 3 档纯视觉）
- **workflow** — 多步组合 + `inputs`（{{template}}）+ `timeout_ms` + step 级 `approval_required` / `on_failure: abort/ask_user/repair/skip`
- **patch overlay** — runtime 修复 / agent 主动 patch 都不破坏 baseline；trust 三级（`session_only` / `trusted` / `untrusted_proposal`）
- **parent_state_id** — modal/menu/dialog 套嵌（context_menu → submenu → confirm_dialog 链）

建 map 时按 [`map-design.md`](skills/vision-mcp/references/map-design.md) 的 **13 项 checklist** 走（漏一项 map 复用价值就少一截）。完整字段见 [`schema.md`](skills/vision-mcp/references/schema.md)。

### 安全策略

- `safety_policy.forbidden_action_categories`（payment / destructive / external_communication / permission_change / captcha）默认拒绝
- `risk_level: requires_confirmation` / `destructive` 必经审批通道
- workflow step 级 `approval_required: true` + `on_failure: abort`（destructive 失败绝不重试）
- `redaction_patterns` 自动脱敏（密码 / 信用卡 / Steam Guard / Bearer token）写入 trace 时
- 每个 action trace 含前后截图 + locator 命中 + postcondition 结果，可审计


## 协议

Apache-2.0（见 [`LICENSE`](LICENSE) + 第三方 attribution [`NOTICE`](NOTICE)）。每个源文件含 SPDX-License-Identifier header。

## 免责声明

`examples/` 下的 map（`apple-music` / `notes` / `activity-monitor` / `example-erp` / `steam-windows`）描述对应应用的公开 UI 布局，目的是演示 vision-mcp 的 map 格式与覆盖能力。这些 map **不被对应应用的厂商背书或授权**，所有商标和应用本体的版权归各厂商所有。

特别提示：

- **destructive workflow demo**（如 `steam-windows` 中的 `uninstall_first_installed_game`）仅用于**展示风险动作的 map 设计模式**（`risk_level: destructive` + `approval_required: true` + `on_failure: abort` 的组合），并不构成对实际卸载操作的鼓励或指引。任何 destructive workflow 在实际运行时**必须**经审批通道（runtime 默认 `auto_repair_before_action: false` 且 `require_user_confirmation: true`）。
- 用户使用 vision-mcp 操作第三方桌面应用应**自行确认**是否符合该应用的 ToS、相关地区法律及当事人的合理预期；vision-mcp 项目不为用户的具体使用行为承担责任。
- 涉及反作弊保护 / DRM 受保护内容 / 系统安全屏障的桌面应用（DirectX 全屏游戏、企业 EDR、UAC 高完整度 app 等），平台层会主动拒绝输入注入和截屏，请尊重这些边界。
