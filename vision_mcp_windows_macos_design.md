# Vision-MCP：基于视觉胶囊的自适应 GUI 操作地图

**项目详细设计交接文档**

面向：项目经理、工程师、产品设计人员

范围：Windows 与 macOS 桌面应用；不覆盖 Linux、移动端、Web-only Headless 场景

版本：v0.1 概念设计稿（日期：2026-05-26）+ v1.0 实测修订（日期：2026-05-28，见下方 errata）

## 一句话定义

Vision-MCP 是一套把真实 GUI 应用"吸入"稳定视觉胶囊，扫描并编译成可复用交互地图，然后通过 MCP 工具让各类 agent 安全、低成本、可审计地操作软件的系统。

核心创新不在于"让 agent 看图点击"，而在于把一次或少量视觉理解结果转化为 state graph、locator、相对坐标、校验规则与修复策略，使后续操作尽量不再依赖昂贵的视觉推理。

---

# v1.0 实测修订（errata 章节）

> 本文档原写于 2026-05-26（v0.1 设计稿）。v0.2–v1.0 实测后多个核心设计已修订；
> 本节列出关键变更供读者优先阅读，后续 §1–§19 保留为 v0.1 设计原文（架构 reference）。
> 详细演化路径见 git history。

## A. 关键设计变更

| v0.1 设计 | v1.0 实现 | 原因 |
|----------|-----------|------|
| **Virtual Display Capsule**（§7）创建专用虚拟显示器 | **Stable Window Capsule**：窗口固定主屏 display 工作区中心，完整可见 | macOS public API 不支持；Windows IDD 需驱动签名 + 企业部署。实测 off-screen / virtual cursor / peek-corner 体感差（窗口反复 flash） |
| **Windows IDD 虚拟显示驱动**（§8.2） | **未实现**。PowerShell + Win32 + UIA helper 直接迁窗口到主屏稳定位置 | 同上 |
| **macOS existing-display / third-party virtual**（§9.2） | **统一 `pickStableDisplay` 算法**：优先窗口当前 display；副屏自然保留 | 不需要专门 workspace 概念 |
| **Builder Mode**（§11.1）作为单独阶段 | **任务驱动 ⭐ + 探索驱动**两种入口，路径上混合 | 实战发现先建后用太死板；任务驱动下的"探索副产品"让 map 随使用自然完善 |
| **Repair Mode**（§11.3）只在 runtime 自动 | **新增 agent 主动 patch**：实战发现偏差时 `vision-mcp patch` 一行命令固化 | 让 map 越用越准；持续修正机制 |
| 未提分发 | **Claude Code Plugin + npm `@vision-mcp/{core,server,cli}` 双渠道**；postinstall 自动 swiftc/ps2exe | 实测后补 |

## B. 新增能力（v0.1 未规划）

- **持续修正机制**：agent 主动写 patch；trust 三级渐进（`session_only` → `trusted` → `untrusted_proposal`）
- **任务驱动 / 探索驱动两种用户意图**：用户给具体任务 → 路径上按需补 map；用户说"建立 X 的 vision-mcp" → 系统覆盖
- **探索副产品原则**：snapshot 已截就顺带把整页 candidates 一起 commit，边际成本为零
- **跨平台 helper 同协议**：
  - macOS Swift（1091 行）：SCKit window capture / AXPress / IOKit per-monitor DPI / Vision OCR
  - Windows PowerShell（641 行）：PrintWindow / UIA InvokePattern / AttachThreadInput hack / System.Drawing annotated 截图
- **region / collection / kbd 抽象**：跨 state 共享 UI 区域；N 元素单条声明；快捷键当 control 可寻址
- **跟 Anthropic Computer Use 的定位**：MCP server 路径，独立于哪个模型；产物是 map，跨任务复用；与 Computer Use（模型协议路径，每次全视觉）互补
- **成本优化原则**：执行模式默认不 snapshot；仅 4 个时机看图（任务起点 / 关键决策 / 失败诊断 / 任务结束）
- **examples/ vs apps/ 二分**：参考 maps 入 git；用户工作区 `.gitignore`
- **Claude Skill 集成**：`skills/vision-mcp/SKILL.md` 精简到 ~100 行（progressive disclosure → references/）

## C. 已修订章节对照

| 原章节 | v1.0 状态 |
|--------|-----------|
| §7 Virtual Display Capsule | 整体改为 Stable Window Capsule；§7.5 Geometry Contract / §7.6 Input Lease 保留 |
| §7.1–§7.4（虚拟显示器生命周期 / attach-after-launch） | 简化为 `vision-mcp capsule <app>` 一键 attach + migrate |
| §8.2 Windows 组件（IDD 驱动）| 删 IDD；保留 SendInput / UIA / DXGI capture 描述（已用 PrintWindow 实现） |
| §9.2 macOS 支持模式（existing-display / third-party virtual） | 删；统一 stable display |
| §9.5 macOS 风险与对策（虚拟显示器能力不稳定）| 已通过架构选择规避 |
| §11.1 Builder Mode（独立阶段）| 拆为任务驱动 / 探索驱动；详见 [`skills/vision-mcp/references/workflow.md`](skills/vision-mcp/references/workflow.md) |
| §11.3 Repair Mode | 保留 runtime 自动 repair；新增 agent 主动 patch（详见 [`skills/vision-mcp/references/patches.md`](skills/vision-mcp/references/patches.md)） |
| §13.4 Skill 内容 | 已实现完整 Skill 体系；SKILL.md + 7 个 references/ + 2 个 assets/ |
| §16.2 里程碑 | M1 macOS helper / M4 macOS 完善已交付；M1 Windows helper 骨架已交付（实测待 Windows 分支） |
| §17 验收标准 | 见 [`docs/acceptance.md`](docs/acceptance.md)（含 v1.0 对照） |

## D. 实测案例（v0.1 未规划）

`examples/` 收纳 4 个实测验证过的参考 maps：

| App | 平台 | 验证的架构能力 |
|-----|------|-----------------|
| `apple-music/` | macOS | region + collection + 双轨 locator（AX + 视觉）+ trusted patch（sidebar 偏差修正） |
| `notes/` | macOS | SwiftUI 自绘 + kbd region + editor.focus type-first 修正 |
| `activity-monitor/` | macOS | table view + 列排序（cmd+delete destructive） |
| `example-erp/` | Windows（虚构） | 完整架构 demo：3 regions + 2 collections + 4 states + 3 workflows + 2 patches（含 region-scope patch） |

## E. 分发架构（v0.1 未涉及）

```
┌─────────────────────────────────────────────────────────┐
│  Claude Code / Codex CLI / Cursor / Cline / OpenClaw    │
└──────────────────────┬──────────────────────────────────┘
                       │ MCP stdio
        ┌──────────────▼──────────────┐
        │ @vision-mcp/server          │ (npm)
        │   capsule.* / vision_map.*  │
        └──────────────┬──────────────┘
                       │
        ┌──────────────▼──────────────┐
        │ @vision-mcp/core            │ (npm)
        │   Capsule / Runtime / Map   │
        │   Locator / Repair / Trace  │
        └──────────────┬──────────────┘
                       │ JSON-RPC stdio
   ┌───────────────────┴───────────────────┐
   │                                       │
┌──▼──────────────┐               ┌────────▼────────┐
│ macOS helper    │               │ Windows helper  │
│ Swift 1091 行   │               │ PowerShell 641  │
│ SCKit / AX /    │               │ PrintWindow /   │
│ Vision / IOKit  │               │ UIA / Win32     │
└─────────────────┘               └─────────────────┘
```

