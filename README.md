# Vision-MCP

> **桌面 GUI 操作的性能 / 长期成本优化层** — 把 agent 视觉操作的路径（截图、坐标、AX/OCR、点击序列）沉淀进 `vision-mcp.yaml` map，下次同任务直接 `run_workflow` 命中，跳过视觉判断。**第一次跑成本与 Computer Use 相当；第二次起每次都摊销**。
>
> macOS 与 Windows 双平台一等支持，跨平台同接口；MCP server + Claude Skill 双层暴露。

## 它解决什么问题

agent 用 "computer use" 方案（Anthropic Computer Use / OpenAI Operator / 截图脚本）已经能视觉操作桌面，但**每次重复任务都从零看图、估坐标、试错** — 一周后第十次跑同样的「在 Steam 卸载 X」，仍然是分钟级 + 大量截图进 context。

Vision-MCP **不替代** Computer Use，是 amortize 那笔成本的复用层：

1. **路径沉淀为 map**：第一次跑通时把发现的 state / region / control / workflow 写入 `vision-mcp.yaml`；后续任务用 `action_id` 直接命中，不再视觉判断
2. **持续修正**：实战中遇 map 偏差时 `vision-mcp patch` 一行命令固化修正；map 越用越准
3. **ROI 适用前提**：任务**重复或可能重复**才有沉淀价值；纯一次性任务直接 Computer Use 即可

| 维度 | Computer Use | Vision-MCP |
|------|-------------|------------|
| 每次任务的视觉成本 | 高（全程视觉判断） | 高 → 低（第一次探索，第二次起命中 map） |
| 操作沉淀 | 无 | `vision-mcp.yaml` + trusted patches |
| 工作模式 | 模型直接看图给坐标 | 任务驱动 ⭐（路径上混合）+ 探索驱动（系统建图） |
| MCP 兼容 | 否（模型 tool 协议） | 是（任何 stdio MCP host） |
| 适合场景 | 一次性、临时任务 | 重复工作流、企业自动化、跨任务复用 |

两者**互补**：探索期 / 偏差排查时仍然要看图；沉淀后用 vision-mcp 高效执行。

## 30 秒上手（Claude Code Plugin）

```bash
# 在 Claude Code 内
/plugin marketplace add Haruhiyuki/vision-mcp
/plugin install vision-mcp@vision-mcp
# Plugin 自带 skill + 示例 map + .mcp.json；MCP server 通过 npx 拉 @vision-mcp/cli
# npm 包的 postinstall 自动跑 install-helper（macOS swiftc 编译 / Windows 自检 PowerShell 5.1）
# 首次使用时授权 Screen Recording + Accessibility（macOS） / OCR 语言包（Windows，按需）
```

Plugin 自包含 `.claude-plugin/plugin.json` + `.mcp.json` + `skills/vision-mcp/` + `examples/`。安装后 agent 立刻能用 `vision_map.*` 工具 + skill 操作手册。

其他 host（Codex CLI / Cursor / Cline / OpenClaw）配置见 [INSTALL.md](INSTALL.md)。

## Agent 调用流程（像 list_tools → call_tool 一样渐进）

```
1. vision_map.list_apps                  → 看现有 map：app metadata + workflows 摘要
2. vision_map.list_workflows app_id      → 选 workflow（destructive 标识自动推断）
3. vision_map.describe_workflow ...      → 看步骤 + risk_level（destructive 必看）
4. vision_map.run_workflow ...           → 执行；命中即免看图
   ↓ 失败 / 没现成 workflow ↓
5. vision_map.snapshot + describe_action → 看现状
6. vision-mcp patch ...                  → 一行固化偏差，下次命中
```

资源版（按 URI fetch）：`vision-mcp://apps` / `apps/{id}/summary` / `apps/{id}/workflows` — 比拉全 yaml 节省 ~85% context。

## 核心能力

### 平台支持（双平台一等）

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

### MCP 工具（28 个，全部带 description 含 ERROR_HINTS 引导）

| 类别 | 工具 |
|------|------|
| **发现** ⭐ | `list_apps` / `list_workflows` / `describe` / `describe_workflow` / `describe_action` / `list_actions` |
| **执行** ⭐ | `run_workflow` / `perform_action` |
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

