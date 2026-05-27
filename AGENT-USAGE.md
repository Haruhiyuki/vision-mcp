# Vision-MCP — Agent 使用指南

> 面向 MCP host 中的 agent。让 agent 像人一样用桌面软件——看截图、估坐标、点击、验证——但把每次实测的路径沉淀为可复用的 map，下次直接调用。
>
> **核心**：**视觉为主 + 路径上沉淀 map + 稳定窗口 + 高风险必审批**。
>
> - 用户给任务 → **任务驱动 ⭐**：`detect_state` → `run_workflow` → 失败时 `snapshot` 诊断 → `patch` / `commit_state` 继续；任务结束时 vision-mcp 比开始时更完整
> - 用户说"探索 X" / "建立 X 的 vision-mcp" → **探索驱动**：BFS 走遍 → commit 完整 anchors/controls/workflows 写入 vision-mcp
> - `snapshot` 仅 4 时机：任务起点 / 关键决策 / 失败诊断 / 任务结束
> - **副产品原则**：snapshot 已截了，candidates 已在 context，顺带把几个明显 control 一起 commit 入 baseline
> - 偏差当场固化：`vision-mcp patch --state ... --control ... --bbox-norm x,y,w,h`
> - 窗口固定主屏 display 工作区中心**完整可见**；用归一化坐标；**不创建虚拟显示器**
>
> 完整原则见 [`skills/vision-mcp/SKILL.md`](skills/vision-mcp/SKILL.md) §1-2。

## 1. 工具总览（按工作流位置分组）

### 1.1 任务执行 ⭐ — 任务驱动下大部分时间用这些

> 任务驱动模式下的**默认工具**。优先调这些；只在 4 个时机才 snapshot；遇 map 偏差直接 patch。

| 工具 | 用途 | 返回 |
| ---- | ---- | ---- |
| **`vision_map.run_workflow`** | 跑一条预定义 workflow（多步组合） | result + steps |
| **`vision_map.perform_action`** | 执行单个 action_id（如 `kbd.new_note` / `sidebar.search`） | result + events |
| `vision_map.type_text` | 在当前焦点 type 文本（支持中文，走粘贴） | { ok, length } |
| `vision_map.press_key` | 发键盘组合（return / cmd+f / Escape ...） | { ok } |
| `vision_map.scroll` | 在归一化点滚动 | { ok } |
| `vision_map.detect_state` | **轻量** state 识别，**无 PNG 进 context**；任务开始时确认入口 state | state_match |
| `vision_map.repair_minimal` | 触发 L0–L3 修复 ladder（postcondition 失败时自动调） | repair outcome |
| **`vision-mcp patch`** | 实战发现偏差 → 写 patch 固化修正（持续修正机制） | patch file path |
| **`vision-mcp patches`** | 列出 app 已应用的 patch | patch list |

### 1.2 探索 — 任务路径上遇 unknown 时按需 + 探索驱动时常用

> 任务驱动遇 unknown state 时按需调（探索副产品原则）；探索驱动下系统使用。产出物写入 `vision-mcp.yaml`。

| 工具 | 用途 | 返回 |
| ---- | ---- | ---- |
| `vision_map.snapshot` | 一次拿**截图 + AX 候选 + state 匹配**。**只在 §7 四个看图时机调** | base64 PNG + candidates + state_match + visual_hash |
| `vision-mcp annotated` | 截图叠加网格 + 候选框 + 序号；探索时说"click #7"而非估坐标 | PNG 文件 + box_count |
| `vision-mcp click-text` | OCR 找文字 → click 其中心；探索时定位元素的利器 | { matched_text, confidence, point } |
| `vision-mcp click-fuzzy` | click 失败时围绕 ±jitter 多次试 | { ok, point, offset, visual_diff } |
| `vision-mcp hover` | 移到坐标 + 等待，触发 hover-only 控件 | { ok } |
| `vision-mcp hover-probe` | hover 后 vs 前像素 diff，找 hover 触发的新元素 | { ok, hot_block_bbox_norm } |
| `vision-mcp scroll-until-text` | region 内反复滚动 + OCR 找文字 | { ok, attempts, matched_text } |
| `vision_map.click_at` | 在归一化坐标 click（探索原始动作） | { ok, point_screen } |
| `vision_map.commit_state` | 把当前帧 AX 状态写入 map.baseline | { state_id } |
| `vision_map.apply_patch` | 写 control_bbox / geometry / state patch | patch file path |
| `vision-mcp ax-press` | macOS 高级：AX 直接对 norm 位置元素发 AXPress（对菜单/按钮稳；NSTableView cell / SwiftUI 自绘元素无效） | { ok, via, matched_role } |