分发渠道：
- **Claude Code Plugin**（推荐）：`.claude-plugin/plugin.json` + `.mcp.json` + `skills/vision-mcp/`；`/plugin install` 一条命令
- **npm**：`@vision-mcp/{core,server,cli}`；postinstall 自动 `vision-mcp install-helper`（swiftc / ps2exe）
- **源码**：git clone + `npm install && npm run build`

详见 [`INSTALL.md`](INSTALL.md)。

---

> 以下章节 §1–§19 为 v0.1 设计原文，保留作为架构 reference。涉及虚拟显示器 / Builder Mode 等内容请对照上方 errata 阅读。

# 目录

1. 文档目的与项目背景
1. 执行摘要
1. 产品目标、非目标与成功指标
1. 核心概念与术语
1. 用户角色与核心场景
1. 总体架构
1. Virtual Display Capsule 设计
1. Windows 平台技术方案
1. macOS 平台技术方案
1. Vision-MCP Map 数据模型
1. 构建、运行与修复流程
1. 最小成本修复策略
1. MCP Server 与 Skill 设计
1. 产品交互设计
1. 权限、安全与合规
1. 工程实现计划与里程碑
1. 验收标准
1. 风险、边界与待决问题
1. 附录：Schema、工具清单、资料来源

# 1. 文档目的与项目背景

本文档用于把“基于视觉构建自适应 MCP”的想法整理成项目交接稿，帮助项目经理评估路线与里程碑，帮助工程团队拆解实现，帮助产品设计人员理解用户流程、权限提示、接管机制与风险控制。

项目要解决的问题是：很多桌面软件、企业老系统、远程桌面窗口、设计/财务/运营工具没有稳定 API，或者 DOM / Accessibility selector 不完整。传统 GUI agent 每一步都需要截图、视觉理解、推理和点击，成本高且难审计；传统坐标脚本又极易因窗口位置、缩放、DPI、弹窗、布局变化而失效。

Vision-MCP 的目标是引入一个稳定视觉坐标底座，即“视觉胶囊”，并把 GUI 页面编译为可复用地图。后续 agent 调用 action_id，而不是每次重新分析截图或直接猜坐标。

# 2. 执行摘要

| 问题 | 设计选择 | 理由 |
| --- | --- | --- |
| 如何让坐标稳定？ | 使用 Virtual Display Capsule / Real-window Capsule，并建立 geometry contract。 | 不假设屏幕永远不变，而是在每次动作前校验窗口、客户区、DPI、缩放、显示器与 state anchors。 |
| 如何避免像无头浏览器一样隔离用户？ | 优先 same-session virtual display：应用仍在用户当前 OS 会话中，只是窗口迁入 agent 专用虚拟显示器。 | 保留用户登录态、文件系统、剪贴板、系统权限；用户通过 Live View 观看和接管。 |
| Windows 首发怎么做？ | Windows IDD 虚拟显示器 + Win32 窗口迁移 + Windows.Graphics.Capture + UI Automation/视觉定位。 | Windows 官方 IDD 支持非传统 GPU 输出显示器；Win32 可移动/调整窗口；WGC 可安全捕获窗口或显示器。 |
| macOS 怎么做？ | 首发不承诺创建系统级虚拟显示器；支持 Real-window Capsule、已有外接/虚拟显示器、第三方虚拟显示器适配。 | macOS 公开能力适合窗口捕获和 Accessibility 控制，但稳定创建虚拟显示器存在平台风险。 |
| 地图失效如何修？ | Repair ladder：坐标重算 → 几何恢复 → geometry profile 更新 → 单控件重定位 → 状态 patch → 页面重扫 → 全量重建。 | 优先低成本、低风险、局部修复，避免一失败就重建。 |
| 如何嵌入 agent 生态？ | Skill 负责方法论，MCP server 负责工具能力，CLI/插件负责安装和宿主集成。 | Skill 不能替代底层截图、点击、窗口管理和 OCR/VLM 能力；MCP 是统一可调用接口。 |

# 3. 产品目标、非目标与成功指标

## 3.1 产品目标

- 把任意可见 GUI 应用绑定到稳定视觉坐标系中，减少坐标漂移。
- 支持把用户已打开、已登录、已定位到目标页面的窗口迁入 capsule，尽量不破坏应用启动流。
- 把 GUI 页面扫描为 vision-mcp map：state、control、locator、bbox_norm、transition、postcondition、repair hint。
- 让 agent 后续通过 MCP tools 调用 action_id 操作软件，而不是每一步都重新看图推理。
- 在稳定性破坏时，按最小成本自动恢复或提出 patch，保留审计和回滚能力。
- 提供用户可见、可暂停、可接管、可批准高风险动作的产品体验。

## 3.2 非目标

- 不承诺自动探索完整复杂应用的全部页面；MVP 以“人类演示流程 + agent 结构化构建”为主。
- 不绕过系统安全机制、验证码、反自动化限制或软件授权。
- 不做后台隐形操作；所有屏幕读取和输入控制必须有清晰授权与可见状态。
- 不在首发中覆盖 Linux、Android、iOS 或纯 Headless 浏览器。
- 不把 raw coordinate 作为唯一定位方式；坐标只作为多 locator 体系中的 fallback。

## 3.3 成功指标

| 类别 | MVP 指标 | Beta 指标 |
| --- | --- | --- |
| 稳定性 | 同一 capsule 下关键 workflow 连续运行 20 次，成功率 ≥ 85%。 | 在轻微窗口/布局扰动后自动修复成功率 ≥ 75%，关键 workflow 成功率 ≥ 95%。 |
| 成本 | Runtime 阶段每 10 个动作中调用大视觉模型次数 ≤ 2 次。 | 稳定 map 下每 20 个动作中调用大视觉模型次数 ≤ 1 次。 |
| 可审计 | 每个动作记录 action_id、前置 state、后置校验、截图/anchor 摘要。 | 支持 session trace 回放、patch diff、人工批准记录。 |
| 用户体验 | 用户能看到 agent 控制区域、暂停、接管、迁回窗口。 | 支持高风险动作批准、修复建议确认、Live View 输入接管。 |
| 平台 | Windows 可完成 same-session virtual display 原型。macOS 可完成 real-window + existing display 原型。 | Windows 形成可安装版本；macOS 完成可用的外接/虚拟显示器适配和窗口组捕获策略。 |

# 4. 核心概念与术语