## Examples（4 个实战 map）

| App | 平台 | 演示什么 |
|-----|------|---------|
| [`apple-music`](examples/apple-music/) | macOS | region (sidebar/playbar/search_bar) + collection (4×2 result_card) + 双轨 locator |
| [`notes`](examples/notes/) | macOS | SwiftUI 自绘 + kbd region + type 优先（click 丢焦点的反例） |
| [`activity-monitor`](examples/activity-monitor/) | macOS | table view + 列排序 |
| [`example-erp`](examples/example-erp/) | Windows（hypothetical） | 完整架构 demo：accessibility locator + image_patch + automation_id + 5 状态链 |
| [`steam-windows`](examples/steam-windows/) ⭐ | Windows + CEF | **CEF/Chromium app 无 UIA 的纯视觉路线**：504 行，含 region (top_nav/kbd) + collection × 3 + 4 层 menu/dialog 套嵌 + destructive workflow + redaction_patterns |

## 完成度

| 模块 | 状态 | 文件 |
|------|------|------|
| Schema + Map IO + Patch overlay | ✅ | `packages/core/src/{schema,map}/` |
| Capsule Manager / Geometry Contract / Input Lease | ✅ | `packages/core/src/capsule/` |
| Runtime Executor + postcondition + audit trace | ✅ | `packages/core/src/runtime/` |
| Locator 6 类（AX / OCR / nearby_text / image_patch / bbox_norm / VLM） | ✅ | `packages/core/src/locator/` |
| Repair Engine L0–L3 + patch overlay | ✅ | `packages/core/src/repair/` |
| MCP Server（28 tools + 15 resources，含 summary 层） | ✅ | `packages/server/` |
| CLI（init / build / explore / record / discover / capsule / patch / install-helper / doctor / live-view / ...） | ✅ | `packages/cli/src/cli.ts`（2757 行） |
| macOS native helper（Swift + SCKit + AX + Vision + IOKit + health.snapshot） | ✅ 1134 行 | `native/macos/src/main.swift` |
| Windows native helper（PS5.1 + Win32 + UIA + MSAA + Windows.Media.Ocr + SwitchToThisWindow + health.snapshot） | ✅ 1466 行 | `native/windows/src/vision-mcp-helper.ps1` |
| Claude Code Plugin（含 `.mcp.json` + `skills/`） | ✅ | `.claude-plugin/`, `.mcp.json` |
| 协议契约测试（macOS ↔ Windows helper RPC drift） | ✅ | `packages/core/tests/helper-protocol.test.ts` |
| CI（Windows + macOS + Ubuntu × Node 20/22） | ✅ | `.github/workflows/ci.yml` |
| 测试 | ✅ 53 pass | `packages/*/tests/*.test.ts` |

**不在 MVP 范围**：

- 系统级虚拟显示器（macOS public API 不支持；Windows IDD 需驱动签名 + 企业部署）
- 反作弊 / DirectX 全屏游戏（系统层限制 PrintWindow + SendInput）
- WGC (Windows.Graphics.Capture)（比 PrintWindow 快 5-10× 能抓 DirectX，但需 C# / Rust 编译 WinRT 绑定）
- Cloud VLM 默认 disabled（`safety_policy.allow_cloud_vlm: false`）
- PS2EXE 编 .exe helper（已验证 PSHost 拦 stdio，不可用；roadmap dotnet AOT launcher）

## 仓库结构

