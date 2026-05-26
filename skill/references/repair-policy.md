# Repair Policy 参考

Vision-MCP 的 repair 引擎按 §12 设计的“最小成本修复阶梯”工作：先尝试低成本动作，仅在低级修复无效时升级。**agent 必须以 `vision_map.repair_minimal` 调用 runtime 来执行修复，不要绕过该工具自行决定。**

## 阶梯

| Level | 名称 | 触发条件 | 是否修改 map | 工具 |
| ----- | ---- | -------- | ------------ | ---- |
| L0 | Recompute Transform | 窗口原点漂移但 client size/DPI 未变 | 否 | runtime 内部，调用 `vision_map.repair_minimal --max-level 0` |
| L1 | Restore Geometry | 窗口被移动、缩放、最小化、移出 capsule | 否 | `vision_map.repair_minimal --max-level 1` |
| L2 | Update Geometry Profile | 分辨率轻微变化，anchor 残差小 | 写 geometry_profile patch | `vision_map.repair_minimal --max-level 2` |
| L3 | Relocate Control | 单控件位移在阈值内（默认 `max_bbox_shift_norm=0.08`，`confidence_threshold=0.92`） | 写 control_bbox patch | `vision_map.perform_action` 内部自动尝试；显式触发用 `vision_map.repair_minimal --max-level 3` |
| L4 | Patch State | 弹窗 / 菜单 / 折叠侧栏导致 state 部分变化 | 写 state patch | **不自动**：agent 应描述变化并请人类确认 |
| L5 | Rescan Current State | 当前页面版本明显变化 | 重建该 state | 由 `vision_map.commit_state` 写回 |
| L6 | Rebuild Map | 应用版本/语言/权限大变 | 新 map 版本 | 走 `vision_map.init` 重建 |

## 决策阈值（map.repair_policy）

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

低于阈值的修复会被丢回成 `untrusted_proposal` patch，需要人类审阅。

## 必须停下来的情况

- `destructive_actions.auto_repair_before_action=false` 且本次动作是 `destructive`。
- 修复结果会把动作目标从低风险控件迁到高风险控件（locator 命中文字与原 label 语义不一致）。
- 出现 system_modal / 验证码 / 登录异常 / 权限弹窗：禁止任何自动修复。
- 当前截图与已知 state 的相似度全部低于 `state.min_visual_similarity` 与 `min_ocr_similarity`。

## Patch 生命周期

1. runtime 修复后写 `patches/<date>-<slug>.yaml`，trust 默认 `session_only`。
2. 人类审阅后，可通过 `vision_map.apply_patch` 改写 trust 为 `trusted` 并 commit 到 repo。
3. 长期失效的 patch（`expires_at` 到期）会被忽略；agent 不应假设临时 patch 永久有效。
