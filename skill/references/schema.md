# vision-mcp.yaml 字段速查

## 顶层

| 字段 | 类型 | 说明 |
| ---- | ---- | ---- |
| `version` | string | 当前固定为 `0.1`。后续不兼容变更时升级。 |
| `app` | AppDescriptor | `id`、`name`、`platform`（`windows` / `macos` / `any`）、`launch_hint`。 |
| `visual_box` | VisualBox | 见下。 |
| `regions[]` | Region[] | **跨 state 共享的 UI 区域**（sidebar / playbar / toolbar）。state 通过 `inherit_regions` 引用。**强烈推荐使用**：解决 sidebar/playbar 在每个 state 重复定义。 |
| `states[]` | State[] | 状态图节点。 |
| `transitions[]` | Transition[] | 显式 state 转移；用于 builder 自动学习。 |
| `workflows[]` | Workflow[] | 用户级流程。 |
| `repair_policy` | RepairPolicy | 控制 L0–L6 行为。 |
| `safety_policy` | SafetyPolicy | 风险等级、脱敏、云端 VLM 开关。 |
| `input_lease_policy` | InputLeasePolicy | lease 默认时长、打断策略。 |
| `metadata` | object | 构建元信息。 |

## VisualBox

| 字段 | 类型 | 说明 |
| ---- | ---- | ---- |
| `id` | string | capsule 实例标识。 |
| `mode` | enum | `same_session_virtual_display` / `real_window` / `existing_display` / `third_party_virtual_display` / **`off_screen`**（v0.4 新增，macOS：合成屏外 workspace）。 |
| `platform` | enum | `windows` / `macos` / `any`。 |
| `display` | GeometryContract | `width_px`, `height_px`, `scale`, `dpi_x`, `dpi_y`, `refresh_rate_hz`。 |
| `target_window` | TargetWindow | `process_name` / `title_regex` / `class_name` / `bundle_id`。 |
| `coordinate_space` | enum | 默认 `normalized_client_rect`。 |
| `contract` | ContractRules | `require_client_size_px`、`tolerate_client_size_delta_px`、`require_unminimized`、`require_foreground_for_input`、`validate_before_each_action`。 |
| `fallbacks` | enum[] | 顺序尝试的备用 mode。如包含 `off_screen` 等价于 `allowOffScreen=true`。 |

## EnsureDisplayOptions（runtime 参数）

调用 `capsule.ensure_display()` / `Capsule.ensureDisplay()` 时使用：

| 字段 | 类型 | 说明 |
| ---- | ---- | ---- |
| `mode` | CapsuleMode | 期望模式（见上） |
| `geometry` | GeometryContract | 期望 client 尺寸 / scale / DPI |
| `fallbacks` | CapsuleMode[] | 主模式失败时按序尝试 |
| `allowOffScreen` (v0.4) | boolean | macOS 专用：没有真实副屏时是否合成屏外 workspace。默认 false。 |

## DisplayInfo（v0.4 扩展）

| 字段 | 类型 | 说明 |
| ---- | ---- | ---- |
| `id` | string | `display-N` 索引；off-screen workspace 为 `off-screen-workspace`。 |
| `bounds` / `work_area` | RectPx | 总尺寸 / 减去 menubar 后可用区域。 |
| `scale` / `dpi_x` / `dpi_y` / `refresh_rate_hz` | number | 显示器参数。 |
| `is_primary` / `is_virtual` | boolean | 兼容字段。 |
| `kind` (v0.4) | DisplayKind | `primary` / `extended` / `mirror` / `sidecar` / `airplay` / `virtual` / `unknown`。 |
| `name` (v0.4) | string? | `NSScreen.localizedName` / Windows monitor friendly name。 |
| `vendor` / `product` (v0.4) | string? | EDID vendor / product ID。 |
| `recommended_for_workspace` (v0.4) | boolean? | runtime 判定：是否适合做 agent workspace。 |
| `native_handle` | string? | `CGDirectDisplayID` / `HMONITOR` 字符串。 |

