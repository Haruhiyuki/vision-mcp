# 工作流：用户意图 + 路径上混合

SKILL §1-2 的扩展。给出决策树、副产品原则、反模式与长任务封装习惯。

> **术语**：本文档"探索"指 agent 看 UI、点试、记录的动作；产出物是 `vision-mcp.yaml`（即"建立 vision-mcp" / map）。

## 1. 用户意图决定入口

| 用户说什么 | 意图 | agent 进入 |
| ---------- | ---- | ---------- |
| 「打开 Apple Music 播一首张学友」/「按内存排序看占用最高的进程」 | **任务驱动** ⭐（默认） | §2 混合工作流 |
| 「探索一下这个 app」/「帮我建立 X 的 vision-mcp」/「建一份 X 的地图」 | **探索驱动** | §3 系统探索 |

**判别要点**：
- 任务驱动有**明确终态**（"播了" / "写完了" / "看到答案"）
- 探索驱动是**开放式**（"看看有什么" / "建好待后续用"），产出是新建或扩展的 vision-mcp

不确定时按任务驱动办；agent 在路径上发现"vision-mcp 严重不足"应主动告诉用户"是否切到探索模式补完整？"

## 2. 任务驱动：路径上按需混合

> **不预先判断 vision-mcp 是否完整**，直接试，遇缺失当场补。

```
detect_state                          # 起点轻量确认（无 PNG）
   ↓
run_workflow / perform_action 链
   ↓
   ├─ 全程命中 vision-mcp → ✅ 完成（结束 snapshot 一次给用户报告）
   │
   ├─ 某步失败 / state_match=null
   │     ├─ runtime auto repair_minimal L0-L3 → 修好 → 继续
   │     └─ 修不好 → snapshot 看现状
   │           ├─ vision-mcp 偏差 → `vision-mcp patch` 一行固化 → 重试
   │           └─ unknown state → 当场探索 + 扩展 vision-mcp 小切片：
   │                 commit_state(anchors + 关键 controls)
   │                 顺带在已有 snapshot 上记副产品（§4）
   │                 → 继续往任务终态走
   ↓
任务完成时 vision-mcp 比开始时更完整
```

**关键约束**：
- 探索范围**仅限任务必经路径**——不深挖未访问过的菜单/子页
- patch / commit_state 都**当场**写入，下次跑同任务直接命中
- snapshot 用最少次数

## 3. 探索驱动：系统覆盖建立 vision-mcp

> 用户明确要求"探索" / "建立 vision-mcp"时进入。**一次性深度投入**。

```
1. capsule attach + migrate
2. BFS 探索每个可达 state：
     for 每个入口 state：
       snapshot + annotated 看完整画面
       识别 sidebar / toolbar / 主内容 / 弹窗
       决定哪些是共享 region（跨 state 复用）
       commit_state（含 anchors + 关键 controls）→ 写入 vision-mcp
       探索每个可点 control 的下一个 state
       记录返回路径（Escape / cmd+[ / 后退按钮）
3. 抽象重复模式为 collection / inherit_regions
4. 写代表性 workflows（用户后续可能要用的）
```

产出物：完整的 `apps/<app>/vision-mcp.yaml`，含 states / regions / workflows / transitions，agent 后续任务可直接 `run_workflow` 命中。

## 4. 探索副产品：snapshot 已截了，顺带记不浪费

任务驱动遇 unknown 时不可避免要 snapshot。**那张图里 candidates 列表本来就含整页元素**：

✅ commit_state 时把这页**几个明显的关键 control 一起**写入 vision-mcp（不只写任务必须那一个）
✅ 发现 sidebar 还有别的导航项，顺带在 region.controls 加几个
✅ 把 OCR 关键字写入 state.anchors 让下次 detect_state 更准

❌ 为"看其他元素"专门多 snapshot 几次 → 那是探索驱动
❌ 单次任务硬塞 20 个 control 进 commit_state → 留给后续任务自然补充

**度的把握**：snapshot 已经在 context，每多记 1 个 control 几乎零成本；但每多调一次 snapshot 就是真成本。

## 5. snapshot 仅在 4 个时机（任务驱动下）