| 术语 | 定义 |
| --- | --- |
| Vision-MCP | GUI 交互地图与执行协议。它把视觉扫描结果转为 MCP 可读取的 resources 与可调用 tools。 |
| Vision Map / vision-mcp.yaml | 描述应用状态图、控件、locator、归一化坐标、动作、转移、校验和修复策略的文件。 |
| Capsule | 受控视觉工作区。负责稳定显示器/窗口/客户区/DPI/缩放，并提供截图与输入通道。 |
| Virtual Display Capsule | 同一 OS 会话中的 agent 专用虚拟显示器。可把已有窗口迁入其中操作，用户通过 Live View 观看和接管。 |
| Real-window Capsule | 不创建虚拟显示器，直接绑定用户真实桌面上的目标窗口，并通过几何合同与输入租约保证安全。 |
| Geometry Contract | 窗口、客户区、显示器、DPI、scale、zoom、坐标空间、捕获方式等稳定性约定。 |
| Input Lease | agent 操作前获得的短期输入控制权；用户输入、热键或高风险动作会打断或暂停 lease。 |
| Locator | 控件定位器。优先级：DOM/Accessibility/UIA → OCR 文本 → nearby text → image patch → bbox_norm → VLM 重新定位。 |
| Postcondition | 动作后的成功判定，如 state_should_be、text_should_appear、modal_should_close、URL/窗口标题变化等。 |
| Repair Ladder | 从最低成本到最高成本的修复阶梯，用于在 map 失效时局部恢复，而不是全量重建。 |

# 5. 用户角色与核心场景

## 5.1 用户角色

| 角色 | 诉求 | 典型动作 |
| --- | --- | --- |
| 业务用户 | 希望 agent 帮自己操作真实软件，但过程可见、可暂停、可接管。 | 把窗口吸入 capsule；批准提交/发送等动作；查看运行日志。 |
| 自动化工程师 | 需要把重复 GUI 流程沉淀成可复用 map 和 workflow。 | 录制流程；审查生成的 action；配置 repair policy；维护 map 版本。 |
| Agent 开发者 | 希望在不同 agent 宿主中复用 GUI 操作能力。 | 安装 skill/MCP server；调用 tools；读取 resources；处理错误码。 |
| 产品/管理员 | 关注权限、安全、可见性、合规和可控部署。 | 配置允许操作的应用、危险动作确认策略、日志保留和权限范围。 |

## 5.2 核心场景

- 企业老系统自动录入：用户打开并登录 ERP，选择窗口“吸入” Windows 虚拟显示器，agent 构建/执行录入 workflow。
- 桌面软件半自动操作：用户把设计/财务/运营软件迁入 capsule，agent 执行固定菜单和表单操作，高风险动作由用户批准。
- QA 回归测试：在固定 capsule 中运行相同 workflow，输出 trace、截图、失败 anchor 和修复建议。
- Agent 工具集成：Codex、OpenClaw、Claude Desktop、Cursor 等通过 MCP 调用 vision-mcp runtime，而无需各自实现窗口管理和修复逻辑。

# 6. 总体架构

## 6.1 架构原则

- 真实可见优先：优先操作用户同一 OS 会话中的真实窗口，而不是远程孤岛或无头环境。
- 几何合同优先：所有动作执行前都必须验证 geometry contract 和 state anchors。
- 多 locator 融合：不要依赖单一坐标；坐标作为 fallback，语义/结构定位优先。
- 局部修复优先：只修失效的 transform、geometry、control 或 state，避免重建全图。
- 人类在环：高风险动作、低置信度修复、权限变更和不可逆操作必须暂停确认。
- 可审计：每个动作都以 action_id、state、postcondition、截图摘要和日志记录。

## 6.2 组件视图

```text
User / Agent Host
   |
   |  MCP tools/resources + optional skill instructions
   v
Vision-MCP Server
   |-- Map Builder          -> 扫描/录制/生成 vision-mcp.yaml
   |-- Runtime Executor     -> detect_state / perform_action / verify
   |-- Repair Engine        -> repair ladder / patch overlay
   |-- Capsule Manager      -> 创建/绑定/迁移/恢复 capsule
   |-- Platform Adapters    -> Windows / macOS 截图、窗口、输入、辅助功能
   |-- Trace & Audit Store   -> screenshots, anchors, action logs, patches
   v
Capsule
   |-- Windows: Virtual Display Capsule / Real-window Capsule
   |-- macOS: Real-window Capsule / Existing-display Capsule / third-party virtual display adapter
   v
Target Application Window
```

## 6.3 组件职责

| 组件 | 职责 | 首发优先级 |
| --- | --- | --- |
| Agent Skill | 告诉 agent 何时构建 map、如何录制流程、如何调用 runtime、哪些动作需要确认。 | P0 |
| MCP Server | 暴露标准 tools/resources，承接所有 agent 宿主调用。 | P0 |
| Capsule Manager | 管理显示器/窗口/客户区/DPI/缩放/输入 lease。 | P0 |
| Map Builder | 从截图、OCR、Accessibility/UIA、人工演示中生成 state graph。 | P0 |
| Runtime Executor | 读取 map，执行 action_id，校验 postcondition。 | P0 |
| Repair Engine | 按 repair ladder 执行最小成本修复并生成 patch。 | P0 |
| Live View UI | 展示 capsule 内容、状态、日志、暂停/接管/批准控件。 | P1 |
| Review Console | 审查 map、patch、危险动作策略和 trace。 | P1 |

# 7. Virtual Display Capsule 设计

> **⚠️ v1.0 已修订**：整体改为 **Stable Window Capsule**。不创建虚拟显示器（macOS public API 不可靠 / Windows IDD 需驱动签名）；改为 `pickStableDisplay` 把窗口固定到主屏 display 工作区中心**完整可见**。§7.5 Geometry Contract / §7.6 Input Lease 仍有效。详见顶部 errata。

## 7.1 定义

Virtual Display Capsule 是同一 OS 用户会话中的 agent 专用显示器。目标应用窗口仍是用户真实会话中的真实窗口，可从物理显示器迁入虚拟显示器；用户通过 Live View 观看并可接管。它不是 headless browser，也不是独立 VM/RDP 会话。

## 7.2 价值

| 问题 | Virtual Display Capsule 的解决方式 |
| --- | --- |
| 窗口位置漂移 | 目标窗口始终被放置在固定显示器 work area 内；动作使用 capsule client rect 的归一化坐标。 |
| 用户干扰主屏幕 | agent 在专用虚拟显示器里操作，不抢用户物理屏幕。 |
| 用户需要可见性 | Live View 展示虚拟显示器内容，提供暂停、接管、批准与迁回。 |
| 应用启动流复杂 | 支持 attach-after-launch：先在用户环境打开并登录，再迁入 capsule。 |
| 后续地图修复 | 稳定底座使大多数漂移可归为 transform/geometry/profile/control 级别修复。 |

## 7.3 生命周期

1. Create / Ensure：创建或检测 capsule 显示器，设置分辨率、刷新率、scale、DPI 策略。
1. Attach：选择已有目标窗口，保存原窗口 placement、monitor、大小、最大化/最小化状态。
1. Migrate：恢复最小化窗口、退出全屏/最大化状态，将窗口移动并调整到 capsule work area。
1. Stabilize：等待 UI 布局稳定，执行 geometry guard 和 state anchor 识别。
1. Build / Run：构建 map 或执行已存在的 workflow。
1. Repair：稳定性破坏时按 repair ladder 低成本修复。
1. Release：任务结束后把窗口迁回原显示器和原 placement，或由用户选择保留在 capsule。

