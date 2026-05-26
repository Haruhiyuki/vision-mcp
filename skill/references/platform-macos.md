# macOS 平台

## 适配器位置

- TypeScript 层：`@vision-mcp/core` 的 `MacosPlatformAdapter`。
- Native helper：独立 sidecar `vision-mcp-helper`（建议 Swift + ScreenCaptureKit + Accessibility + CGEvent）。

环境变量 `VISION_MCP_NATIVE_HELPER` 指向 helper；helper 在收到 `capsule.ensure_workspace_display` 时按 `mode` 决定是否走 `real_window` 或 `existing_display`，不创建系统级虚拟显示器。

## 权限

| 权限 | 来源 | 提示 |
| ---- | ---- | ---- |
| Screen Recording | 系统设置 → 隐私 → 屏幕录制 | 第一次截图时引导用户授权。 |
| Accessibility | 系统设置 → 隐私 → 辅助功能 | 用于读取/移动窗口、点击、输入；必须为 helper 二进制开启。 |
| Automation / Apple Events | 系统设置 → 隐私 → 自动化 | 仅在 fallback 控制应用脚本时使用，默认关闭。 |
| Input Monitoring | 监听用户输入打断 lease | 可选；未授予时降级为基于热键打断。 |

权限缺失时返回 `PERMISSION_DENIED`，agent 应直接向用户展示授权步骤。

## 已知限制

- 不创建系统虚拟显示器（设计文档 §9.1）：MVP 阶段不承诺。
- 全屏 / Spaces：迁移前必须退出全屏。运行时如发现 `is_fullscreen=true` 会标记 `GEOMETRY_MISMATCH`。
- 多 Spaces：跨 Space 操作行为不稳定；建议把 capsule 与目标窗口固定在同一 Space。
- 系统弹窗（权限、Touch ID、登录钥匙串）：属于 `system_modal` state，禁止自动处理。

## fallback 顺序

```
capsule.ensure_workspace_display({
  mode: "same_session_virtual_display",
  fallbacks: ["real_window", "existing_display"]
})
```

- `real_window`：直接绑定用户当前桌面上的目标窗口；不要求第二显示器。
- `existing_display`：使用已连接的外接显示器 / Sidecar / dummy 适配器作为 agent workspace。
- `third_party_virtual_display`：需要管理员显式信任的第三方虚拟显示器（如某些开源 EDID 注入工具）；首发不内置任何私有驱动。
