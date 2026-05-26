# Vision-MCP — Agent 使用指南

> 本文档面向 MCP host 中的 agent（Claude / Cursor / Codex 等）。介绍如何用 vision-mcp 提供的 tools「像人一样使用桌面软件」。
>
> 核心理念：**agent 在环（agent-in-the-loop）**。Vision-mcp 不是黑盒自动化脚本，而是让 agent 看截图 + 看结构化候选 → 做视觉判断 → 调用原子工具 → 把判断结果写进 vision-mcp map。

## 1. 工具总览（按使用频率排序）

| 工具 | 用途 | 返回 |
| ---- | ---- | ---- |
| `vision_map.snapshot` | **核心**：一次拿截图 + 可交互 AX 候选 + 已知 state 匹配 | base64 PNG + candidates + state_match + visual_hash |
| `vision_map.click_at` | 在归一化坐标 click（建图原始动作） | { ok, point_screen } |
| `vision_map.type_text` | 在当前焦点 type 文本（支持中文，走粘贴） | { ok, length } |
| `vision_map.press_key` | 发键盘组合（return / cmd+f / Escape / cmd+left ...） | { ok } |
| `vision_map.scroll` | 在归一化点滚动 | { ok } |
| `capsule.attach_window` | 把目标 app 窗口吸入 capsule | window info |
| `capsule.migrate_window` | 把窗口固定到 capsule display | window info |
| `capsule.raise` | 把窗口拉回前台（type/key 前可主动调用） | { ok } |
| `capsule.validate_geometry` | 校验几何契约（client size / DPI / foreground） | geometry state |
| `vision_map.detect_state` | 仅做 state 识别，不返回截图（snapshot 的轻量版） | state_match |
| `vision_map.commit_state` | 把当前帧的 AX 状态写入 map.baseline | { state_id } |
| `vision_map.apply_patch` | 写入 control_bbox / geometry / state patch | patch file path |
| `vision_map.perform_action` | 通过已定义的 action_id 操作（成品 workflow 模式） | result + events |
| `vision_map.run_workflow` | 跑一条 workflow（多步） | result + steps |
| `vision_map.repair_minimal` | 触发 L0-L3 修复 ladder | repair outcome |

## 2. Agent 主导建图的标准流程

### 阶段 A：把目标 app 吸入 capsule

```
1. vision_map.init  → 在 apps/<id>/ 写一份骨架 map（仅 visual_box 配 target_window）
2. capsule.ensure_display
3. capsule.attach_window
4. capsule.migrate_window
5. capsule.validate_geometry   ← 必须 ok=true 才能继续
```

### 阶段 B：用 snapshot 边看边建图

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

### 阶段 D：用成品 workflow 复用建好的 map

建图完成后，agent 不需要再视觉判断每一步：

```
vision_map.run_workflow(app_id, workflow_id, inputs)
// 失败时观察 trace events
events = vision_map.export_trace(app_id)
// 若有 postcondition_failed → 通常 vision_map.repair_minimal --max-level 3 能自动解决
```

## 3. Apple Music 真实演示

这是仓库自带的演示（`apps/apple-music/vision-mcp.yaml`）。Agent 完成"播放一首张学友的歌"的完整步骤：

```bash
# 1. snapshot 看主页
vision-mcp snapshot apple-music --out /tmp/home.png --max-candidates 30
# 截图显示主页 + AX 候选中能看到 sidebar 'name="搜索"' bbox=[0.014, 0.065, 0.141, 0.04]

# 2. agent 看 AX：sidebar 搜索 cell center ≈ (0.085, 0.085)
vision-mcp click apple-music --norm "0.085,0.085"

# 3. snapshot 验证进入搜索页（state_match=music.search）
vision-mcp snapshot apple-music --out /tmp/search.png
# 看到 AXTextField desc="搜索文本栏" bbox=[0.318, 0.009, 0.326, 0.048] → 中心 (0.481, 0.033)

# 4. click 搜索框 + type 中文
vision-mcp click apple-music --norm "0.481,0.033"
vision-mcp type apple-music --text "张学友" --clear-first
vision-mcp key apple-music --combo return

# 5. snapshot 验证搜索结果页（state_match=music.search_results）
vision-mcp snapshot apple-music --out /tmp/results.png
# 候选中能看到 AXCell desc="偷心" bbox=[0.341, 0.134, 0.131, 0.087] → 中心 (0.407, 0.178)

# 6. 双击「偷心」播放
vision-mcp click apple-music --norm "0.407,0.178" --count 2

# 7. 1 秒后 snapshot 验证
vision-mcp snapshot apple-music --out /tmp/playing.png
# 底部播放栏显示 "偷心 - 张学友 - 偷心"
```