## 7.4 Attach-after-launch 模式

Attach-after-launch 是首发推荐流程：不由系统强行改变应用启动路径，而是在用户或 agent 已经完成登录、更新提示、启动弹窗等前置流程后，再把目标窗口迁入 capsule。这样降低了对启动期状态机的建模成本，也更符合用户对真实软件的认知。

```text
用户打开软件并登录
  -> 选择“吸入 Vision Capsule”
  -> 保存原窗口位置
  -> 创建/检查虚拟显示器
  -> 迁移窗口并固定 client rect
  -> 捕获截图 + 校验 geometry contract
  -> detect_state
  -> build/run/repair vision-mcp
```

## 7.5 Geometry Contract

Geometry contract 是 capsule 的核心。它不是“尽量保持差不多”，而是一个可验证、可恢复、可写入 trace 的运行合同。任何动作前合同失败，都不得盲点旧坐标。

```yaml
visual_box:
  id: "erp-capsule-1"
  mode: "same_session_virtual_display"
  platform: "windows"
  display:
    width_px: 1280
    height_px: 800
    scale: 1.0
    dpi_x: 96
    dpi_y: 96
  target_window:
    process_name: "erp.exe"
    title_regex: ".*ERP.*"
  coordinate_space: "normalized_client_rect"
  contract:
    require_same_display: true
    require_client_size_px: [1280, 800]
    tolerate_client_size_delta_px: 2
    require_unminimized: true
    require_foreground_for_input: true
    validate_before_each_action: true
```

## 7.6 输入租约

Input lease 避免用户和 agent 同时抢同一个窗口。agent 操作前申请短 lease，用户移动鼠标、按键、点击接管、触发热键或出现高风险动作时，lease 立即失效，runtime 暂停。

```yaml
input_lease:
  owner: "agent"
  target: "erp-capsule-1"
  expires_in_ms: 5000
  break_on_user_input: true
  break_hotkey: "Esc Esc"
  require_revalidate_after_break: true
```

# 8. Windows 平台技术方案

## 8.1 首发定位

Windows 是 Virtual Display Capsule 的首发平台。原因是 Windows 有明确的 Indirect Display Driver 模型用于支持非传统 GPU 输出的显示器，Win32 可移动和调整窗口，Windows.Graphics.Capture 可捕获显示器或窗口，UI Automation 可补充结构化控件定位。Microsoft 文档说明，IDD 模型支持不连接传统 GPU 输出的 monitor；SetWindowPos 可改变窗口大小、位置和 Z-order；Windows.Graphics.Capture 通过系统 picker 以安全方式捕获窗口或显示器并显示系统提示边框。

## 8.2 Windows 组件

> **⚠️ v1.0 已修订**：删 IDD 虚拟显示驱动。保留 SendInput / UIA / 截图描述；实际实现用 `PrintWindow(PW_RENDERFULLCONTENT)` 抓窗口、UIA `InvokePattern` 等价 macOS AXPress。详见 [`skills/vision-mcp/references/platform-windows.md`](skills/vision-mcp/references/platform-windows.md)。

| 子系统 | 建议技术 | 职责 |
| --- | --- | --- |
| 虚拟显示器 | Windows Indirect Display Driver / IddCx | 创建系统识别的虚拟 monitor，固定分辨率与刷新率。 |
| 窗口枚举与迁移 | EnumWindows、GetWindowPlacement、GetMonitorInfo、SetWindowPos、ShowWindow | 找到目标 hwnd，保存/恢复 placement，移动到 capsule work area。 |
| DPI/缩放守护 | GetDpiForWindow、WM_DPICHANGED、monitor info、client rect | 检测 DPI 与 client size 偏移，必要时暂停或恢复。 |
| 截图与 Live View | Windows.Graphics.Capture 或 DXGI fallback | 捕获虚拟显示器或目标窗口，驱动 Live View 和视觉解析。 |
| 输入执行 | SendInput / UI Automation Invoke / keyboard focus control | 点击、输入、快捷键、拖拽；优先结构化控件动作。 |
| 结构化定位 | Microsoft UI Automation | 获取 name、control type、bounding rectangle、invoke/text/value patterns。 |
| 安全与权限 | 安装驱动需管理员/签名；捕获需用户授权/系统提示；危险动作需 UI 确认。 | 保证部署可控、可解释、可审计。 |

## 8.3 Windows 迁移流程

```text
capsule.ensure_display(width=1280, height=800, scale=1.0)
  -> display_id = VISION_CAPSULE_1

window.attach(process_name="erp.exe", title_regex=".*ERP.*")
  -> hwnd
  -> save original WINDOWPLACEMENT + monitor id + rect

window.prepare(hwnd)
  -> if minimized: ShowWindow(SW_RESTORE)
  -> if maximized/fullscreen: restore normal placement when possible

window.migrate(hwnd, display_id)
  -> compute target workarea
  -> SetWindowPos(hwnd, x, y, w, h, flags)
  -> wait stable
  -> validate client rect / dpi / state anchors

vision_map.detect_state()
vision_map.perform_action(action_id)
```

## 8.4 Windows 风险与对策

| 风险 | 影响 | 对策 |
| --- | --- | --- |
| 虚拟显示驱动安装复杂 | 需要管理员权限、驱动签名、企业部署策略。 | MVP 可先集成/包装现有 IDD sample 思路；产品化阶段做签名安装器和回滚。 |
| 应用不响应 SetWindowPos 或有自定义窗口管理 | 无法稳定迁移或固定尺寸。 | 降级为 Real-window Capsule；记录 unsupported window flag；支持人工迁移。 |
| DPI 变化导致布局变化 | bbox_norm 仍可换算，但 UI 可能响应式重排。 | 迁入后强制重建/校验当前 geometry profile；优先同一 scale；DPI mismatch 时暂停。 |
| 多窗口/弹窗/菜单 | 单窗口捕获可能漏掉 modal/menu。 | 建立 window group：同进程 modal、owned windows、菜单、文件选择器作为独立 state。 |
| 安全软件/游戏/高权限窗口拦截输入 | 输入或截图失败。 | 检测 integrity level 和 capture failure；提示用户授权或标记 unsupported。 |

# 9. macOS 平台技术方案

## 9.1 首发定位

macOS 首发不应承诺“自动创建系统级虚拟显示器并迁移所有窗口”。更稳妥的产品策略是：先支持 Real-window Capsule；如果用户已有外接显示器、Sidecar/AirPlay/第三方虚拟显示器，则支持 Existing-display Capsule；后续再评估是否通过合作或可维护的底层方案提供虚拟显示器。

macOS 的公开能力非常适合窗口捕获和辅助功能控制：ScreenCaptureKit 用于高性能捕获屏幕/窗口内容，SCContentFilter 可限定捕获指定内容；AXUIElement 相关 API 允许辅助功能应用与正在运行的可访问应用通信和控制。

## 9.2 macOS 支持模式

