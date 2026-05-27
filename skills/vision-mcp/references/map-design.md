# 建 map 实战模式（map design patterns）

> SKILL §3 探索驱动 + §2.2 副产品的"该用什么特性"配套指南。
> `schema.md` 是字段速查；本文是**何时用 / 怎么组合用 / 何时不用**。

agent 真做一次探索时，按下面 7 个 checkpoint 决定要不要用对应特性。**漏一个，map 复用价值就少一截**。

---

## 1. region 何时抽？

**抽**：跨 ≥2 个 state 共享的 UI 区域。最常见：

| 类型 | 例子 |
| ---- | ---- |
| sidebar / top_nav | 库 / 商店 / 社区 tab 都在；macOS 系统菜单栏不算（自动处理） |
| toolbar / playbar | 工具栏按钮所有页面共享；底部播放控制 |
| search_bar | 顶部全局搜索 — 几乎每个 state 都能用 |
| **kbd**（虚拟） | 把跨页快捷键收纳为可寻址 controls（见 §2） |

**不抽**：单 state 独有 — 写进 state.controls 就行。

**typical**：1-3 个 region。多了反过来增加 inherit_regions 装配复杂度。

```yaml
regions:
  - id: sidebar
    bbox_norm: [0, 0, 0.17, 1]
    controls: [...]
states:
  - id: home
    inherit_regions: [sidebar, playbar, kbd]   # ← 装配
```

---

## 2. kbd virtual region — 几乎必备

**做什么**：把所有快捷键虚拟成 0-面积 controls，让 workflow 步骤里直接 `kbd.<id>` 而非 inline combo 字符串。

```yaml
regions:
  - id: kbd
    bbox_norm: [0.5, 0.5, 0.01, 0.01]
    controls:
      - id: close_dialog
        role: button
        action_types: [key]
        locator_priority: [{ type: bbox_norm, value: [0.5, 0.5, 0.01, 0.01] }]
```

workflow 用：
```yaml
steps:
  - action_id: kbd.close_dialog
    params: { combo: "Escape" }
```

**为什么必备**：
- workflow 步骤可读性 — `kbd.save` 比 `key("ctrl+s")` 直观
- 跨平台抽象 — macOS 用 `cmd+s` / Windows 用 `ctrl+s`，写在 control.params 注释里，agent 调用时 params 覆盖（见 §6 跨平台节）
- 第三方 host 看 control list 能直接发现"哦有快捷键 save 这个能力"

只在 app 真不用快捷键时才不写（罕见）。

---

## 3. collection — 长列表 / 网格 / 双按钮对话框必用

**触发条件**（满足任一）：
1. **长列表**：sidebar 游戏列表（17 行）/ 邮件收件箱（N 行）/ 表格行 → `layout: column`
2. **卡片网格**：搜索结果 4×2 / 主页推荐 → `layout: grid, rows, cols`
3. **对话框双按钮**：[确认] [取消] 并排 → `layout: row, count: 2`

```yaml
- kind: collection
  id: game_list_row
  role: button
  action_types: [click, right_click, double_click]
  locator_priority: [{ type: bbox_norm, value: [0.0, 0.42, 0.22, 0.04] }]
  enumeration:
    layout: column    # grid / row / column
    count: 17
    cell_bbox_norm: [0.0, 0.42, 0.22, 0.04]
    spacing_y: 0.04
```

寻址：`library_home.game_list_row[3]:double_click`

**反模式**：8 张卡片写 8 条 control。map 膨胀 + patch 时要改 8 次。

**limit**：workflow.steps 的 action_id 是静态字符串，N 必须写死。运行时按变量 N 操作 → 用 `vision_map.perform_action` 直接传 action_id 字符串。

---

## 4. multi-locator — 几档？

按平台 + UI 类型决定 locator chain 长度：

| 场景 | locator 链 |
| ---- | ---------- |
| **原生 Win32 / WinForms / WPF（ERP/Office/记事本）** | `accessibility (automation_id) → accessibility (role+name) → ocr_text → bbox_norm` 4 档 |
| **原生 macOS (AppKit)** | `accessibility (role+name/description) → ocr_text → bbox_norm` 3 档 |
| **CEF / Chromium app (Steam/Discord/VS Code/Edge)** | `ocr_text (exact + min_confidence) → ocr_text (contains) → bbox_norm` 3 档；**accessibility 无效**（UIA 只看到 `Chrome_RenderWidgetHostHWND` 空壳） |
| **SwiftUI 自绘 (Notes/Apple Music 新版)** | `ocr_text → nearby_text → bbox_norm`；AX 树缺很多语义 button |
| **DirectX 游戏 / 反作弊** | `bbox_norm` 兜底 + 视觉 vlm；输入注入常被拒 |

