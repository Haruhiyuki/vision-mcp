# macOS 平台

## 1. 适配器与 native helper

- TypeScript 层：`@vision-mcp/core` 的 `DarwinHelperAdapter`（默认）/ `MacosPlatformAdapter` / `DarwinOsascriptAdapter`（fallback）。
- Native helper：独立 sidecar `vision-mcp-helper`（Swift + ScreenCaptureKit + Accessibility + CGEvent + IOKit）。
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

权限缺失时返回 `PERMISSION_DENIED`，agent 应直接向用户展示授权步骤，不要静默重试。

## 3. Workspace display 体系

### 3.1 设计文档 §9.2 落地（macOS 不创建系统级虚拟显示器）

macOS 公开 API 不支持稳定地创建系统虚拟显示器，所以 vision-mcp 不去"造"workspace，而是**自动识别并优先使用**已有的非主屏：

| `DisplayKind` | 检测依据 | workspace 评分 | 典型场景 |
| ------------- | -------- | -------------- | -------- |
| `virtual` | `NSScreen.localizedName` 含 BetterDisplay/Deskreen/Dummy/SuperDisplay/DuetDisplay/LunaDisplay 等关键字；或 vendor 在白名单 | 100 | 第三方虚拟显示驱动（最佳） |
| `sidecar` | name 含 "Sidecar" / "iPad" | 80 | iPad as second display |
| `airplay` | name 含 "AirPlay" | 70 | AirPlay 接收端 |
| `extended` | 非主屏的物理副屏（CGDisplayIsBuiltin=false 且非 primary） | 50 | HDMI/USB-C 接出去的副屏 |
| `primary` | `CGDisplayIsBuiltin` 或 `CGMainDisplayID` | 10 | 主屏（agent 操作会抢用户屏幕；不推荐） |
| `mirror` | `CGDisplayMirrorsDisplay != 0` | 0 | 镜像，与 primary 同内容，禁用 |
| `unknown` | 兜底 | 30 | 检测不出来 |

`pickWorkspaceDisplay()` 按上述评分排序，要求 work_area ≥ visual_box.display 尺寸；都不满足返回 null（caller 决定降级）。

### 3.2 ensure_display 调用与 mode

```ts
capsule.ensure_display({
  mode: "existing_display",     // 或 "real_window" / "off_screen" / "same_session_virtual_display"
  geometry: { width_px: 1280, height_px: 800, scale: 2.0, ... },
  fallbacks: ["real_window"],    // 找不到合适 workspace 时降级
  allowOffScreen: true            // 启用屏外 workspace（无副屏环境的兜底）
})
```

各 mode 行为：

- `real_window`：不切 workspace，capsule 用窗口当前所在 display 作坐标系。最简单，但 agent 操作抢主屏。
- `existing_display`：按 §3.1 自动选最佳 workspace；找不到合适的抛 `CAPSULE_DISPLAY_MISSING`。
- `off_screen`：合成屏外 workspace（见 §3.3）；等价于 `allowOffScreen: true`。
- `same_session_virtual_display`：向后兼容（v0.2 默认值），等同 existing_display。

### 3.3 Off-screen workspace（无副屏环境）

无副屏 + 不装第三方驱动 + 仍要"不抢主屏"时，可启用 off_screen：把窗口移到主屏右下角，仅留 ~40px peek-corner 在屏内（macOS WindowServer 不允许完全屏外，会自动 clamp）。

```ts
const off = synthesizeOffScreenWorkspace({
  primary,
  width: 1280,
  height: 800,
});
// off.bounds = { x: primary.width-40, y: primary.height-40, w: 1280, h: 800 }
// off.kind = "virtual"
// off.id = "off-screen-workspace"
```

**关键约束**（macOS 物理限制，无法绕过）：

1. **完全屏外会被隐藏**：WindowServer 把完全离开主屏的窗口标记为 hidden，停止渲染，CGWindowList / SCKit 都拿不到内容。所以必须留 peek-corner。
2. **CGEvent 屏外坐标的鼠标事件不到达**：用 `cursor_mode: "physical"` 或 `"virtual"` 在屏外点没用——必须用 `ax_press` 模式（AX 不依赖鼠标坐标）。
3. **AX setPosition 被 clamp**：你传 (2120, 0)，macOS 实际给 (1880, 30)——这是 `NSWindow.constrainFrameRectToScreen` 行为；接受即可，capsule 用窗口实际 `client_bounds` 计算 norm。

### 3.4 截图：SCKit 优先

`capture.window` 优先用 ScreenCaptureKit（`SCScreenshotManager.captureImage` + `SCContentFilter.desktopIndependentWindow`），fallback `screencapture -R`。