`DisplayKind` 评分（用于 `pickWorkspaceDisplay`）：virtual=100, sidecar=80, airplay=70, extended=50, primary=10, mirror=0, unknown=30。详见 `references/platform-macos.md` §3.1。

## InputClickOptions（v0.4 扩展）

`capsule.click_at` / `vision_map.click_at` / CLI `click --cursor` 接受：

| 字段 | 类型 | 说明 |
| ---- | ---- | ---- |
| `button` | enum | `left` / `right` / `middle`。 |
| `modifiers` | enum[] | `ctrl` / `shift` / `alt` / `meta`。 |
| `click_count` | number | 双击传 2。 |
| `cursor_mode` (v0.4) | enum | macOS 专用：`physical` (默认) / `virtual` (warp_restore) / `virtual_no_warp` / `ax_press`。 |
| `try_ax_press` (v0.4) | boolean | 先试 AX-press，失败 fallback CGEvent。完全不动鼠标的捷径。 |

`virtual` 模式：用户主屏物理光标在 click 完成后被 `CGWarpMouseCursorPosition` 还原到原位，看起来"鼠标没动"。
`ax_press` 模式：完全用 AX API，不发任何 mouse event；屏外/半屏外窗口必用此模式。

## Region（v0.3 新增）

跨多个 state 共享的 UI 区域，例如 macOS app 几乎所有页面共享的 sidebar 与底部播放栏。
state 通过 `inherit_regions: [sidebar, playbar]` 引用，免去在每个 state 重复声明。

```yaml
regions:
  - id: sidebar
    description: 左侧导航栏，所有 state 共享
    bbox_norm: [0, 0, 0.17, 1]    # 可选：region 在 client_rect 内的范围
    controls:
      - id: home
        role: button
        action_types: [click]
        locator_priority: [{ type: bbox_norm, value: [0.02, 0.105, 0.04, 0.03] }]

states:
  - id: music.app
    inherit_regions: [sidebar, playbar]
    controls: [...]  # 仅本 state 独有的 controls
```

action_id 形式：
- `<state>.<control>` — state 自有 control（也会按需 fallback 到 inherited region）
- `<region>.<control>` — 直接寻址 region 内 control（如 `sidebar.home`）

约束：region_id 与 state_id 不能同名（避免解析歧义）。

## State

| 字段 | 说明 |
| ---- | ---- |
| `id` | 唯一 slug。 |
| `kind` | `page` / `modal` / `menu` / `tooltip` / `dialog` / `system_modal`。 |
| `anchors[]` | OCR/AX/window_title/visual_hash 多类型锚点。 |
| `match_policy` | `any_anchor` / `all_anchors` / `score`。 |
| `controls[]` | Control 列表。 |
| `inherit_regions[]` | **v0.3 新增**：引用顶层 `regions[]` id 列表，"装配"该 state 上的全局 controls。 |
| `variants[]` | 同状态变体（语言、皮肤）。 |
| `parent_state_id` | 父级 state（用于 modal/menu）。 |

## Control

- `kind`：`control`（默认）或 `collection`（v0.3 新增，描述一组同质 cell，见下）。
- `id`：state 内唯一 slug。
- `role`：button / textbox / combobox / menu_item / tab / link / image / container 等。
- `action_types`：`click` / `double_click` / `right_click` / `hover` / `type` / `key` / `scroll` / `drag` / `drop` / `wait` / `noop`。**首项为默认动作**。
- `locator_priority`：按顺序尝试的 locator。命中即停。
- `visual.bbox_norm`/`center_norm`：fallback 坐标（归一化）。
- `precondition` / `postcondition`：基于 `Condition` 类型；支持 `state_should_be` / `text_should_appear` / `modal_should_close` / `control_should_exist` / `visual_diff_should_be` / `ocr_should_appear` 等。
- `risk_level`：`safe` / `requires_confirmation` / `destructive`。
- `approval_required`：当 risk_level 触发 safety_policy 时应当为 true。
- `enumeration`（仅 collection）：`{layout: grid|row|column, rows, cols, count, cell_bbox_norm, spacing_x, spacing_y}`。