> **⚠️ v1.0 已修订**：删 existing-display / third-party virtual / native virtual display 多模式分支。统一用 `pickStableDisplay`：优先窗口当前所在 display（自然支持副屏），其次 primary。实测虚拟显示器路线（v0.4 explored workspace 体系）已砍掉，详见 errata。

| 模式 | 描述 | 首发建议 |
| --- | --- | --- |
| Real-window Capsule | 绑定用户真实桌面上的目标窗口，固定 window bounds，使用 ScreenCaptureKit 捕获，Accessibility 执行。 | P0。macOS 首发默认形态。 |
| Existing-display Capsule | 使用已有第二显示器、Sidecar/AirPlay、dummy display 或第三方虚拟显示器作为 agent workspace。 | P1。可满足“可见 + 稳定 + 不抢主屏幕”。 |
| Third-party virtual display adapter | 对接可维护第三方虚拟显示器方案，只负责检测和迁移，不内置私有实现。 | P1/P2。需法律、分发、系统版本兼容评估。 |
| Native virtual display creation | 产品自行实现 macOS 虚拟显示器。 | 不纳入 MVP。作为长期研究项，不作为交付承诺。 |

## 9.3 macOS 组件

| 子系统 | 建议技术 | 职责 |
| --- | --- | --- |
| 窗口捕获 | ScreenCaptureKit：SCStream、SCContentFilter、SCShareableContent | 捕获目标窗口、display 或应用内容，为 Live View 和视觉解析提供帧。 |
| 窗口/控件控制 | Accessibility / AXUIElement、CGEvent、AppleScript/Automation fallback | 获取/设置窗口位置，点击、输入、菜单动作，读取 accessibility 元数据。 |
| 几何守护 | AX window position/size、ScreenCaptureKit frame metadata、NSScreen scale | 检查窗口 bounds、scale、显示器、最小化/隐藏状态。 |
| 输入租约 | 全局事件监听、Live View 控制、热键 | 用户接管时暂停 agent，动作前重新校验。 |
| 权限管理 | Screen Recording、Accessibility、Automation/Apple Events | 明确引导用户授权，拒绝时降级。 |

## 9.4 macOS 迁移流程

```text
模式 A：Real-window Capsule
  -> request Screen Recording + Accessibility permissions
  -> user selects target app/window
  -> save window position/size/fullscreen state
  -> set window bounds to configured visual box
  -> capture desktopIndependentWindow when possible
  -> validate geometry + state anchors

模式 B：Existing-display Capsule
  -> detect available displays
  -> user selects "Agent Workspace" display
  -> save original window placement
  -> move target AX window to workspace display bounds
  -> capture display/window
  -> validate geometry + state anchors
```

## 9.5 macOS 风险与对策

| 风险 | 影响 | 对策 |
| --- | --- | --- |
| 虚拟显示器能力不稳定 | 不同 macOS 版本和分发渠道可能不可靠。 | MVP 不依赖创建虚拟显示器；支持已有显示器或第三方方案。 |
| Accessibility 元数据不完整 | 无法稳定拿到控件语义和 bounds。 | 使用视觉/OCR/image patch 作为 fallback；map 记录 locator confidence。 |
| 全屏/Spaces 行为复杂 | 窗口不在普通桌面坐标系中。 | 迁移前要求退出全屏；全屏应用标记为 unsupported 或要求用户切换窗口模式。 |
| 系统弹窗和权限弹窗 | 可能不属于目标应用捕获窗口。 | 建立 system_modal state；必须人工批准。 |
| 权限拒绝 | 无法截图或控制输入。 | 产品 UI 明确说明缺失权限；提供只读/构建草稿模式。 |

# 10. Vision-MCP Map 数据模型

## 10.1 设计原则

- Map 是状态图，不是按钮清单。每个 state 有 anchors、controls、transitions 和 variants。
- 每个 control 需要多 locator：结构化定位、OCR、视觉 patch、bbox_norm、语义 label。
- 每个 action 需要 precondition 和 postcondition，执行完必须验证。
- Map 支持 baseline + trusted patches + session patches；修复默认先写 patch overlay。
- 坐标使用 normalized_client_rect，禁止长期存裸屏幕坐标作为主定位。

## 10.2 顶层结构

```yaml
version: "0.1"
app:
  id: "example-erp"
  name: "Example ERP"
  platform: "windows"
  launch_hint: "attach_after_launch"
visual_box:
  id: "erp-capsule-1"
  mode: "same_session_virtual_display"
  coordinate_space: "normalized_client_rect"
states: []
transitions: []
workflows: []
repair_policy: {}
safety_policy: {}
metadata: {}
```

## 10.3 State 结构

```yaml
states:
  - id: "invoice.editor"
    description: "发票编辑页"
    kind: "page"
    anchors:
      - type: "ocr_text"
        text: "发票信息"
        min_confidence: 0.85
      - type: "accessibility"
        role: "window"
        name_regex: ".*发票.*"
    controls:
      - id: "invoice.submit"
        role: "button"
        label: "提交"
        action_types: ["click"]
        locator_priority:
          - type: "accessibility"
            name: "提交"
          - type: "ocr_text"
            text: "提交"
          - type: "image_patch"
            file: "patches/invoice_submit.png"
          - type: "bbox_norm"
            value: [0.72, 0.81, 0.08, 0.04]
        visual:
          bbox_norm: [0.72, 0.81, 0.08, 0.04]
          center_norm: [0.76, 0.83]
        precondition:
          state_should_be: "invoice.editor"
        postcondition:
          any:
            - text_should_appear: "提交成功"
            - state_should_be: "invoice.detail"
        risk_level: "requires_confirmation"
```

## 10.4 Workflow 结构

```yaml
workflows:
  - id: "create_invoice"
    description: "创建并提交发票"
    inputs:
      - name: "customer_name"
      - name: "amount"
    steps:
      - action_id: "nav.invoice"
      - action_id: "invoice.customer_name"
        params: { text: "{{customer_name}}" }
      - action_id: "invoice.amount"
        params: { text: "{{amount}}" }
      - action_id: "invoice.submit"
        approval_required: true
```

# 11. 构建、运行与修复流程

## 11.1 Builder Mode

> **⚠️ v1.0 已修订**：拆为**任务驱动 ⭐**（默认）+ **探索驱动**两种用户意图入口，路径上混合。任务驱动下"探索副产品"原则让 map 随使用自然完善，不需要独立的 Builder 阶段。详见 [`skills/vision-mcp/references/workflow.md`](skills/vision-mcp/references/workflow.md)。

1. 绑定目标应用窗口，并建立 capsule / geometry contract。
1. 捕获当前窗口或显示器帧，同时尝试读取 UIA/AX/accessibility 结构。
1. 识别当前 state：标题、OCR 文本、视觉 layout、结构化节点。
1. 识别可操作 controls：按钮、输入框、菜单、tab、列表项、拖拽区域、滚动区域。
1. 为每个 control 生成多 locator，并计算 bbox_norm / center_norm。
1. 只自动探索安全导航动作；提交、删除、发送、付款、权限变更等标记为 requires_confirmation。
1. 动作后捕获新 state，记录 transition 和 postcondition。
1. 输出 vision-mcp.yaml、截图/patch assets、review report。

