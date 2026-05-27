# 权限清单与用户提示

设计文档 §15 给出权限模型，本文给出与本仓库实现对齐的具体清单与提示话术。

## 1. 权限矩阵

| 平台 | 权限 | 用途 | 用户提示 |
| ---- | ---- | ---- | -------- |
| Windows | 管理员（首次安装 IDD 驱动） | 创建 same-session virtual display | "Vision-MCP 需要安装签名的虚拟显示器驱动。它仅用于把 agent 操作放在专用显示器上，不会拦截系统输入。安装后可在控制面板中卸载。" |
| Windows | 用户级（运行 helper） | 窗口枚举、捕获、输入 | "Vision-MCP 将在你许可的应用范围内捕获窗口与发送输入。" |
| Windows | Windows.Graphics.Capture | 捕获窗口 / 显示器 | 系统会显示捕获提示边框；不要关闭它。 |
| Windows | UI Automation | 控件结构化访问 | 默认开启；某些 elevated app 需要 helper 同级权限。 |
| macOS | Screen Recording | 捕获窗口 / 显示器（含 ScreenCaptureKit 抓屏外窗口） | "首次使用请到 系统设置 → 隐私 → 屏幕录制 中勾选 vision-mcp-helper。" |
| macOS | Accessibility | 读取 / 移动窗口、点击、输入；**AX-press 操作屏外元素** | "请到 系统设置 → 隐私 → 辅助功能 中勾选 vision-mcp-helper。AX 是 off_screen workspace 下唯一能可靠操作窗口的途径。" |
| macOS | Automation / Apple Events | 通过 AppleScript 控制菜单 | 仅在 osascript fallback 路径用；按 app 单独授权。 |
| macOS | Input Monitoring | 监听用户输入打断 lease | 可选；未授予时降级为基于热键打断。 |

> **重要**：所有权限都通过 OS 弹窗授予；vision-mcp 不会 silently 取得权限。Agent 在调用 `capsule.*` 工具失败 (`PERMISSION_DENIED`) 时必须把这一条原样转告用户。

## 2. 用户可见状态

- 状态边框：Windows.Graphics.Capture / ScreenCaptureKit 自带；不要尝试隐藏。
- **Live View**（v0.4 MVP，浏览器版）：`vision-mcp live-view <app> --port 7575` 启动后浏览器实时显示 capsule 画面 + 接管按钮（POST /takeover → 把窗口迁回主屏）。生产环境可升级为 native NSPanel + 全局接管热键（M1）。
- **Workspace 提示**：选到非 primary workspace（virtual / sidecar / airplay / extended / off_screen）时，agent 必须在对话中告知用户本次任务执行的显示器名称；off_screen 模式必须额外说明 peek-corner 位置。详见 `skill/references/safety.md` §7。
- Trace：所有动作进入 `<traces_dir>/<app_id>/events.jsonl`，用户随时可以打开 trace 查看 agent 做了什么。

## 3. 取消授权

- Windows：在 "控制面板 → 程序" 卸载 Vision-MCP；驱动可通过 `pnputil /delete-driver` 移除。
- macOS：在 "系统设置 → 隐私" 中取消勾选；删除应用即可。

## 4. 安全策略落地

- `safety_policy.forbidden_action_categories` 默认包含 payment / destructive / external_communication / permission_change / captcha；runtime 在动作触发审批时会显示这些类别。
- `require_approval_for_risk_levels` 决定哪些 risk_level 必须走审批通道，默认 `["requires_confirmation", "destructive"]`。
- 审批通道：CLI 内置 stdin 提问；MCP host 可通过 `CallbackApprovalResolver` 注入 elicitation / UI 弹窗。