1. **任务起点** — `detect_state` 轻量版（无 PNG）；不确定 state 时才 `snapshot` 拿 PNG
2. **关键决策节点** — workflow 含"看后选 N"语义（如挑列表第几项）
3. **失败诊断** — `repair_minimal` 修不好时看现状，决定 patch / commit_state / 告诉用户
4. **任务结束** — 给用户的"已完成"回报截图

## 6. 反模式（成本浪费典型）

❌ 跑 5 步 workflow，每步 `snapshot` 一次 — 已 covered 步骤不需要
❌ `click_at` 完成后总 `snapshot` 验证 — `perform_action` 内置 postcondition 已验证
❌ 任务驱动下 BFS 探索整个 app — 那是探索驱动；任务驱动只走必经路径
❌ 探索 unknown 时死盯一个 element，忽略 snapshot 里其他 candidates — 副产品白扔了
❌ 失败时立即 `snapshot` — 先 `repair_minimal`；不行才看图

## 7. 长任务的封装习惯

任务路径涉及 8+ 步骤还要"看后判断"时，缺**子工作流抽象**：
- 拆"看后判断"为独立小 workflow（每段 3–5 步）
- agent 在两个小 workflow 之间做视觉判断，不在 workflow 内部
- 同类元素用 `collection[N]` 索引

## 8. 视觉为主路径的优先级（遇 unknown / 失败时）

- 第一选择 — **视觉**：snapshot 拿 PNG，自己看图估归一化坐标；不确定时用 `annotated` 拿"网格 + #N 候选框"
- 第二选择 — **AX/OCR 校准**：原生 app 的 AX candidates 给精确 bbox；CEF/自绘 UI 用 OCR (`click-text` / `recognize_window`)
- 第三选择 — **失败重试**：click 没生效 → snapshot 再看 → 调坐标
- **AX-press**（macOS / Windows 通用）：有 `InvokePattern` 的元素（菜单/工具栏/普通按钮）可用 `ax-press` 零鼠标干预
  - **macOS** 不适用：NSTableView cell / SwiftUI 自绘元素
  - **Windows** 不适用：CEF/Chromium 网页内容（UIA 空壳）+ DirectX 游戏自绘 UI

## 9. workflow step 高级字段（建 workflow 时易漏）

step 是 `{ action_id, params?, approval_required?, on_failure?, timeout_ms? }` 而不是只有 action_id：

```yaml
steps:
  - action_id: top_nav.library_tab
    on_failure: repair          # 失败 runtime 跑 repair_minimal L0-L3
  - action_id: game_submenu.uninstall
    approval_required: true     # destructive：step 级临时确认
    on_failure: abort           # destructive 失败绝不重试
  - action_id: search_bar.input
    params:
      text: "{{keyword}}"       # workflow.inputs.keyword 插值
      clear_first: true
```

`on_failure`：`abort` (destructive 用) / `ask_user` / `repair` / `skip`

**关键陷阱：`{{}}` 模板只在 step.params 生效**，**不**在 control.locator 里插值。动态文本目标（"找到游戏 X"）走 `click-text` 命令式，workflow 只覆盖固定 UI 元素。详 [`map-design.md §10`](map-design.md)。

## 10. 跨平台 workflow

modifier 键和快捷键命名按平台不同（cmd vs ctrl / cmd+[ vs alt+left）。两种写法：

**方式 A**：control 不绑 combo，step.params 按平台传

```yaml
regions:
  - id: kbd
    controls:
      - id: save
        role: button
        action_types: [key]
        locator_priority: [{ type: bbox_norm, value: [0.5, 0.5, 0.01, 0.01] }]

workflows:
  - id: save_doc
    steps:
      - action_id: kbd.save
        params: { combo: "ctrl+s" }   # Windows；macOS 改 "cmd+s"
```

**方式 B**：`app.platform: any` + 分别写两条 workflow

```yaml
workflows:
  - id: save_doc_macos
    steps:
      - action_id: kbd.save
        params: { combo: "cmd+s" }
  - id: save_doc_windows
    steps:
      - action_id: kbd.save
        params: { combo: "ctrl+s" }
```

agent 按 `app.platform` 选 workflow。详细差异 SKILL §8。