## 11.2 Runtime Mode

```text
load map
  -> capsule.validate_geometry()
  -> vision_map.detect_state()
  -> vision_map.list_actions(state_id)
  -> acquire_input_lease()
  -> perform_action(action_id, params)
  -> verify_postcondition()
  -> release_input_lease()
  -> write trace
```

## 11.3 Repair Mode

> **⚠️ v1.0 新增**：保留 runtime 自动 L0–L3 repair；新增 **agent 主动 patch** 路径。实战中 agent 发现 map 偏差时直接 `vision-mcp patch` 一行命令固化修正，trust 三级渐进（`session_only` → `trusted` → `untrusted_proposal`）。详见 [`skills/vision-mcp/references/patches.md`](skills/vision-mcp/references/patches.md)。

Repair Mode 不应默认进入完整重扫，而应由 runtime 按 repair ladder 自动尝试低成本修复。只有涉及状态新增、高风险动作、低置信度 relocation 或全量重建时，才交给 agent 或用户决策。

# 12. 最小成本修复策略

## 12.1 Repair Ladder

| 等级 | 名称 | 适用情况 | 是否自动 | 是否修改 map |
| --- | --- | --- | --- | --- |
| L0 | Recompute Transform | 窗口或显示器原点变化，但 client size/DPI/state 未变。 | 是 | 否 |
| L1 | Restore Geometry | 窗口被移动、缩放、最大化、移出 capsule。 | 是 | 否 |
| L2 | Update Geometry Profile | 分辨率或尺寸变化，但 anchor 残差很小，布局基本等比例。 | 条件自动 | 写 geometry patch |
| L3 | Relocate Control | 单个按钮/输入框移动，页面仍为同一 state。 | 高置信度自动 | 写 control patch |
| L4 | Patch State | 出现弹窗、菜单、登录态丢失、侧边栏折叠等局部状态变化。 | 通常需确认 | 写 state patch |
| L5 | Rescan Current State | 当前页面版本或布局明显变化。 | 否 | 重建当前 state |
| L6 | Rebuild Map | 应用版本、语言、主题、权限或导航结构大变。 | 否 | 新 map 版本 |

## 12.2 修复决策条件

```yaml
repair_policy:
  max_auto_repair_level: 3
  geometry:
    tolerate_client_size_delta_px: 2
    tolerate_origin_change: true
    require_same_dpi: true
  state:
    min_anchor_score: 0.86
    min_ocr_similarity: 0.88
    min_visual_similarity: 0.82
  control_relocation:
    confidence_threshold: 0.92
    max_bbox_shift_norm: 0.08
  destructive_actions:
    auto_repair_before_action: false
    require_user_confirmation: true
```

## 12.3 Patch Overlay

修复结果默认写入 patch overlay，而不是直接覆盖 baseline。这样可回滚、可审查、可在当前 session 临时生效。

```text
map load order:
  baseline vision-mcp.yaml
  + trusted patches/*.yaml
  + session patches/*.yaml
  + untrusted repair proposals/*.yaml

patch:
  id: "2026-05-26-invoice-submit-relocated"
  trust: "session_only"
  state_id: "invoice.editor"
  control_id: "invoice.submit"
  old_bbox_norm: [0.72, 0.81, 0.08, 0.04]
  new_bbox_norm: [0.74, 0.82, 0.08, 0.04]
  method: "ocr_text + nearby_text"
  confidence: 0.94
  requires_review: false
```

## 12.4 不允许自动修复的情况

- 付款、购买、转账、提交审批、外部消息发送、删除、覆盖文件、权限变更。
- 出现未知系统权限弹窗、验证码、反自动化页面、账号安全提示。
- 用户正在目标窗口或 Live View 内输入、鼠标正在移动、或主动接管。
- 当前截图与任何已知 state 的相似度都低于阈值。
- 修复会把动作目标从低风险控件变为高风险控件，或 locator 语义不一致。

# 13. MCP Server 与 Skill 设计

## 13.1 设计定位

MCP server 是实际能力层；Skill 是 agent 的操作手册；CLI/插件负责安装、权限、调试和宿主集成。MCP 官方文档将其定义为连接 AI 应用与外部系统的开放标准，server 可提供 resources、tools、prompts 等能力；tools 是模型可调用的外部动作。

## 13.2 MCP Tools

| 工具名 | 用途 | 权限/风险 |
| --- | --- | --- |
| capsule.ensure_display | 创建或检测 capsule 显示器/工作区。 | Windows 可能需要驱动/管理员。 |
| capsule.attach_window | 绑定已有目标窗口。 | 需要窗口枚举权限。 |
| capsule.migrate_window | 迁移窗口到 capsule 并固定几何。 | 可能改变用户窗口位置；需可撤销。 |
| capsule.restore_window | 迁回原位置/状态。 | 低风险。 |
| capsule.capture | 获取截图或帧摘要。 | 涉及屏幕读取权限。 |
| capsule.validate_geometry | 验证 display/window/client/DPI/scale。 | 低风险。 |
| vision_map.init | 初始化 map 项目。 | 文件写入。 |
| vision_map.detect_state | 识别当前 state。 | 可能调用 OCR/视觉模型。 |
| vision_map.propose_controls | 生成控件候选。 | 可能调用视觉模型。 |
| vision_map.perform_action | 按 action_id 执行动作。 | 按 risk_level 要求确认。 |
| vision_map.verify | 校验 postcondition。 | 低风险。 |
| vision_map.repair_minimal | 执行 L0-L3 修复。 | 超过阈值需确认。 |
| vision_map.export_trace | 导出运行日志和截图摘要。 | 注意敏感信息脱敏。 |

## 13.3 MCP Resources

```yaml
vision-mcp://apps
vision-mcp://apps/{app_id}/map
vision-mcp://apps/{app_id}/states/{state_id}
vision-mcp://apps/{app_id}/actions/{action_id}
vision-mcp://apps/{app_id}/workflows/{workflow_id}
vision-mcp://apps/{app_id}/patches
vision-mcp://apps/{app_id}/traces/latest
```

## 13.4 Skill 内容

Skill 应包含构建原则、运行原则、修复原则、安全边界、schema 示例和工具调用流程。它不应假装自己能完成底层截图/点击；它只指导 agent 在可用工具存在时如何正确使用 vision-mcp。

```text
skill/
  SKILL.md
  references/
    schema.md
    repair-policy.md
    safety.md
    platform-windows.md
    platform-macos.md
  assets/
    vision-mcp.schema.json
    review-report-template.md
```

# 14. 产品交互设计

## 14.1 核心 UI

- Capsule 控制面板：显示当前 capsule、目标应用、分辨率、DPI/scale、当前 state、agent 状态。
- Live View：显示虚拟显示器或目标窗口内容；支持接管输入。
- 动作预告：展示即将执行的 action_id、控件 label、风险等级、postcondition。
- 高风险确认：对于提交、删除、发送、支付、授权等动作，必须明确批准。
- Repair Review：展示旧 bbox、新 bbox、修复方法、置信度、是否仅当前 session 生效。
- Trace Viewer：查看每一步动作、截图摘要、anchor score、失败原因和 patch。

