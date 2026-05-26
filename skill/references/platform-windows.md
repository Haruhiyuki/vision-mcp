# Windows 平台

## 适配器位置

- TypeScript 层：`@vision-mcp/core` 的 `WindowsPlatformAdapter`。
- Native helper：独立 sidecar 进程 `vision-mcp-helper.exe`（建议 Rust + `windows-rs` + IddCx sample 集成）。

通信协议：JSON-over-stdio，方法包括：

```
capsule.list_displays
capsule.ensure_virtual_display
window.list / window.get / window.move / window.restore
capture.window / capture.display
input.click / input.type / input.key / input.scroll / input.drag / input.subscribe
```

设置环境变量 `VISION_MCP_NATIVE_HELPER=/path/to/vision-mcp-helper.exe` 指向 helper 可执行文件。

## 权限与部署

| 能力 | 来源 | 提示 |
| ---- | ---- | ---- |
| Virtual Display | IDD 驱动安装 | 需要管理员权限和驱动签名；安装器应明确说明用途与卸载方式。 |
| 窗口捕获 | Windows.Graphics.Capture / DXGI fallback | 用户首次使用会看到系统捕获提示边框。 |
| UI Automation | UIA | 默认开启；某些 elevated app 需要 helper 同级权限。 |
| 输入注入 | SendInput | 高完整度等级 app 会拒绝注入；遇到 INPUT_LEASE_DENIED 应停止。 |

## 已知限制

- 自定义渲染（DirectX overlay、游戏引擎窗口）可能无法稳定迁移；标记为 `unsupported`。
- DPI mismatch：迁入后 capsule 会重建 geometry profile，并写 L2 patch。
- 安全软件 / 反作弊：禁止注入；agent 应明确告诉用户该 app 不在 vision-mcp 支持范围。

## 流程示例

```
capsule.ensure_display(width=1280, height=800, scale=1.0)
window.list(filter={ process_name: "erp.exe" })
window.move(handle, { x, y, w, h })
capture.window(handle)
input.click({ x, y })
```