```
vision-mcp/
├── packages/                       # TypeScript monorepo
│   ├── core/                       # 数据模型 / Capsule / Runtime / Repair / Locator / Trace
│   ├── server/                     # MCP server: tools + resources + stdio
│   └── cli/                        # vision-mcp CLI
├── native/                         # Native helper 源码（npm publish 时复制进 cli 包）
│   ├── macos/src/main.swift        # 1134 行
│   └── windows/src/vision-mcp-helper.ps1   # 1466 行
├── examples/                       # 项目自带参考 maps（入 git）
│   ├── apple-music/                # macOS: region + collection + 双轨 locator
│   ├── notes/                      # macOS: SwiftUI 自绘 + kbd region
│   ├── activity-monitor/           # macOS: table view
│   ├── example-erp/                # 虚构 Windows ERP（架构完整 demo）
│   └── steam-windows/              # ⭐ Windows + CEF 实战（无 UIA 纯视觉）
├── skills/vision-mcp/              # Claude Skill：agent 操作手册
│   ├── SKILL.md                    # 唯一 agent 入口（183 行；含 frontmatter）
│   ├── references/                 # 按需深入
│   │   ├── workflow.md             # 任务驱动 vs 探索决策树
│   │   ├── map-design.md           # ⭐ 13 项 checklist
│   │   ├── examples.md             # ⭐ 实战示例（Apple Music / Steam / 纯视觉 / patch）
│   │   ├── pitfalls.md             # ⭐ 11 个真实坑
│   │   ├── schema.md / patches.md / repair-policy.md / safety.md
│   │   └── platform-{macos,windows}.md
│   └── assets/                     # JSON Schema + 审阅模板
├── docs/                           # deployment / errors / permissions / acceptance
├── .github/workflows/ci.yml        # 三平台 × 双 Node 版本 CI
├── .claude-plugin/plugin.json      # Claude Code Plugin manifest
├── .mcp.json                       # Plugin 自带的 MCP server 配置
└── apps/                           # 用户工作区（VISION_MCP_APPS_ROOT 默认，.gitignore）
```

## 文档导览

### Agent 用（plugin / host 自动加载）

- ⭐ **[`skills/vision-mcp/SKILL.md`](skills/vision-mcp/SKILL.md)** — 唯一 agent 入口，含 frontmatter `when_to_use` + 跨平台速查 + 核心原则
- [`references/workflow.md`](skills/vision-mcp/references/workflow.md) — 任务驱动 vs 探索决策树 + 4 时机 snapshot + 反模式
- [`references/map-design.md`](skills/vision-mcp/references/map-design.md) — 建 map 13 项 checklist（region / kbd / collection / postcondition / risk_level / 套嵌）
- [`references/examples.md`](skills/vision-mcp/references/examples.md) — 实战示例（Apple Music / Steam / 纯视觉 / patch 实战例）
- [`references/pitfalls.md`](skills/vision-mcp/references/pitfalls.md) — 11 个真实坑（焦点 / 中文输入 / CEF / Steam 最小窗口 / destructive）
- [`references/schema.md`](skills/vision-mcp/references/schema.md) — yaml 字段速查 + 跨平台 locator 链选择
- [`references/patches.md`](skills/vision-mcp/references/patches.md) — 持续修正：4 种 patch 类型 / trust 升级
- [`references/repair-policy.md`](skills/vision-mcp/references/repair-policy.md) — L0–L3 ladder + 平台差异
- [`references/safety.md`](skills/vision-mcp/references/safety.md) — 高风险动作 / prompt injection 防护
- [`references/platform-macos.md`](skills/vision-mcp/references/platform-macos.md) — macOS 适配器 / SCKit / AX-press / Vision OCR
- [`references/platform-windows.md`](skills/vision-mcp/references/platform-windows.md) — Windows 适配器 / UIA + MSAA / Windows.Media.Ocr / SwitchToThisWindow

### 人类用

- **[`INSTALL.md`](INSTALL.md)** — 三种分发路径（Plugin / npm / 源码）+ 各 host 配置示例
- [`docs/errors.md`](docs/errors.md) — 错误码 + recoverable 标志
- [`docs/permissions.md`](docs/permissions.md) — Windows / macOS 权限清单
- [`native/windows/README.md`](native/windows/README.md) — Windows helper 详（SmartScreen / 企业 GPO / UWP-MSIX 适配）
- [`vision_mcp_windows_macos_design.md`](vision_mcp_windows_macos_design.md) — 设计文档（架构 + 平台决策）

## FAQ

**Q：为什么不直接用 Anthropic Computer Use？**
A：Computer Use 是模型协议（Claude 输出 click 坐标，调用方实现 click），每次任务都是 full vision 成本，**不沉淀**操作路径。vision-mcp 是 MCP server 路径，跟模型无关；产物是可复用的 map，第二次起命中成本递减。两者互补——探索期 / 偏差排查仍要视觉判断，沉淀后用 vision-mcp 高效执行。