**第一档命中率最高的放最前**：原生 Windows app 必须用 `automation_id`（不变 across UI 文案改动）；CEF 必须用 `ocr_text exact` + 高 `min_confidence`。

**bbox_norm 总是最后兜底**：UI 偏移 patch 时只动 bbox 不动其他档。

---

## 5. action_types — 顺序决定默认

**首位是默认**。

经验：
- **小按钮**（≤ 24px square in 1280×800）：`[key, click]` — 快捷键稳，小按钮 click 易 miss
- **大按钮 / 主操作**：`[click]` 或 `[click, key]`
- **输入框**：`[type, click]` — type 默认（click 反而可能丢焦点，notes/SwiftUI 编辑器常见）
- **列表行**：`[double_click, click]` 双击启动 / 单击选中
- **可右键 control**：`[click, right_click]` 加上 `right_click` 让 workflow 步骤里能 `:right_click` 后缀寻址

```yaml
- id: prev_song
  action_types: [key, click]   # 优先快捷键 cmd+left
  locator_priority: [{ type: bbox_norm, value: [...] }]

- id: editor_focus
  action_types: [type, click]  # 优先直接 type；不 click（会丢焦点）
```

---

## 6. precondition / postcondition — destructive 必备

**必加 postcondition 的场景**：
1. **destructive action**（删除 / 卸载 / 提交付款）：必须验证副作用发生才算成功
2. **跨 state 导航**（点 tab / 打开 modal）：next state 应出现
3. **modal close / dialog dismiss**：modal_should_close
4. **type 完成**：text_should_appear 验证内容真的被输入

```yaml
- id: uninstall
  risk_level: destructive
  approval_required: true
  precondition: { type: state_should_be, state_id: game_manage_submenu }
  postcondition:
    any:    # OR — 任一满足即过
      - { type: state_should_be, state_id: uninstall_confirm }
      - { type: text_should_appear, text: 您希望卸载, timeout_ms: 3000 }
```

**postcondition 类型**（schema.md §"Condition" 详）：
- `state_should_be` — 最强信号；前提是建 map 时把 next state commit 了
- `text_should_appear / disappear` — OCR 验证；适合 modal 文案变化
- `modal_should_close` — 当前 state.kind 不再是 modal/dialog
- `visual_diff_should_be { min: 0.15 }` — 至少 15% 视觉差异；"按了按钮真发生变化吗"
- `control_should_exist` / `not_exist` — recent_controls 中存在与否

**反模式**：每个 control 都设 postcondition。idempotent click（如已选中的 tab 再点）会反复失败。**只在状态变化是关键时设**。

---

## 7. risk_level + approval_required — destructive 双层安全

```yaml
- id: uninstall
  risk_level: destructive   # safe / requires_confirmation / destructive
  approval_required: true   # runtime 触发 ApprovalResolver 等用户回应
```

**判定**（参 safety_policy.forbidden_action_categories）：
- `safe` — 默认，无副作用导航 / 查看
- `requires_confirmation` — 提交表单 / 发邮件 / 改设置 / 登录
- `destructive` — 删数据 / 卸载 / 关账户 / 付款

workflow step 级也能加 `approval_required: true` — 即使 control 没标，agent 临时多一道确认。

```yaml
workflows:
  - id: uninstall_first_installed_game
    steps:
      - action_id: game_manage_submenu.uninstall
        approval_required: true   # destructive 入口必加
        on_failure: abort         # 失败绝不 ask_user 自动重试
```

---

## 8. parent_state_id + state.kind — modal/menu 嵌套

弹窗 / 菜单 / 对话框是独立 state，不是 "library_home 的一个 control"。

```yaml
states:
  - id: library_home
    kind: page

  - id: game_context_menu
    kind: menu               # 关键：runtime 知道这是临时态
    parent_state_id: library_home
    controls: [...]          # 菜单项

  - id: game_manage_submenu
    kind: menu
    parent_state_id: game_context_menu   # 套嵌

  - id: uninstall_confirm
    kind: dialog
    parent_state_id: game_manage_submenu
```

**kind 值**：`page` / `modal` / `menu` / `tooltip` / `dialog` / `system_modal`

**好处**：
- runtime 可在 parent_state_id 链上做 detect_state（菜单后看不到 library_home，但 library_home 是它的"承载状态"）
- `kbd.close_dialog` (Escape) 自动按 parent 链 pop
- agent 写 transition 时清晰：`library_home → context_menu → submenu → dialog`

---