## 14.2 用户状态

| 状态 | 含义 | 用户可做什么 |
| --- | --- | --- |
| Idle | 没有 agent 操作。 | 选择窗口、创建 capsule、加载 map。 |
| Building | agent 正在构建或录制 map。 | 暂停、接管、标注控件、确认危险动作。 |
| Running | agent 正在执行 workflow。 | 暂停、接管、批准高风险步骤。 |
| Repairing | runtime 正在尝试低成本修复。 | 查看修复候选、接受/拒绝 patch。 |
| Paused | 用户输入、权限缺失、几何失效或高风险动作导致暂停。 | 恢复、迁回窗口、重新校验、手工修复。 |
| Takeover | 用户接管了目标 capsule 输入。 | 手工操作，完成后交还 agent 并重新校验。 |

## 14.3 关键体验原则

- 用户永远知道 agent 正在控制哪个窗口/显示器。
- 用户一键暂停和接管优先于 agent 任务完成。
- 所有高风险动作必须通过 UI 明确确认，而不是隐藏在聊天文本中。
- 修复建议必须可解释：为什么认为是同一个控件、旧位置是什么、新位置是什么、置信度多少。
- 迁入/迁出必须可逆；任务结束后恢复用户原窗口状态。

# 15. 权限、安全与合规

## 15.1 权限清单

| 平台 | 权限/能力 | 用途 | 产品提示 |
| --- | --- | --- | --- |
| Windows | 虚拟显示驱动安装 | 创建 same-session virtual display。 | 需要管理员/签名，安装时明确说明用途和卸载方式。 |
| Windows | 屏幕/窗口捕获 | Live View、视觉解析、state 校验。 | 使用系统捕获提示；不绕过隐私边框。 |
| Windows | 输入注入/UI Automation | 点击、输入、菜单、结构化控件动作。 | 只在用户允许的应用范围内启用。 |
| macOS | Screen Recording | 捕获窗口/显示器内容。 | 引导用户到系统设置授权，拒绝则只支持手工导入截图。 |
| macOS | Accessibility | 读取/移动窗口、点击、输入、控件操作。 | 说明会控制指定应用，支持随时撤销。 |
| macOS | Automation/Apple Events | 必要时控制菜单或应用脚本。 | 按应用请求，默认关闭。 |

## 15.2 安全策略

- 工具最小权限：只允许绑定用户选中的窗口/应用；默认不全屏读取、不全局输入。
- 动作白名单：map 中没有定义的高风险动作不得自由执行。
- Prompt injection 防护：屏幕上的文字不能覆盖用户指令或安全策略。
- 敏感信息脱敏：trace 中的截图、OCR 文本、输入字段可按规则脱敏或本地加密。
- 审计日志：记录工具调用、目标窗口、action_id、确认事件、修复 patch、失败原因。
- 人类在环：MCP 工具调用涉及外部动作时应提供明确 UI 和拒绝能力；MCP 官方工具规范也建议用户应能拒绝工具调用并看到工具暴露情况。

## 15.3 默认禁止自动执行的动作

- 付款、购买、转账、证券/金融交易。
- 删除、覆盖、不可逆提交、生产环境发布。
- 发送邮件/聊天/短信/外部评论。
- 账号、权限、安全设置变更。
- 同意隐私条款、授权第三方、授予系统权限。
- 验证码、登录异常、风控、人机验证相关操作。

# 16. 工程实现计划与里程碑

## 16.1 技术栈建议

| 层 | Windows 建议 | macOS 建议 | 跨平台建议 |
| --- | --- | --- | --- |
| 核心 runtime | Rust 或 TypeScript + native bindings | Rust/Swift sidecar 或 TypeScript + native helper | MCP server 可用 TypeScript/Rust/Python；核心窗口/输入建议 native。 |
| 截图 | Windows.Graphics.Capture / DXGI fallback | ScreenCaptureKit | 统一帧接口：RGBA buffer + metadata。 |
| 窗口 | Win32 API | Accessibility / Cocoa / CG APIs | 统一 WindowHandle 抽象。 |
| 输入 | SendInput / UIA | CGEvent / AX actions | 统一 InputAction。 |
| OCR/视觉 | 本地 OCR + 可插拔 VLM | 本地 OCR + 可插拔 VLM | Provider 接口，不绑定单模型。 |
| Map/patch | YAML/JSON + schema validation | YAML/JSON + schema validation | 本地 SQLite 存 trace，可导出。 |

## 16.2 里程碑

| 阶段 | 目标 | 交付物 |
| --- | --- | --- |
| M0 研究验证 | 验证 Windows 虚拟显示器、窗口迁移、截图、输入、DPI 检测可闭环。 | 技术 spike、平台限制清单、demo 视频。 |
| M1 Windows MVP | 已有窗口吸入 capsule，固定 1280×800，构建当前页面 map，执行 action。 | Capsule Manager、MCP server、基础 map schema、Live View。 |
| M2 Repair MVP | 实现 L0-L3 自动修复，trace 和 patch overlay。 | Repair Engine、review report、失败回放。 |
| M3 Workflow Builder | 人类演示流程 → 自动生成 workflow → 自动复跑。 | Recorder、Builder、workflow schema、review UI。 |
| M4 macOS Alpha | Real-window Capsule + existing-display capsule，支持窗口捕获、AX 控制、基础 map。 | macOS helper、权限引导、平台适配文档。 |
| M5 Beta | 安全策略、高风险确认、插件/安装器、文档完善。 | 面向内部用户的可安装版本、示例 maps、SDK/CLI。 |

## 16.3 团队分工建议

| 角色 | 职责 |
| --- | --- |
| PM | 定义首发目标应用、验收 workflow、风险策略、企业部署约束。 |
| Windows 工程 | IDD/窗口迁移/WGC/UIA/输入/安装器。 |
| macOS 工程 | ScreenCaptureKit/AX/窗口管理/权限引导/Existing-display 支持。 |
| Agent 工程 | MCP server、skill、tool schema、host 集成、错误处理。 |
| AI/视觉工程 | OCR、UI element detection、VLM relocation、anchor scoring。 |
| 前端/产品设计 | Live View、控制面板、权限提示、review/trace UI。 |
| 安全/平台 | 权限模型、审计、脱敏、驱动签名、合规评审。 |

# 17. 验收标准

## 17.1 Windows MVP 验收

- 可创建或检测固定 1280×800 capsule 工作区。
- 可把用户已打开的普通桌面应用窗口迁入 capsule，并在结束后迁回原位置。
- 可捕获 capsule 内容并显示 Live View。
- 可生成至少一个页面的 vision-mcp map，包含 state、anchors、controls、bbox_norm、postconditions。
- 可通过 MCP 调用 perform_action 执行至少 click/type/scroll/key 四类动作。
- 窗口被移动/缩放后，L0/L1 修复可自动恢复，且不修改 map。
- 单个按钮轻微漂移时，L3 修复可生成 session patch 并成功执行。
- 高风险动作被拦截并要求用户确认。

## 17.2 macOS Alpha 验收

