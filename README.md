# Vision-MCP

> 让 LLM agent 像人一样操作真实桌面应用——看截图、估坐标、点击、验证。**但把每次实测的路径沉淀为可复用的 vision-mcp（地图）**，下次直接 `run_workflow` 命中，操作成本随次数递减。

## 它解决什么问题

传统 "computer use" 方案（Anthropic Computer Use / OpenAI Operator / 截图脚本）每次任务都从零看图、估坐标、试错。Vision-MCP **额外**做两件事：

1. **路径沉淀为 map**：探索时把发现的 state / region / control / workflow 写入 `vision-mcp.yaml`；后续任务用 action_id 直接命中，不再视觉判断
2. **持续修正**：实战中遇 map 偏差时 `vision-mcp patch` 一行命令固化修正；map 越用越准

| 维度 | Anthropic Computer Use | Vision-MCP |
|------|------------------------|------------|
| 每次任务的视觉成本 | 高（全程视觉判断） | 高 → 低（第一次探索，第二次起命中 map） |
| 操作沉淀 | 无 | vision-mcp.yaml + trusted patches |
| 工作模式 | 单一：模型直接看图给坐标 | 任务驱动 ⭐（路径上混合）+ 探索驱动（系统建立 vision-mcp） |
| MCP 兼容 | 否（模型 tool 协议） | 是（任何 stdio MCP host） |
| 适合场景 | 一次性、临时任务 | 重复性工作流、企业自动化、跨任务复用 |

两者**互补**：探索期用 Computer Use 的思路（视觉为主），沉淀 map 后用 vision-mcp 高效执行。

## 30 秒上手（Claude Code Plugin）

```bash
# 在 Claude Code 内
/plugin install vision-mcp/vision-mcp@main
# 首次启动自动 swiftc 编译 native helper；用户态授权 Screen Recording + Accessibility 即可
```

Plugin 自带 `.mcp.json` + `skills/vision-mcp/`，安装后 agent 立刻能识别 `capsule.*` / `vision_map.*` 工具与 Skill 操作手册。

其他 MCP host（Codex CLI / Cursor / Cline / OpenClaw）的配置见 [INSTALL.md](INSTALL.md)。

## 核心能力一览

### 给 agent 的 MCP 工具

| 类别 | 工具 |
|------|------|
| **执行** ⭐ | `run_workflow` / `perform_action` / `kbd.<action>` |
| **探索** | `snapshot` / `annotated` / `click-text` / `commit_state` |
| **持续修正** | `vision-mcp patch` 一行命令固化偏差 |
| **窗口管理** | `displays` / `capsule` / `restore` / `live-view` |
| **macOS 高级** | `ax-press`（UIA InvokePattern 等价，零鼠标干预） |

### 地图（vision-mcp.yaml）抽象

- **state**：UI 页面节点，含 anchors + controls
- **region**：跨 state 共享的 UI 区域（sidebar / toolbar / kbd 快捷键集）—— `inherit_regions` 在 state 引用
- **collection**：同质 N 元素（4×2 卡片 / 12 行表格）单条声明，按 `[N]` 寻址
- **workflow**：多步组合任务，含 inputs + approval_required + on_failure
- **patch overlay**：runtime 修复 / agent 主动 patch 都不破坏 baseline；trust 三级（`session_only` / `trusted` / `untrusted_proposal`）

完整 schema 见 [`schema/vision-mcp.schema.json`](schema/vision-mcp.schema.json) 或 [`skills/vision-mcp/references/schema.md`](skills/vision-mcp/references/schema.md)。

### 安全策略

- `safety_policy.forbidden_action_categories`（payment / destructive / external_communication / permission_change / captcha）默认拒绝
- `requires_confirmation` / `destructive` 必经审批通道
- `redaction_patterns` 自动脱敏密码 / 信用卡号写入 trace 时
- Trace 含每个 action 前后截图，可审计

## 完成度