## 9. workflow step 高级字段 — 不只是 action_id 列表

step 级支持 4 个字段：

```yaml
steps:
  - action_id: top_nav.library_tab
    on_failure: repair        # 失败时跑 repair_minimal L0-L3

  - action_id: form.submit
    approval_required: true   # 即使 control 没标 destructive，step 临时要求确认
    on_failure: ask_user      # 停下来交还用户

  - action_id: search_bar.input
    params:
      text: "{{keyword}}"     # workflow.inputs.keyword 插值
      clear_first: true       # 控件 type 的 params
```

`on_failure` 取值：
- `abort` — destructive 失败时用；不重试
- `ask_user` — 交还用户决定
- `repair` — runtime auto repair L0-L3
- `skip` — 跳过本步继续

`timeout_ms` 在 workflow 顶层：整个 workflow 的总超时。

---

## 10. {{ }} 模板：只在 step.params 生效

**核心限制**：locator 字段（`ocr_text.text` 等）固定，**不**插值。template 只在 workflow step 的 `params:` 块内生效。

```yaml
# ❌ 不能这样：locator 不插值
controls:
  - id: game_card_by_name
    locator_priority:
      - { type: ocr_text, text: "{{game_name}}" }   # 字面量"{{game_name}}"

# ✅ workflow 步骤的 params 才能
workflows:
  - id: type_search
    inputs: [{ name: keyword, type: string }]
    steps:
      - action_id: search_bar.input
        params: { text: "{{keyword}}" }   # OK
```

**动态文本目标的正确做法**：
- workflow 只覆盖固定 UI 元素
- 动态文本（"找到游戏 X"）用 `vision-mcp click-text` 命令式（agent 直接调，不放进 workflow）
- 或者用 collection[N] 配合 search 缩范围

---

## 11. safety_policy.redaction_patterns — trace 必脱敏

OCR / type params 可能包含敏感数据。trace 写到磁盘前按正则脱敏：

```yaml
safety_policy:
  redaction_patterns:
    - "(?<=密码[:：])\\S+"          # 密码字段后内容
    - "\\b\\d{16,19}\\b"             # 信用卡号
    - "\\b[A-Z0-9]{5}\\b"            # Steam Guard 5字 token
    - "76561[0-9]{12}"               # Steam profile ID
    - "(?<=Bearer\\s)[A-Za-z0-9._-]+" # API token
```

每 app 至少 2-3 条（密码 / token / 账户标识）。

---

## 12. 反模式速查（成本浪费典型）

| 反模式 | 改正 |
| ----- | ---- |
| 每个 control 都设 postcondition | 只 destructive / 跨 state 必设；idempotent click 不设 |
| 8 张卡片写 8 条 control | 一条 collection + enumeration |
| sidebar 在每个 state 重复声明 | 抽 region，inherit_regions |
| workflow inline `key("cmd+s")` | kbd region + `kbd.save` |
| 单 locator (`bbox_norm` only) | 加 ocr_text + accessibility 形成 priority chain |
| destructive action 不标 risk_level | 必加 `risk_level: destructive` + `approval_required: true` |
| 弹窗当 control 写进 parent state | 弹窗是 state（`kind: menu/dialog`）+ `parent_state_id` |
| workflow 步骤静态 N + 想跑变量 N | 用 `vision_map.perform_action action_id 字符串` 而非 workflow |
| OCR 找不到游戏 → 写 8 条 game-X control | 用 `click-text` 命令式 |

---

## 13. 建 map 的最小 checklist（按顺序问自己）

1. 主导航在哪？— 抽 region (top_nav / sidebar)
2. 有跨页快捷键吗？— 抽 kbd region
3. 有长列表 / 网格 / 双按钮吗？— collection + enumeration
4. 是 CEF / Chromium 还是原生？— 决定 locator chain
5. 这步是 destructive 吗？— risk_level + approval_required + postcondition
6. 这是个弹窗吗？— 独立 state + kind + parent_state_id
7. workflow 步骤要重试吗？— on_failure: repair / ask_user / abort
8. trace 会写敏感数据吗？— redaction_patterns

走完一遍，map 就达到 examples/example-erp 那种"完整展示架构"的覆盖度。

---

参考实战：
- `examples/example-erp/vision-mcp.yaml` — Windows 原生 WinForms hypothetical demo（accessibility locator 重）
- `examples/steam-windows/vision-mcp.yaml` — Windows CEF 实战（无 accessibility，OCR+bbox 双轨）
- `examples/apple-music/vision-mcp.yaml` — macOS region + collection
- `examples/notes/vision-mcp.yaml` — macOS SwiftUI 自绘 + kbd region 案例