- 可授权并捕获目标窗口或显示器。
- 可通过 Accessibility 移动/调整普通窗口，并执行基础点击/输入。
- 可建立 Real-window Capsule 的 geometry contract。
- 可在已有第二显示器或第三方虚拟显示器存在时把窗口迁入工作区。
- 权限缺失、全屏/Spaces、不支持窗口等情况有明确错误提示和降级路径。

## 17.3 文档与交付验收

- 提供 vision-mcp schema、MCP tools schema、repair policy、错误码文档。
- 提供用户权限说明、管理员部署说明、卸载/恢复说明。
- 提供至少 2 个示例应用 map 和 2 条 workflow。
- 提供 trace 样例和 repair patch 样例。

# 18. 风险、边界与待决问题

## 18.1 主要风险

| 风险 | 等级 | 缓解策略 |
| --- | --- | --- |
| Windows 虚拟显示驱动分发与签名复杂 | 高 | MVP 先工程验证；产品化阶段早期启动签名/安装器/企业策略评审。 |
| macOS 虚拟显示器创建不可控 | 高 | 不作为首发承诺；优先 Real-window 和 existing-display。 |
| 应用自定义渲染导致 accessibility 缺失 | 中高 | 视觉/OCR/image patch fallback；局部修复；人类 review。 |
| 响应式布局导致坐标变化 | 中高 | 固定 capsule 尺寸；geometry profile；anchor 校验；L2/L5 修复。 |
| 用户误以为 agent 在后台隐形操作 | 中 | 可见 Live View、状态边框、日志、高风险确认。 |
| Prompt injection / 屏幕指令攻击 | 高 | 屏幕文字不拥有指令权；工具安全策略独立于 VLM。 |
| 敏感数据出现在截图/OCR/trace | 高 | 本地优先、脱敏、加密、可配置保留周期。 |

## 18.2 待决问题

- 首发 Windows 是否自研 IDD 驱动、封装开源方案，还是要求用户安装第三方虚拟显示器？
- 目标客户是否允许安装驱动？是否需要企业 MSI、Intune、Group Policy 支持？
- map 是否默认本地存储，还是需要团队共享/版本管理/权限控制？
- 截图和 OCR 文本是否允许上传到云端 VLM？默认应为本地，不同客户可配置。
- 哪些动作属于高风险，需要由产品/合规给出默认策略？
- macOS 是否要支持第三方虚拟显示器白名单？支持哪些版本范围？
- 是否要提供 SDK 给第三方应用主动暴露更稳定 locator？

# 19. 附录：Schema、工具清单、资料来源

## 19.1 vision-mcp.yaml 完整示例片段

```yaml
version: "0.1"
app:
  id: "example-erp"
  name: "Example ERP"
  platform: "windows"
  build: "2026.05"
visual_box:
  id: "erp-capsule-1"
  mode: "same_session_virtual_display"
  coordinate_space: "normalized_client_rect"
  geometry_contract:
    width_px: 1280
    height_px: 800
    dpi_x: 96
    dpi_y: 96
    scale: 1.0
states:
  - id: "login"
    anchors:
      - type: "ocr_text"
        text: "用户名"
      - type: "ocr_text"
        text: "密码"
    controls:
      - id: "login.username"
        role: "textbox"
        label: "用户名"
        action_types: ["type"]
        visual:
          bbox_norm: [0.42, 0.40, 0.25, 0.05]
          center_norm: [0.545, 0.425]
      - id: "login.submit"
        role: "button"
        label: "登录"
        action_types: ["click"]
        locator_priority:
          - type: "ocr_text"
            text: "登录"
          - type: "bbox_norm"
            value: [0.50, 0.57, 0.12, 0.05]
        postcondition:
          any:
            - state_should_be: "dashboard"
            - text_should_appear: "工作台"
transitions:
  - from: "login"
    action_id: "login.submit"
    to: "dashboard"
    verify:
      - type: "text_appears"
        text: "工作台"
```

## 19.2 错误码建议

| 错误码 | 含义 | 默认处理 |
| --- | --- | --- |
| CAPSULE_DISPLAY_MISSING | capsule 显示器不存在或断开。 | 尝试重新 ensure_display；失败则暂停。 |
| WINDOW_NOT_FOUND | 目标窗口不存在或已关闭。 | 提示用户重新选择窗口。 |
| GEOMETRY_MISMATCH | client rect / DPI / scale 与合同不匹配。 | L0/L1 修复；失败暂停。 |
| STATE_UNKNOWN | 当前截图无法匹配已知 state。 | 请求 agent/用户确认或 L5 局部重扫。 |
| ACTION_RISK_REQUIRES_CONFIRMATION | 动作风险等级要求确认。 | 显示确认 UI。 |
| POSTCONDITION_FAILED | 动作后校验失败。 | 进入 repair_minimal 或暂停。 |
| PERMISSION_DENIED | 缺少截图/输入/辅助功能权限。 | 展示权限引导。 |
| REPAIR_LOW_CONFIDENCE | 修复置信度低于阈值。 | 生成 proposal，不自动应用。 |

## 19.3 资料来源/官方依据

| 主题 | 依据 | 链接 |
| --- | --- | --- |
| Windows 虚拟显示器 | Microsoft Indirect Display Driver Model：支持不连接传统 GPU 输出的 monitor，适用于远程显示、虚拟桌面等场景。 | https://learn.microsoft.com/en-us/windows-hardware/drivers/display/indirect-display-driver-model-overview |
| Windows 窗口迁移 | SetWindowPos 可改变窗口的大小、位置和 Z-order。 | https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwindowpos |
| Windows 捕获 | Windows.Graphics.Capture 支持以安全方式捕获显示器或应用窗口，并通过系统 UI/提示边框呈现捕获状态。 | https://learn.microsoft.com/en-us/windows/apps/develop/media-authoring-processing/screen-capture |
| macOS 捕获 | ScreenCaptureKit 提供高性能屏幕/窗口/音频内容捕获；SCContentFilter 可限定捕获内容。 | https://developer.apple.com/documentation/ScreenCaptureKit/capturing-screen-content-in-macos |
| macOS 窗口捕获过滤 | SCContentFilter 可创建只捕获指定窗口的过滤器。 | https://developer.apple.com/documentation/screencapturekit/sccontentfilter |
| macOS Accessibility | AXUIElement/AXUIElement.h 用于辅助功能应用与正在运行的可访问 macOS 应用通信和控制。 | https://developer.apple.com/documentation/applicationservices/axuielement_h |
| MCP 概念 | MCP 是连接 AI 应用与外部系统的开放标准，server 可提供 tools/resources/prompts。 | https://modelcontextprotocol.io/docs/getting-started/intro |
| MCP Tools 安全 | MCP Tools 规范建议用户应能看到工具暴露情况，并保留拒绝工具调用的能力。 | https://modelcontextprotocol.io/specification/2025-11-25/server/tools |

## 19.4 最终结论

项目建议以 Windows Virtual Display Capsule 作为首发差异化能力，以 macOS Real-window / Existing-display Capsule 作为并行可用路径。Vision-MCP 的核心价值不应包装成“万能视觉坐标脚本”，而应定位为“可见、可接管、可审计、可自修复的 GUI 操作地图平台”。