| 模块 | 状态 | 文件 |
|------|------|------|
| Schema + Map IO + Patch overlay | ✅ | `packages/core/src/schema/*`, `map/*` |
| Capsule Manager / Geometry Contract / Input Lease | ✅ | `packages/core/src/capsule/*` |
| Runtime Executor + postcondition + audit trace | ✅ | `packages/core/src/runtime/*` |
| Locator: AX / OCR / nearby_text / image_patch / bbox_norm / VLM | ✅ | `packages/core/src/locator/*` |
| Repair Engine L0–L3 + patch overlay | ✅ | `packages/core/src/repair/*` |
| MCP Server (`capsule.*` / `vision_map.*`) | ✅ | `packages/server/*` |
| CLI (init / capsule / run / workflow / patch / install-helper / live-view ...) | ✅ | `packages/cli/src/cli.ts` |
| macOS native helper (Swift + SCKit + AX + IOKit + Vision) | ✅ 1091 行 | `native/macos/src/main.swift` |
| Windows native helper (PowerShell + Win32 + UIA + System.Drawing) | ✅ 641 行 | `native/windows/src/vision-mcp-helper.ps1` |
| Claude Code Plugin（含 .mcp.json + skills/） | ✅ | `.claude-plugin/`, `.mcp.json` |
| 测试 | ✅ 45 pass | `packages/*/tests/*.test.ts` |

**不在 MVP 范围**：

- 系统级虚拟显示器（macOS public API 不支持；Windows IDD 需签名 + 企业部署）
- 生产 OCR / VLM（提供 `OcrProvider` / `VlmProvider` interface，可注入 Tesseract / PaddleOCR / Apple Vision / OpenAI 等）
- 独立 GUI Live View 桌面 app（已用 HTTP server 实现 MVP，浏览器查看）
- 反作弊 / DirectX 全屏游戏（系统层限制）

## 仓库结构

```
vision-mcp/
├── packages/                  # TypeScript monorepo
│   ├── core/                  # 数据模型 / Capsule / Runtime / Repair / Locator / Trace
│   ├── server/                # MCP server: tools + resources + stdio
│   └── cli/                   # vision-mcp CLI（含 install-helper / patch / capsule / live-view）
├── native/                    # Native helper 源码（npm publish 时复制进 cli 包）
│   ├── macos/src/main.swift   # 1091 行 Swift
│   └── windows/src/vision-mcp-helper.ps1   # 641 行 PowerShell
├── examples/                  # 项目自带参考 maps（入 git）
│   ├── apple-music/           # macOS: region + collection + 双轨 locator
│   ├── notes/                 # macOS: SwiftUI 自绘 + kbd region
│   ├── activity-monitor/      # macOS: table view + 列排序
│   └── example-erp/           # 虚构 Windows ERP（架构完整 demo）
├── skills/vision-mcp/         # Claude Skill：agent 操作手册
│   ├── SKILL.md               # 核心入口（94 行精简版）
│   ├── references/            # workflow / patches / schema / safety / platform-*
│   └── assets/                # JSON Schema + 审阅模板
├── docs/                      # deployment / errors / permissions / acceptance
├── .claude-plugin/plugin.json # Claude Code Plugin manifest
├── .mcp.json                  # Plugin 加载时使用的 MCP server 配置
└── apps/                      # 用户工作区（VISION_MCP_APPS_ROOT 默认，.gitignore）
```

## 工作流速览（详见 [SKILL.md](skills/vision-mcp/SKILL.md)）

```
用户给任务 ──► 任务驱动 ⭐
  detect_state → run_workflow → 成功 → 给用户报告
                       ↓ 失败
                 repair_minimal L0-L3
                       ↓ 修不好
                 snapshot 看现状
                       ├─ map 偏差 → `vision-mcp patch` 一行固化 → 重试
                       └─ unknown state → 当场探索 + 扩展 vision-mcp（小切片）→ 继续

用户说"探索 X" / "建立 X 的 vision-mcp" ──► 探索驱动
  BFS 遍历所有可达 state → commit anchors + controls → 写 transitions / workflows
```

**4 个 snapshot 时机**（任务驱动下，其它时机不 snapshot）：任务起点 / 关键决策 / 失败诊断 / 任务结束。

**探索副产品**：snapshot 一旦截了，顺带把页面几个明显 control 一起 `commit_state`——边际成本几乎为零，但**不要**为看更多元素多 snapshot 几次（那是探索驱动）。

## native helper 编译

