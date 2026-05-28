# Changelog

本文件遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 风格，版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。
0.2.0 起的版本由 [Changesets](https://github.com/changesets/changesets) 自动追加 — 开发者用 `npx changeset` 描述变更，发版时 `npx changeset version` 自动更新本文件 + 各包 `package.json`。

3 个包（`@vision-mcp/core` / `@vision-mcp/server` / `@vision-mcp/cli`）采用 **lockstep 版本**（`.changeset/config.json` 的 `fixed` 配置），三包永远同 version。

---

## [0.1.0] — 2026-05-28

首个公开发布版本。Vision-MCP 是桌面 GUI 操作的性能 / 长期成本优化层 — 把 agent 视觉操作的路径沉淀进 `vision-mcp.yaml` map，下次同任务直接命中 workflow 跳过视觉判断。

### 核心能力

- **跨平台 native helper**：macOS Swift（SCKit / AX / IOKit / Vision OCR）+ Windows PowerShell 5.1（Win32 P/Invoke / UI Automation / MSAA fallback / Windows.Media.Ocr / SendInput）
- **vision-mcp.yaml map 模型**：state / region / collection / control / workflow / patch overlay
- **MCP server**：`vision_map.*`（list_apps / list_workflows / describe_workflow / run_workflow / snapshot / commit_state / patch）+ `capsule.*`（init / move / restore / capture）共 28 个 tools + 15 个 resources
- **Claude Skill 双层暴露**：`skills/vision-mcp/SKILL.md` + 9 个 references（workflow / map-design / schema / examples / pitfalls / platform-windows / platform-macos / patches / repair-policy / safety）
- **持续修正机制**：`vision-mcp patch` 一行固化 bbox / locator / partial 偏差；trust 渐进（session_only → trusted → untrusted_proposal）
- **L0-L3 repair ladder**：locator 失败时自动 retry / re-resolve / re-snapshot / ask_user 阶梯式恢复
- **safety_policy**：destructive workflow 强制 approval_required；redaction patterns + audit_log_retention

### 包结构（npm）

| 包 | 用途 |
|---|---|
| `@vision-mcp/core` | 数据模型 / Capsule / Runtime / Repair / Locator / Trace |
| `@vision-mcp/server` | MCP server（stdio transport）|
| `@vision-mcp/cli` | `vision-mcp` bin（init / serve / capsule / snapshot / patch / install-helper / doctor 等 30+ 子命令）|

`@vision-mcp/cli` 的 `postinstall` 自动跑 `install-helper --silent` 编 / 检 native helper，跨平台 exit 0 不染红 npm install。

### 分发渠道

- **npm**：`@vision-mcp/{core,server,cli}` scope 已抢注
- **Claude Code Plugin**：`/plugin marketplace add Haruhiyuki/vision-mcp` + `/plugin install vision-mcp@vision-mcp`；plugin 自带 skill + examples + `.mcp.json`，MCP server 通过 `npx -y @vision-mcp/cli@latest serve` 拉
- **GitHub**：[Haruhiyuki/vision-mcp](https://github.com/Haruhiyuki/vision-mcp)

### 已包含示例 app

| 示例 | 平台 | 特性 |
|---|---|---|
| `examples/apple-music` | macOS | 真实库依赖 demo（首发） |
| `examples/notes` | macOS | 多 state + new note workflow |
| `examples/activity-monitor` | macOS | 进程 picker + sort |
| `examples/example-erp` | Windows（虚构） | 完整架构 demo（3 regions + 4 states + 3 workflows + 2 patches） |
| `examples/steam-windows` | Windows | CEF UIA 空壳实测 + OCR 路径 + 6 workflow（含 destructive 5-step 卸载链） |

### 平台兼容性

- macOS 12+（SCKit 要求）
- Windows 10 build 17763+（Windows.Media.Ocr 要求）/ Windows 11 主测
- Node 18 / 20 / 22
- 三平台 CI：ubuntu / macos / windows × build + typecheck + test，macos/windows 各跑 install-helper + doctor + displays RPC 端到端

### 工程基建

- Apache-2.0 license + NOTICE 三层（运行 deps / devDeps / 平台 API）+ 92 文件 SPDX header（CI 检查防回归）
- helper RPC 协议契约 test（macOS swift / Windows ps1 双端 source-level grep + snake_case / UTF-8 / Infinity 兜底检查）
- 跨平台 prepublish 脚本（纯 Node fs API，Windows 维护者也能 publish）

### 已知限制

- macOS：不创建虚拟显示器（公共 API 不可靠），用 Stable Window Capsule 把窗口固定到主屏稳定位置
- Windows：放弃 ps2exe（默认 PS host 拦 `[Console]::In` 不能做 JSON-RPC sidecar），helper 走 `.ps1` 自动 wrap `powershell.exe`，冷启动 ~400ms / 之后稳定 ~50ms RPC
- Windows.Graphics.Capture (WGC)、Windows IDD 虚拟显示驱动、prebuilt helper binaries 列入 roadmap
- CEF / Chromium-based app（Steam / Discord / VS Code）的 UIA 树只有 `Chrome_RenderWidgetHostHWND` 空壳，DOM 元素必须走 OCR + click 视觉路线

---

[0.1.0]: https://github.com/Haruhiyuki/vision-mcp/releases/tag/v0.1.0