- SCKit 能抓**半屏外的窗口完整内容**（peek-corner 模式下 40px 可见仍能拿到完整 1280x800 / 2560x1600 retina）。
- `screencapture -R` 只能截屏内可见区域，屏外失败。
- `findWindowID` 用 `SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)` 找对应 pid 的最大 window；CGWindowList 在屏外窗口上会返回错误的 dock-badge frame，所以 SCKit 优先。

## 4. Virtual cursor（鼠标不打扰用户）

`input.click` 的 `cursor_mode` 参数控制鼠标行为：

| mode | 行为 | 适用场景 |
| ---- | ---- | -------- |
| `physical`（默认） | 先 `mouseMoved` 把 cursor 飞到目标，再 down/up | 普通模式；触发 hover 状态 |
| `virtual` | 先 mouseMoved 到目标 → down/up → 立刻 `CGWarpMouseCursorPosition` 还原到原位 | 用户主屏在操作时，agent 在 workspace 操作 |
| `virtual_no_warp` | 不移动 cursor，直接 down/up（很多 hitTest 会用 cursor 位置，容易点错） | 配合 `try_ax_press: true` 用 |
| `ax_press` | 完全不用 CGEvent，调 `axPressInWindowAtNorm`：BFS 遍历窗口 AX tree 找最小可点击 element 调 `AXPerformAction("AXPress")` | off-screen workspace 必用；屏外 CGEvent 不到达 |

**`try_ax_press: true`** 加在 click 上时：先尝试 AX-press 当前位置元素，能 press 就完全不动鼠标；不能就 fallback `cursor_mode`。

`input.ax_press`（独立方法）：给 `handle + norm`，直接 BFS 找窗口里包含 norm 坐标的最小可点击 element 执行 AXPress。返回 `{ ok, via, matched_role, matched_name }`。matched_role 通常是 `AXButton / AXRadioButton / AXCell / AXTextField`。

## 5. 窗口控制

- `window.move`：AX setPosition + setSize → activate → 再次 setPosition（防 macOS 自动 reposition）。
- `window.raise`：AXRaise + 必要时 `app.activate(options: [])`（**不带** `.activateAllWindows`）；带 `keep_position: true` 在 activate 后立刻 setPosition 恢复，防 macOS 把屏外窗口拉回主屏。
  - 老的 `window.activate` 会调 `app.activate(options: [.activateAllWindows])`，**会把屏外窗口拉回主屏**——off-screen workspace 模式禁用此方法，必须用 `window.raise`。

## 6. CLI 命令族

| 命令 | 用途 |
| ---- | ---- |
| `vision-mcp displays [--json]` | 列所有显示器 + workspace 评分 + 推荐 |
| `vision-mcp capsule <app> [--display id] [--off-screen]` | 一键 ensure + attach + migrate |
| `vision-mcp restore <app>` | 把窗口迁回主屏中央 |
| `vision-mcp live-view <app> [--port 7575]` | 浏览器实时查看 capsule（http://localhost:port），含接管按钮 (POST /takeover) |
| `vision-mcp ax-press <app> --norm x,y` | 用 AX 操作 norm 位置元素，完全不动鼠标 |
| `vision-mcp click <app> --norm x,y [--cursor physical\|virtual\|ax_press]` | 普通 click，加 `--cursor virtual` 后用户主屏光标不动 |

CLI 默认行为：所有命令 `autoAttach` 但 `autoMigrate=false`——只 attach 拿 window handle，不重复迁移；避免反复把屏外窗口拉回主屏。`vision-mcp build` 例外（显式 `autoMigrate=true`）。

## 7. 已知限制

- 不创建系统虚拟显示器（设计文档 §9.5）。
- 完全屏外窗口被 WindowServer 隐藏：实际最小 peek-corner 40px 可见。
- 全屏 / Spaces：迁移前必须退出全屏。运行时如发现 `is_fullscreen=true` 会标记 `GEOMETRY_MISMATCH`。
- 多 Spaces：跨 Space 操作行为不稳定；建议把 capsule 与目标窗口固定在同一 Space。
- 系统弹窗（权限、Touch ID、登录钥匙串）：属于 `system_modal` state，禁止自动处理。
- SCKit 在 macOS 14+ 可用；macOS 15+ 强制（CGWindowListCreateImage 已弃用）。

## 8. fallback 顺序示例

```yaml
visual_box:
  mode: existing_display
  fallbacks: [real_window]    # 没合适副屏时降级 real_window
  # 或：
  # mode: off_screen
  # 等价于 mode=existing_display + allowOffScreen=true
```

实际选择路径：
```
existing_display → pickWorkspaceDisplay()
  ├─ 命中 virtual/sidecar/airplay/extended → 用它
  └─ 都没有
       ├─ allowOffScreen=true → synthesizeOffScreenWorkspace（peek-corner）
       └─ allowOffScreen=false → 抛错 → caller 走 fallbacks
            └─ real_window → primary 当 workspace（抢主屏）
```
