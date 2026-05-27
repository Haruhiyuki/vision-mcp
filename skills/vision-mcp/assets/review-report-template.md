# Vision-MCP 审阅报告

> 用于人类审阅 builder 产出或 runtime patch 时填写。

## 1. 基本信息

- App: `{{app_id}}`
- Reviewer: `{{reviewer}}`
- 日期: `{{date}}`
- Map 版本: `{{map_version}}`
- 相关 patches: `{{patch_ids}}`

## 2. 范围

- [ ] 新增 state：`{{state_ids}}`
- [ ] 调整 control 列表：`{{control_diff}}`
- [ ] 更新 workflow：`{{workflow_ids}}`
- [ ] 更新 repair_policy / safety_policy
- [ ] 接受/拒绝 session-only patch

## 3. 风险评估

| 控件 | risk_level | 是否需要 approval | 备注 |
| ---- | ---------- | ----------------- | ---- |
| `{{control_id}}` | `safe` / `requires_confirmation` / `destructive` | yes / no | |

## 4. Locator 复核

针对每个 control，确认至少有两类 locator（推荐顺序：accessibility → ocr_text → bbox_norm）。

| Control | locator 1 | locator 2 | bbox_norm |
| ------- | --------- | --------- | --------- |
|         |           |           |           |

## 5. 修复 patch 决策

| Patch ID | trust | 接受？ | 备注 |
| -------- | ----- | ------ | ---- |
|          |       |        |      |

## 6. 后续动作

- [ ] 把 session-only patch 升级为 trusted。
- [ ] 删除明显失效的 control。
- [ ] 在 issue 跟踪系统中记录需要 builder 重新扫描的 state。
- [ ] 安排回归运行 workflow `{{workflow_id}}`。