### 1.3 Capsule / Workspace — 一次性 setup

| 工具 | 用途 | 返回 |
| ---- | ---- | ---- |
| `vision-mcp displays` | 列所有显示器及类型 | display list |
| `vision-mcp capsule <app>` | 一键 ensure + attach + migrate 到 display 工作区中心（窗口完整可见） | display + window info |
| `vision-mcp restore <app>` | 把窗口迁回主屏中央 | { ok, bounds } |
| `vision-mcp live-view <app>` | 浏览器实时查看 capsule + 接管按钮 | URL |
| `capsule.attach_window` | 把目标 app 窗口吸入 capsule | window info |
| `capsule.migrate_window` | 把窗口移到 display 工作区中心 | window info |
| `capsule.raise` | 把窗口拉回前台 | { ok } |
| `capsule.validate_geometry` | 校验几何契约（client size / DPI / foreground） | geometry state |

### 1.4 调试 / Trace

| 工具 | 用途 | 返回 |
| ---- | ---- | ---- |
| `vision-mcp trace-viewer` | 生成 HTML 时间线，每个 action 含前后截图 | { out, events_with_screenshot } |
| `vision-mcp snapshot-crop` / `snapshot-tile` | 只截 region / 切 N×M 网格；省 agent context | { ok, out } |

## 2. 任务驱动 ⭐（默认入口，路径上混合）

> **95% 时间的工作模式**。用户给具体任务时进入这里。不预先判断 map 是否完整——**直接试，失败再补**。

### 2.1 标准流程

```
# 1. 任务起点：轻量确认 state（无 PNG 进 context）
detect_state(app)

# 2. 试 workflow / perform_action 链
run_workflow(app, workflow_id, inputs)
   │
   ├─ 全程命中 map → 成功，结束时 snapshot 一次给用户
   │
   ├─ 某步失败 / state_match=null
   │     ├─ runtime 自动 repair_minimal L0–L3 → 修复 → 继续
   │     └─ repair 修不好 → snapshot 看现状
   │           │
   │           ├─ 是 map 偏差（坐标错 / action_types 顺序错）
   │           │     → vision-mcp patch --state ... --control ... --bbox-norm ...
   │           │     → 重试，patch 已生效
   │           │
   │           └─ 是 unknown state / 缺 control
   │                 → 当场探索 + 扩展 vision-mcp（小切片）：
   │                    commit_state(state_id, anchors)
   │                    把这页**几个明显 control** 一起加入 region（副产品原则）
   │                 → 继续往任务终态走
   │
   └─ 任务完成 → map 变得更完整（被使用出来）
```

### 2.2 探索副产品（关键）

任务驱动下 snapshot 已经截了，**那张图里 candidates 列表本来就包含整页元素**：

✅ **应该做**：commit_state 时把这页**几个明显 control** 一起入 baseline（不只写任务必须那一个）
✅ **应该做**：发现 sidebar 还有别的导航项，顺带加进 region.controls
✅ **应该做**：把 OCR 关键字写入 state.anchors 让下次 detect_state 更准
❌ **不应该做**：为"看其他元素"专门多 snapshot 几次 → 那是探索驱动了
❌ **不应该做**：单次任务硬塞 20 个 control 进 commit_state → 留给后续任务自然补充

**度的把握**：snapshot 已经在 context，每多记 1 个 control 几乎零成本；但每多调一次 snapshot 就是真成本。

### 2.3 反模式（成本浪费）

```
❌ 跑 5 步 workflow，每步 snapshot 一次       # 已 covered 步骤不需要看
❌ click_at 后总 snapshot 验证              # perform_action 内置 postcondition 已验证
❌ 任务驱动下 BFS 探索整个 app              # 那是探索驱动；任务驱动只走必经路径
❌ 探索 unknown 时死盯一个 element 忽略其他   # 副产品白扔了
❌ 失败时立即 snapshot                      # 先 repair_minimal；不行才看图
```

详见 `skills/vision-mcp/SKILL.md` §7。

## 3. 探索驱动（用户明确要求"探索"/"建立 vision-mcp"时）

> **一次性深度投入**。用户说"探索这个 app"/"帮我建立 X 的 vision-mcp"/"建一份 X 的地图" → 进入这里。系统覆盖所有可达 UI，把发现的 states / regions / controls / workflows 写入 `apps/<app>/vision-mcp.yaml`。

