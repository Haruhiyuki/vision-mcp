# vision-mcp.yaml 字段速查

## 顶层

| 字段 | 类型 | 说明 |
| ---- | ---- | ---- |
| `version` | string | 当前固定为 `0.1`。后续不兼容变更时升级。 |
| `app` | AppDescriptor | `id`、`name`、`platform`（`windows` / `macos` / `any`）、`launch_hint`。 |
| `visual_box` | VisualBox | 见下。 |
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
| `mode` | enum | `same_session_virtual_display` / `real_window` / `existing_display` / `third_party_virtual_display`。 |
| `platform` | enum | `windows` / `macos` / `any`。 |
| `display` | GeometryContract | `width_px`, `height_px`, `scale`, `dpi_x`, `dpi_y`, `refresh_rate_hz`。 |
| `target_window` | TargetWindow | `process_name` / `title_regex` / `class_name` / `bundle_id`。 |
| `coordinate_space` | enum | 默认 `normalized_client_rect`。 |
| `contract` | ContractRules | `require_client_size_px`、`tolerate_client_size_delta_px`、`require_unminimized`、`require_foreground_for_input`、`validate_before_each_action`。 |
| `fallbacks` | enum[] | 顺序尝试的备用 mode。 |

## State

| 字段 | 说明 |
| ---- | ---- |
| `id` | 唯一 slug。 |
| `kind` | `page` / `modal` / `menu` / `tooltip` / `dialog` / `system_modal`。 |
| `anchors[]` | OCR/AX/window_title/visual_hash 多类型锚点。 |
| `match_policy` | `any_anchor` / `all_anchors` / `score`。 |
| `controls[]` | Control 列表。 |
| `variants[]` | 同状态变体（语言、皮肤）。 |
| `parent_state_id` | 父级 state（用于 modal/menu）。 |

## Control

- `id`：state 内唯一 slug。
- `role`：button / textbox / combobox / menu_item / tab / link / image / container 等。
- `action_types`：`click` / `double_click` / `right_click` / `hover` / `type` / `key` / `scroll` / `drag` / `drop` / `wait` / `noop`。**首项为默认动作**。
- `locator_priority`：按顺序尝试的 locator。命中即停。
- `visual.bbox_norm`/`center_norm`：fallback 坐标（归一化）。
- `precondition` / `postcondition`：基于 `Condition` 类型；支持 `state_should_be` / `text_should_appear` / `modal_should_close` / `control_should_exist` 等。
- `risk_level`：`safe` / `requires_confirmation` / `destructive`。
- `approval_required`：当 risk_level 触发 safety_policy 时应当为 true。

## Locator 类型

| type | 主要字段 |
| ---- | -------- |
| `accessibility` | `role`, `name`, `name_regex`, `automation_id`, `class_name` |
| `ocr_text` | `text`, `match`(`exact`/`contains`/`regex`), `min_confidence`, `search_region` |
| `nearby_text` | `text`, `direction`, `max_distance_norm`（要求控件有 `visual.bbox_norm` 作 pivot） |
| `image_patch` | `file`, `hash`, `min_similarity` |
| `bbox_norm` | `value`（兜底） |
| `vlm` | `prompt`, `hint_bbox_norm`, `cost_budget_usd`（受 safety_policy.allow_cloud_vlm 控制） |

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
