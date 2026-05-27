# macOS 平台

## 1. 适配器与 native helper

- TypeScript 层：`@vision-mcp/core` 的 `DarwinHelperAdapter`（默认）/ `MacosPlatformAdapter` / `DarwinOsascriptAdapter`（fallback）。
- Native helper：独立 sidecar `vision-mcp-helper`（Swift + ScreenCaptureKit + Accessibility + CGEvent + IOKit + Vision）。
  - JSON-RPC over stdio，启动时 `NSApplication.shared + .accessory` 初始化（SCKit 需要 CGS init）。
  - 单调用 < 50ms；AX dump < 50ms（osascript adapter 慢 ~500x）。

环境变量：

```bash
VISION_MCP_NATIVE_HELPER=/abs/path/native/macos/vision-mcp-helper
```

编译 helper：

```bash
cd native/macos
swiftc -O -o vision-mcp-helper src/main.swift \
  -framework AppKit -framework ApplicationServices -framework CoreGraphics \
  -framework IOKit -framework Vision -framework CoreImage \
  -framework ScreenCaptureKit
```

## 2. 权限

| 权限 | 系统设置路径 | 何时需要 |
| ---- | ------------ | -------- |
| Screen Recording | 隐私 → 屏幕录制 | 所有 capture 调用（含 SCKit 抓窗口）。第一次会弹系统对话框。 |
| Accessibility | 隐私 → 辅助功能 | 读写窗口位置、AX 树 dump、AX-press、CGEvent 注入。必须为 helper 二进制开启。 |
| Automation / Apple Events | 隐私 → 自动化 | 仅 osascript fallback 路径用；默认关闭。 |
| Input Monitoring | 隐私 → 输入监控 | 监听用户输入以打断 lease；可选，不授予则降级为基于热键打断。 |

权限缺失时返回 `PERMISSION_DENIED`，agent 应直接向用户展示授权步骤。

## 3. Capsule 行为

**不创建虚拟显示器**（设计文档 §9.5）。`capsule.ensureDisplay` 直接挑稳定 display：
1. 优先窗口当前所在的 display（如果用户已经把它拖到副屏，就保留在那里）
2. 否则 primary
3. 兜底第一个能装下 `visual_box.display` 尺寸的 display

`capsule.migrate` 把窗口放到选中 display 的工作区中心，**完整可见**。所有动作用归一化客户区坐标。

## 4. 截图：SCKit + screencapture fallback

`capture.window` 优先用 ScreenCaptureKit（`SCScreenshotManager.captureImage` + `SCContentFilter.desktopIndependentWindow`），失败 fallback `screencapture -R`。

- SCKit：现代 API，macOS 14+ 必备（CGWindowListCreateImage 已弃用）。
- `screencapture -R`：屏幕坐标范围截图，速度略慢（fork 子进程 ~150ms）。

## 5. 输入

- `input.click point button click_count`：mouseMoved → down/up，标准 click。
- `input.type text [clear_first]`：用 NSPasteboard 粘贴（支持中文/Unicode）。
- `input.key combo`：CGEvent keystroke（"return" / "cmd+f" / "Escape" 等）。
- `input.scroll point dx_px dy_px`：CGEvent 滚轮。
- `input.drag from to_point_px steps duration_ms`：平滑拖拽。
- `input.ax_press handle norm`（**高级**）：用 AX 直接对窗口内 norm 位置的元素发 `AXPerformAction("AXPress")`，不依赖鼠标坐标。
  - 适用：菜单 / 工具栏 / 普通 `AXButton` 等有 AXPress action 的元素。
  - **不适用**：`NSTableView` cell（sidebar 等）、SwiftUI 自绘元素 —— 它们不响应 AXPress；这种情况用普通 `input.click`。

## 6. 窗口控制

- `window.list filter`：枚举所有 app 窗口（按 process_name / bundle_id / title_regex 过滤）。
- `window.get handle`：拿当前 bounds / 状态。
- `window.move handle rect`：AX setPosition/setSize → activate → 等稳定。
- `window.restore handle snapshot`：恢复 attach 前 placement。
- `window.activate handle`：把 app 拉到前台（`NSWorkspace.activate options: .activateAllWindows`）。
- `window.raise handle`：等价于 `window.activate`（保留向后兼容）。

## 7. CLI 命令族

| 命令 | 用途 |
| ---- | ---- |
| `vision-mcp displays [--json]` | 列出所有显示器及类型 |
| `vision-mcp capsule <app> [--display id]` | 一键 ensure + attach + migrate 到 display 工作区中心 |
| `vision-mcp restore <app>` | 把窗口迁回主屏中央 |
| `vision-mcp live-view <app> [--port 7575]` | 浏览器实时查看 capsule 画面 + POST /takeover 接管 |
| `vision-mcp ax-press <app> --norm x,y` | 用 AX 操作 norm 位置元素（不依赖鼠标坐标） |

CLI 默认：`autoAttach=true autoMigrate=false`——snapshot / click 等命令只 attach 不重新 migrate，避免反复打扰用户。`vision-mcp build` 与 `vision-mcp capsule` 显式触发 migrate。

## 8. 已知限制

- 不创建系统虚拟显示器（设计文档 §9.5）；窗口总是显示在用户主屏。
- 全屏 / Spaces：迁移前必须退出全屏。运行时如发现 `is_fullscreen=true` 会标记 `GEOMETRY_MISMATCH`。
- 多 Spaces：跨 Space 操作行为不稳定；建议把 capsule 与目标窗口固定在同一 Space。
- 系统弹窗（权限、Touch ID、登录钥匙串）：属于 `system_modal` state，禁止自动处理。
- SCKit 在 macOS 14+ 可用；macOS 13 及更早自动 fallback `screencapture -R`。
- macOS NSTableView cell（如 Apple Music sidebar）不响应 `AXPress`，必须用普通 `click`。
- 部分应用（如 Apple Music 新版搜索）用 SwiftUI 自绘，AX 不暴露 SearchField，type 无法 focus；需视觉判断 click 位置。