**Q：为什么自己实现 native helper 不用 nut.js / robotgo？**
A：这些通用库的中文输入 / AX 树 dump / 现代截图 API 支持都不够稳。我们在 macOS 用 NSPasteboard 粘贴 + SCKit window capture（能抓部分屏外窗口）+ Vision OCR；Windows 用 SendInput VK_PACKET（绕过 IME）+ PrintWindow + UIA + MSAA fallback + Windows.Media.Ocr —— 桌面 agent 最常踩的坑，自己实现保证质量。

**Q：CEF / Chromium app（Steam / Discord / VS Code / Edge）能用吗？**
A：能。UIA 只看到 `Chrome_RenderWidgetHostHWND` 空壳，但 vision-mcp 自动走 OCR + bbox 路线（`click-text` 在 Windows 走 PrintWindow OCR，屏外 / 后台窗口也能用）；map 写 `ocr_text → bbox_norm` 不写 `accessibility`。完整 demo 见 [`examples/steam-windows`](examples/steam-windows/)。

**Q：跑 `npm install -g @vision-mcp/cli` 后报 "swiftc 编译失败" 或 Windows 没装 PowerShell 5.1？**
A：跑 `vision-mcp doctor` 一次看诊断。macOS：`xcode-select --install` 装 Command Line Tools 后 `vision-mcp install-helper --force`。Windows：PowerShell 5.1 是系统默认，doctor 会指出是否被 PATH 把 powershell 解析到了 pwsh 7。

**Q：agent 跑 workflow 失败说 `CAPSULE_PLATFORM_UNAVAILABLE` / `INPUT_LEASE_DENIED` / `ACTION_NOT_FOUND`？**
A：所有错误码都自带 ERROR_HINTS 提示下一步：
- `CAPSULE_PLATFORM_UNAVAILABLE` → 跑 `vision-mcp install-helper` / `doctor`
- `INPUT_LEASE_DENIED` → Windows UIPI 拒输入；vision-mcp 进程需 elevated
- `ACTION_NOT_FOUND` → 用 `vision_map.list_actions` 查可用 action_id
完整列表见 [`docs/errors.md`](docs/errors.md)。

**Q：Windows helper 为什么不编译成 .exe？**
A：试过。PS2EXE 默认 PSHost 拦截 `[Console]::In`，`-noConsole` 又编成 GUI 子系统没 stdio —— stdio JSON-RPC sidecar 不可用。当前走 `.ps1 + powershell.exe -File`，首次 RPC 冷启动 ~400ms 之后 warm ~20-300ms，对长寿命 sidecar 够用。roadmap：dotnet AOT launcher 包 powershell.exe。

## 协议

Apache-2.0（见 [`LICENSE`](LICENSE) + 第三方 attribution [`NOTICE`](NOTICE)）。每个源文件含 SPDX-License-Identifier header。

## 免责声明

`examples/` 下的 map（`apple-music` / `notes` / `activity-monitor` / `example-erp` / `steam-windows`）描述对应应用的公开 UI 布局，目的是演示 vision-mcp 的 map 格式与覆盖能力。这些 map **不被对应应用的厂商背书或授权**，所有商标和应用本体的版权归各厂商所有。

特别提示：

- **destructive workflow demo**（如 `steam-windows` 中的 `uninstall_first_installed_game`）仅用于**展示风险动作的 map 设计模式**（`risk_level: destructive` + `approval_required: true` + `on_failure: abort` 的组合），并不构成对实际卸载操作的鼓励或指引。任何 destructive workflow 在实际运行时**必须**经审批通道（runtime 默认 `auto_repair_before_action: false` 且 `require_user_confirmation: true`）。
- 用户使用 vision-mcp 操作第三方桌面应用应**自行确认**是否符合该应用的 ToS、相关地区法律及当事人的合理预期；vision-mcp 项目不为用户的具体使用行为承担责任。
- 涉及反作弊保护 / DRM 受保护内容 / 系统安全屏障的桌面应用（DirectX 全屏游戏、企业 EDR、UAC 高完整度 app 等），平台层会主动拒绝输入注入和截屏，请尊重这些边界。