### 阶段 A：把目标 app 吸入 capsule

```
1. vision_map.init  → 在 apps/<id>/ 写一份骨架 map（仅 visual_box 配 target_window）
2. capsule.ensure_display
3. capsule.attach_window
4. capsule.migrate_window
5. capsule.validate_geometry   ← 必须 ok=true 才能继续
```

### 阶段 B：用 snapshot 边看边探索

对每个想建模的页面（比如主页 / 搜索页 / 详情页 / 播放器），重复：

```
loop {
  result = vision_map.snapshot(app_id)
  // result 包含：
  //   - image_base64：直接看截图（必要时 vlm-extract 文字 / 视觉识别）
  //   - candidates：AX 候选列表（role/name/description/bbox_norm）
  //   - state_match：与已知 state 的最佳匹配（若 score=0 说明是未建模新页）

  // agent 视觉 + 结构推断：
  //   - 截图里有什么？这是同一个 state 的变体还是全新页？
  //   - candidates 中哪些是「主操作」（搜索按钮、播放按钮、列表项）？
  //   - 哪些是装饰 / sidebar 复用元素（每页都有的）？

  if 这是新 state {
    决定 anchors（应当用最稳定的：AXTextField desc="搜索文本栏" 比 AXCell name="主页" 更稳）
    决定 controls（取 candidates 的子集，按用户视角命名）
    vision_map.commit_state(app_id, state_id, anchors, controls)
  }

  // 探索分支：选一个 candidate 试 click，看下一步是什么
  vision_map.click_at(app_id, candidate.bbox_norm center)
  // 跳到下一轮 snapshot
}
```

### 阶段 C：尝试返回路径并定义 transition

进入子页面后，agent 应主动测试如何返回，把返回方式写进 map：

```
// 已经在子页面
vision_map.press_key(combo: "Escape")
new_snap = vision_map.snapshot()
if new_snap.state_match.state_id == parent_state {
  // Escape 能返回
  vision_map.apply_patch(transition: { return_via: "Escape" })
} else {
  // 试别的
  vision_map.press_key(combo: "cmd+[")
  ...
}
```

### 阶段 D：探索完成 → 后续任务进 §2 任务驱动模式

探索完成后，agent 不需要再视觉判断每一步：

```
vision_map.run_workflow(app_id, workflow_id, inputs)
// 失败时观察 trace events
events = vision_map.export_trace(app_id)
// 若有 postcondition_failed → 通常 vision_map.repair_minimal --max-level 3 能自动解决
```

## 4. Apple Music 真实演示

### 4.1 任务驱动（map 已建好，主路径）

> §2 模式的典型实例 —— 调一条 workflow 完成完整任务，0–1 次 snapshot。

```bash
# 已经有 examples/apple-music/vision-mcp.yaml（建好的 map）
vision-mcp workflow apple-music --id search_and_play_top_song \
  --inputs '{"keyword":"张学友"}' --approve-all

# 内部自动完成：
#   sidebar.search → search_bar.input(type "张学友") → key return →
#   music.app.result_card[1]:double_click → 播放
# 全程 ~5 秒，0 次 snapshot
```

可选的工作流结束 snapshot（给用户报告时）：

```bash
vision-mcp snapshot apple-music --out /tmp/final.png
# 把 final.png 附到回报里："已开始播放，截图见附件"
```

### 4.2 探索驱动（首次建 apple-music map 时；§3 的实例）

下面是当初**建** apple-music map 时的视觉 + AX 双轨流程。**这是一次性深度投入**——建好后日常任务用 §4.1。

```bash
# 1. snapshot 看主页：返回 image_base64 + AX 候选
vision-mcp snapshot apple-music --out /tmp/home.png
# Agent 用视觉直接看 home.png：sidebar 有"搜索/主页/新发现/广播"
# AX 候选给精确 bbox：name="搜索" bbox=[0.014, 0.065, 0.141, 0.04]
# 取 bbox 中心 (0.085, 0.085) → click

vision-mcp click apple-music --norm "0.085,0.085"
vision-mcp snapshot apple-music --out /tmp/v.png       # 探索时验证每步

vision-mcp click apple-music --norm "0.481,0.033"      # AX 给的搜索框中心
vision-mcp type apple-music --text "张学友" --clear-first
vision-mcp key apple-music --combo return
vision-mcp snapshot apple-music --out /tmp/results.png # 验证结果页

# AX 给 AXCell desc="偷心" bbox=[0.341, 0.134, 0.131, 0.087] → 中心 (0.407, 0.178)
vision-mcp click apple-music --norm "0.407,0.178" --count 2

# 探索完成后 → vision_map.commit_state + 写 workflow + 切回 §4.1 执行模式
```