`vision-mcp install-helper` 一条命令完成（npm install 时 postinstall 自动跑）：

- **macOS**：检测 `swiftc` → 自动 `swiftc -O ...` 编译（~5–10 秒）。需要 Xcode Command Line Tools (`xcode-select --install`)。
- **Windows**：自检 PowerShell 5.1（不能用 pwsh 7：UIAutomationClient Add-Type 必失败）+ 写部署说明。helper 是 `.ps1`，CLI 自动用 `powershell.exe -File` 包一层。首次 RPC 冷启动 ~400ms，之后稳定 ~50ms。

首次操作真窗口时，macOS 会弹两个授权对话框：**屏幕录制** + **辅助功能**——授权后重启 MCP host 让权限生效。

**Windows 自检 & 常见问题**：跑 `vision-mcp doctor` 一次看 PowerShell 版本 / helper 路径 / displays / elevation；报 issue 时把输出贴上。详细的 SmartScreen 解除、企业 GPO（AppLocker / WDAC / ExecutionPolicy）、UWP/MSIX app 操作要点见 [native/windows/README.md §8](native/windows/README.md)。

## 文档导览

- **[AGENT-USAGE.md](AGENT-USAGE.md)** — agent 工具速查 + Apple Music 实战示例
- **[INSTALL.md](INSTALL.md)** — 三种分发路径（Plugin / npm / 源码）+ 各 host 配置示例
- **[skills/vision-mcp/SKILL.md](skills/vision-mcp/SKILL.md)** — agent 操作手册（精简核心，~5 分钟读完）
- [skills/vision-mcp/references/workflow.md](skills/vision-mcp/references/workflow.md) — 工作流决策树、副产品原则、反模式
- [skills/vision-mcp/references/patches.md](skills/vision-mcp/references/patches.md) — 持续修正：4 种 patch 类型、trust 升级
- [skills/vision-mcp/references/schema.md](skills/vision-mcp/references/schema.md) — vision-mcp.yaml 字段速查
- [skills/vision-mcp/references/platform-macos.md](skills/vision-mcp/references/platform-macos.md) — macOS 适配器、SCKit、AX-press
- [skills/vision-mcp/references/platform-windows.md](skills/vision-mcp/references/platform-windows.md) — Windows 适配器、PrintWindow、UIA InvokePattern
- [skills/vision-mcp/references/safety.md](skills/vision-mcp/references/safety.md) — 高风险动作清单、prompt injection 防护
- [docs/errors.md](docs/errors.md) — 错误码 + recoverable 标志
- [docs/permissions.md](docs/permissions.md) — Windows / macOS 权限清单
- [vision_mcp_windows_macos_design.md](vision_mcp_windows_macos_design.md) — 设计文档（架构 + 平台决策）

## FAQ

**Q: 为什么不直接用 Anthropic Computer Use？**
A: Computer Use 是模型协议（Claude 输出 click 坐标，调用方实现 click），每次任务都是 full vision 成本，**不沉淀**操作路径。vision-mcp 是 MCP server 路径，跟模型无关；产物是可复用的 map，第二次起命中成本递减。两者互补——探索期用 Computer Use 思路，沉淀后用 vision-mcp 高效执行。

**Q: 为什么自己实现 native helper 不用 nut.js / robotgo？**
A: 这些通用库的中文输入 / AX 树 / SCKit 现代 capture 支持都不够稳。我们在 macOS 用 NSPasteboard 粘贴 + AXPress 零鼠标 + SCKit window capture（能抓部分屏外窗口）；Windows 用 Clipboard + UIA InvokePattern + PrintWindow——这些都是桌面 agent 最常踩的坑，自己实现保证质量。

**Q: 跑 `npm install -g @vision-mcp/cli` 后报 "swiftc 编译失败"？**
A: 装 Xcode Command Line Tools：`xcode-select --install`。然后 `vision-mcp install-helper --force` 重编。

**Q: agent 跑 workflow 失败说 `CAPSULE_PLATFORM_UNAVAILABLE`？**
A: native helper 没编译好。运行 `vision-mcp install-helper` 检查 + 自动编译。

## 协议

Apache-2.0（见 [`LICENSE`](LICENSE)）。