## ControlCollection（v0.3 新增）

把"4×2 网格卡片"这类同质元素声明为一条而非 8 条 control：

```yaml
- kind: collection
  id: result_card
  role: button
  action_types: [click, double_click]
  locator_priority: [{ type: bbox_norm, value: [0.195, 0.135, 0.13, 0.087] }]
  enumeration:
    layout: grid           # grid | row | column
    rows: 2
    cols: 4
    cell_bbox_norm: [0.195, 0.135, 0.13, 0.087]   # 第 1 个 cell 的 bbox
    spacing_x: 0.145        # 相邻 cell x 间距
    spacing_y: 0.13         # 行间距
```

寻址：action_id `<state>.<collection_id>[N]:<action_type>` 例如 `music.app.result_card[5]:double_click`。
runtime 按 enumeration 把 N 解到具体 cell 的 bbox。

## Locator 类型

| type | 主要字段 |
| ---- | -------- |
| `accessibility` | `role`, `name`, `name_regex`, `name_not`, `automation_id`, `class_name`, `description`, `description_regex`, `description_not`, `index` |
| `ocr_text` | `text`, `match`(`exact`/`contains`/`regex`), `min_confidence`, `search_region` |
| `nearby_text` | `text`, `direction`, `max_distance_norm`（要求控件有 `visual.bbox_norm` 作 pivot） |
| `image_patch` | `file`, `hash`, `min_similarity` |
| `bbox_norm` | `value`（兜底） |
| `vlm` | `prompt`, `hint_bbox_norm`, `cost_budget_usd`（受 safety_policy.allow_cloud_vlm 控制） |

## Condition / Postcondition 类型

| type | 用途 |
| ---- | ---- |
| `state_should_be` | `state_id` 应为指定值 |
| `text_should_appear` | OCR/AX name 中应出现 text（向后兼容，语义模糊） |
| `text_should_disappear` | 反向 |
| `window_title_should_match` | 窗口 title regex 匹配 |
| `modal_should_close` | 当前 state.kind 不再是 modal/dialog/system_modal |
| `control_should_exist` / `control_should_not_exist` | recent_controls 中存在/不存在 |
| `visual_similar_should_be` | 当前 frame 与某 state 的 visual_hash 相似度 ≥ 阈值 |
| **`visual_diff_should_be`** (v0.3) | click 前后 dHash 差异 ≥ 阈值；用于"按了按钮真的发生变化吗"的轻量视觉验证 |
| **`ocr_should_appear`** (v0.3) | 明确依赖 OCR provider 找文字；比 text_should_appear 语义清晰 |

## Workflow

```yaml
workflows:
  - id: create_invoice
    inputs:
      - name: customer_name
      - name: amount
    steps:
      - action_id: invoice.customer_name
        params: { text: "{{customer_name}}" }
      - action_id: invoice.submit
        approval_required: true
        on_failure: ask_user
```

`on_failure`：`abort` / `skip` / `repair` / `ask_user`。

## Patch

- `kind=geometry_profile`：覆盖 display 尺寸/scale/DPI。
- `kind=control_bbox`：替换控件 bbox + 自动重算 center；同步覆盖 locator_priority 中的 `bbox_norm`。
- `kind=control_locator`：部分覆盖 control 字段。
- `kind=state`：新增/替换/删除整个 state。

`trust`：`trusted`（仓库受信任）/ `session_only`（仅当前会话）/ `untrusted_proposal`（不自动应用，等人类审阅）。

完整 JSON Schema：`assets/vision-mcp.schema.json`。