**实测时间：探索 ~30 步 / 20 分钟（每步 snapshot 验证）；执行 ~5 秒 / 0 snapshot。

### 4.3 **纯视觉**流程（AX 不可用时也能工作）

某些 app（游戏、自绘 UI）不暴露 AX，必须靠视觉。这里展示同样目的的纯视觉路径——**只看截图估坐标**：

```bash
vision-mcp snapshot apple-music --out /tmp/v1.png      # 只看 v1.png，不解析 AX
# Agent 看图：sidebar 左侧第 7 项是"艺人"，估计中心 ≈ (0.085, 0.305)
vision-mcp click apple-music --norm "0.085,0.305"
vision-mcp snapshot apple-music --out /tmp/v2.png      # 验证：艺人页打开了

# 如果 click 没生效（cell 密集时常见）：调坐标重试
vision-mcp click apple-music --norm "0.085,0.31"
vision-mcp snapshot apple-music --out /tmp/v3.png
```

**实测过程中真实发现的坑**：
- Sidebar 4 个紧邻 cell 每个仅 32px 高 → norm 0.04，人眼估计经常偏 1-2 cells。
- Apple Music 在搜索激活状态下，sidebar 的"主页"cell 即使 click 命中位置也不响应（应用层逻辑）。
- → 在这种边缘情况下，AX 校准 + 视觉验证 双轨流程比纯视觉/纯 AX 都稳健。

## 5. 重要细节 / 避坑

### 5.1 macOS 焦点是异步的

Click / type / key 在窗口失焦后会发到其他 app。规则：
- `vision_map.click_at` / `type_text` / `press_key` 内部已自动 `capsule.raise`。
- 但 ECMA event loop 中两次 RPC 间隔较长时仍可能失焦——必要时显式调 `capsule.raise`。

### 5.2 中文/Unicode 输入

`type_text` 在 darwin helper 中总是走 **NSPasteboard 粘贴**。System Events 的 keystroke 只能发 ASCII。
- 副作用：会暂时占用剪贴板，helper 自动备份+恢复。

### 5.3 AX 树取自首个真窗口

`window.list` 给的 handle 是 `pid:0`。当目标 app 弹 popup（如搜索建议下拉）时，helper 自动按"pid 内面积最大窗口"匹配主窗口，不会把 popup 当主窗口（避免 `client_size 397x28 ≠ 1280x800` 这种错误）。

### 5.4 容器节点的 name

Sidebar 的 AXCell `name="主页"` 由 helper 从子 AXStaticText 反推（macOS AX 本身在 cell 的 AXTitle 为空）。如果 agent 看到 AXCell name=null，多半 dump 用了 osascript 路径；切到 swift helper（默认）即可拿到。

### 5.5 何时 commit_state / commit_control

- snapshot 返回的 `state_match=null` 或 score 很低（< 0.7） → 大概率是新页面，可考虑 commit_state。
- agent 多次访问同一 page 拿到一致的 visual_hash + AX signature → 可信赖此 state，commit。
- 单页面里同类 cell（如 8 张专辑卡片）：不要每个 commit 成一个 control。用一个"first_song_card / nth_song_card" 模板，靠 AXCell index 区分。

### 5.6 返回路径的优先级（建议）

1. `Escape`：modal / popup 最常用
2. `cmd+[`：Apple 系应用的 Back（Finder / Safari / Music / Photos）
3. AX 树里 description ∈ {返回, Back, ◁, ‹, <, 上一} 的 AXButton
4. 不行就告诉用户 — 不要瞎 click

### 5.7 持续修正：把每次实测偏差固化为 patch

**核心原则**：map 永远是渐近完善的，一次探索不可能覆盖所有 corner case。Agent 在实战中遇到 map 偏差时**必须主动写 patch**，让 map 越用越好。

**何时必须写 patch**：
- 坐标偏差（命中位置错元素，如 sidebar 第 2 项实际选中第 3 项）
- action_types 顺序错（如 click 编辑区反而丢焦点 → 应让 type 默认）
- locator 命中错误（AX name 应改 description / OCR 替换 AX 等）