**实测时间（macOS 26，含 swift native helper）：每条命令 < 2s，全流程约 15 秒**。

## 4. 重要细节 / 避坑

### 4.1 macOS 焦点是异步的

Click / type / key 在窗口失焦后会发到其他 app。规则：
- `vision_map.click_at` / `type_text` / `press_key` 内部已自动 `capsule.raise`。
- 但 ECMA event loop 中两次 RPC 间隔较长时仍可能失焦——必要时显式调 `capsule.raise`。

### 4.2 中文/Unicode 输入

`type_text` 在 darwin helper 中总是走 **NSPasteboard 粘贴**。System Events 的 keystroke 只能发 ASCII。
- 副作用：会暂时占用剪贴板，helper 自动备份+恢复。

### 4.3 AX 树取自首个真窗口

`window.list` 给的 handle 是 `pid:0`。当目标 app 弹 popup（如搜索建议下拉）时，helper 自动按"pid 内面积最大窗口"匹配主窗口，不会把 popup 当主窗口（避免 `client_size 397x28 ≠ 1280x800` 这种错误）。

### 4.4 容器节点的 name

Sidebar 的 AXCell `name="主页"` 由 helper 从子 AXStaticText 反推（macOS AX 本身在 cell 的 AXTitle 为空）。如果 agent 看到 AXCell name=null，多半 dump 用了 osascript 路径；切到 swift helper（默认）即可拿到。

### 4.5 何时 commit_state / commit_control

- snapshot 返回的 `state_match=null` 或 score 很低（< 0.7） → 大概率是新页面，可考虑 commit_state。
- agent 多次访问同一 page 拿到一致的 visual_hash + AX signature → 可信赖此 state，commit。
- 单页面里同类 cell（如 8 张专辑卡片）：不要每个 commit 成一个 control。用一个"first_song_card / nth_song_card" 模板，靠 AXCell index 区分。

### 4.6 返回路径的优先级（建议）

1. `Escape`：modal / popup 最常用
2. `cmd+[`：Apple 系应用的 Back（Finder / Safari / Music / Photos）
3. AX 树里 description ∈ {返回, Back, ◁, ‹, <, 上一} 的 AXButton
4. 不行就告诉用户 — 不要瞎 click

## 5. MCP host 配置示例

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

第一次安装请在 `native/macos/` 下编译 helper：

```bash
cd native/macos
swiftc -O -o vision-mcp-helper src/main.swift \
  -framework AppKit -framework ApplicationServices -framework CoreGraphics
```

或者完全不编译——vision-mcp 会自动降级到 osascript adapter（慢 ~500x，但开箱即用）。

## 6. 自动化兜底

如果 agent 不想边看边建图，仓库也提供：

- `vision-mcp record <app_id> --plan plan.json`：按预写脚本走一遍，每步输出截图+AX。
- `vision-mcp discover <app_id> --max-clicks 20 --max-depth 2`：BFS 探索全部可交互节点，自动尝试返回路径，输出 `discover.json` + draft yaml 草稿。

这两个适合作为建图前的"快速摸底"，但**最终决定 anchor / control / transition 仍然需要 agent 视觉判断**——否则会把同类元素都建模成单独 control，map 会膨胀且无意义。
