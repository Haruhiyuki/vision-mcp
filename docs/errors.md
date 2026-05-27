# 错误码

所有 runtime / MCP 工具 / repair 操作的错误都通过 `VisionMcpError` 抛出，含以下字段：

```ts
{
  name: "VisionMcpError",
  code: ErrorCode,
  message: string,
  details?: object,
  recoverable?: boolean,
}
```

`recoverable=true` 表示 agent 可以尝试 `vision_map.repair_minimal` 或重试；否则需要人类介入。

| 错误码 | 含义 | 默认处理建议 |
| ------ | ---- | ------------ |
| `CAPSULE_DISPLAY_MISSING` | capsule 显示器不存在 / 已断开 / **无合适 workspace** (v0.4) | macOS：检查是否连接副屏 / 启用 Sidecar / 装 BetterDisplay；或重试 `capsule.ensure_display({ allowOffScreen: true })` 启用屏外 workspace。Windows：检查 IDD 驱动。`details.scored` 含 pickWorkspaceDisplay 的评分细节。 |
| `CAPSULE_PLATFORM_UNAVAILABLE` | native helper 未找到 / 启动失败 | 检查 `VISION_MCP_NATIVE_HELPER` 是否指向 helper；或设置 `VISION_MCP_FALLBACK_MOCK=1` 用 mock 调试。 |
| `WINDOW_NOT_FOUND` | 目标窗口不存在或已关闭 | 提示用户重新打开/登录目标软件，再调用 `capsule.attach_window`。 |
| `WINDOW_MIGRATION_FAILED` | SetWindowPos / AX setBounds 失败 | 降级 Real-window Capsule；记录 `unsupported window` 标志。 |
| `GEOMETRY_MISMATCH` | 几何契约不满足 | 先尝试 `vision_map.repair_minimal --max-level 1`；若 DPI/scale 仍不匹配则暂停。 |
| `STATE_UNKNOWN` | 当前 frame 无法匹配任何已知 state | 请求 agent / 用户确认；可触发 L5 局部重扫（`vision_map.commit_state`）。 |
| `ACTION_NOT_FOUND` | `action_id` 或 `workflow_id` 不存在 | 校验 map：`vision-mcp describe <app_id>`。 |
| `ACTION_RISK_REQUIRES_CONFIRMATION` | 风险等级要求人类批准 | 通过 host 审批通道获取批准；agent 不应自行重试。 |
| `POSTCONDITION_FAILED` | 动作执行后未通过校验 | runtime 已自动尝试 L3 relocation；失败时建议 `vision_map.repair_minimal --max-level 3`。 |
| `PRECONDITION_FAILED` | 当前 state 与控件 precondition 不一致 | 重新调用 `vision_map.detect_state`；通过 `transition` 找到正确路径。 |
| `PERMISSION_DENIED` | 缺少截图 / 输入 / accessibility 权限 | 展示 `docs/permissions.md` 的引导。 |
| `REPAIR_LOW_CONFIDENCE` | 修复置信度低于阈值 | 不自动应用 patch；展示候选给用户审阅。 |
| `REPAIR_NOT_APPLICABLE` | 修复阶梯无法处理（例如 L4+ 状态新增） | 提示人类执行 builder 流程。 |
| `INPUT_LEASE_BROKEN` | 用户接管 / 热键 / 几何违规导致 lease 失效 | 暂停 workflow，重新调用 `capsule.validate_geometry` 与 `vision_map.detect_state`。 |
| `INPUT_LEASE_DENIED` | 已有有效 lease | 等待或主动 `breakLease`。 |
| `LOCATOR_FAILED` | 所有 locator 都未命中 | 触发 L3 relocate；仍失败则交给 builder。 |
| `MAP_VALIDATION_FAILED` | YAML 结构 / Zod 校验失败 | 修复 vision-mcp.yaml；运行 `vision-mcp validate`。 |
| `SAFETY_POLICY_BLOCKED` | 动作属于禁止类别 | 不要尝试绕过；交给用户决定。 |
| `UNSUPPORTED_PLATFORM` | 当前 OS 不在 windows/macos/mock 之一 | 仅支持 Windows / macOS；Linux 不在首发范围。 |
| `UNKNOWN` | 未归类异常 | 上报 issue；记录 trace 后停止。 |

## 错误流转图

```
perform_action
  ├─ geometry check failed
  │     ↓ recoverable
  │     repair L0/L1  ── ok ──→ retry
  │     └─ still failing → GEOMETRY_MISMATCH (recoverable=true)
  ├─ approval denied → ACTION_RISK_REQUIRES_CONFIRMATION
  ├─ locator failed → L3 relocate
  │     └─ low confidence → LOCATOR_FAILED (recoverable=true)
  └─ postcondition failed
        ↓
        repair_minimal max=3
        └─ still failing → POSTCONDITION_FAILED (recoverable=true)
```