**一行命令写 patch**：
```bash
# 修正 bbox（最常用）
vision-mcp patch <app> --state <state_id_or_region_id> --control <id> \
  --bbox-norm x,y,w,h \
  --reason "实测命中错元素，新中心 ..."

# 修正 locator 字段（action_types / locator_priority / label 等）
vision-mcp patch <app> --state <id> --control <id> \
  --partial '{"action_types":["type","click"]}' \
  --reason "..."

# 列出已应用 patches
vision-mcp patches <app>
```

**Trust 渐进**：
- 默认 `trust=session_only`：本次会话生效。agent 跑通 workflow 后告诉用户"我发现了 X 偏差并已临时修复"。
- 用户确认后 `--trust trusted` 升级，写入 git。
- 复杂/高风险用 `--trust untrusted_proposal` 不自动应用等人审。

**实战例**（今天会话发现的真实偏差，已 patch 化）：
- `apple-music sidebar.search` 原 bbox 中心 `(0.04, 0.085)` 实际指向"主页"→ patch 改成 `(0.0, 0.05, 0.04, 0.025)` 命中真正搜索 cell
- `notes editor.focus` 原 `action_types: [click, type]` 默认 click 反而丢焦点 → patch 改为 `[type, click]`

详见 `skills/vision-mcp/SKILL.md` §6。

### 5.8 Capsule 行为：稳定窗口 + 完整可见

vision-mcp 不创建虚拟显示器（macOS / Windows public API 都不可靠）。`capsule.migrate` 把窗口固定到 display 工作区中心，**完整可见**，agent 用归一化客户区坐标操作。

**典型命令序列**：
```bash
# 1. 看可用 display
vision-mcp displays
# 输出：display-0 "Mi Monitor" ⭐ primary 1920x1080@2x (work 1920x967)

# 2. 一键 capsule（迁到 display 工作区中心）
vision-mcp capsule apple-music
# → display: display-0 (primary) bounds={x:0,y:0,w:1920,h:1080}
# → migrated to display-0: bounds={x:320,y:166,w:1280,h:800}

# 3. 操作（用归一化坐标）
vision-mcp click apple-music --norm 0.04,0.04   # sidebar 搜索
vision-mcp type apple-music --text "张学友"
vision-mcp key apple-music --combo return

# 4. macOS 高级（可选）：AX-press 对菜单/工具栏/普通按钮更稳
vision-mcp ax-press apple-music --norm 0.04,0.04

# 5. 浏览器实时看（host 或测试用）
vision-mcp live-view apple-music --port 7575 &

# 6. 任务结束，回到原始位置（可选）
vision-mcp restore apple-music
```

**ax-press 适用范围**（macOS 专属）：
- ✅ 菜单项、工具栏按钮、`AXButton` 类型的按钮
- ❌ NSTableView cell（sidebar 等）、SwiftUI 自绘元素：不响应 AXPress，仍用 `click`

## 6. MCP host 配置示例

```json
{
  "mcpServers": {
    "vision-mcp": {
      "command": "node",
      "args": [
        "/abs/path/to/vision-mcp/packages/cli/dist/index.js",
        "serve",
        "--apps-root", "/abs/path/to/apps"
      ],
      "env": {
        "VISION_MCP_NATIVE_HELPER": "/abs/path/to/vision-mcp/native/macos/vision-mcp-helper"
      }
    }
  }
}
```

第一次安装请在 `native/macos/` 下编译 helper（v0.4 起需要 ScreenCaptureKit + IOKit + Vision + CoreImage）：

```bash
cd native/macos
swiftc -O -o vision-mcp-helper src/main.swift \
  -framework AppKit -framework ApplicationServices -framework CoreGraphics \
  -framework IOKit -framework Vision -framework CoreImage \
  -framework ScreenCaptureKit
```

或者完全不编译——vision-mcp 会自动降级到 osascript adapter（慢 ~500x，但开箱即用；无 SCKit / OCR / workspace 能力）。

**权限**（系统设置 → 隐私）：
- Screen Recording：所有 capture 调用必需
- Accessibility：读写窗口、AX dump、AX-press、CGEvent 注入必需
- 第一次调用会弹系统对话框

## 7. 自动化兜底

如果 agent 不想边看边探索，仓库也提供：

- `vision-mcp record <app_id> --plan plan.json`：按预写脚本走一遍，每步输出截图+AX。
- `vision-mcp discover <app_id> --max-clicks 20 --max-depth 2`：BFS 探索全部可交互节点，自动尝试返回路径，输出 `discover.json` + draft yaml 草稿。

这两个适合作为探索前的"快速摸底"，但**最终决定 anchor / control / transition 仍然需要 agent 视觉判断**——否则会把同类元素都建模成单独 control，map 会膨胀且无意义。
