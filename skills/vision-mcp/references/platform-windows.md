# Windows 平台

## 1. 适配器与 native helper

- TypeScript 层：`@vision-mcp/core` 的 `WindowsPlatformAdapter`。
- Native helper：独立 sidecar 进程 `vision-mcp-helper.ps1`（PowerShell + Win32 P/Invoke + UI Automation + System.Drawing）。
  - JSON-RPC over stdio，与 macOS swift helper 同协议。
  - 启动时自动 `SetProcessDpiAwareness(2)` 拿真实 per-monitor DPI。
  - PowerShell 启动 ~400ms；生产推荐编译为 `.exe`（启动 ~10ms）。

环境变量：

```powershell
$env:VISION_MCP_NATIVE_HELPER = "C:\path\to\vision-mcp-helper.exe"
# 或开发期直接指 .ps1
$env:VISION_MCP_NATIVE_HELPER = "powershell -ExecutionPolicy Bypass -File C:\...\vision-mcp-helper.ps1"
```

编译为 exe（生产推荐）：

```powershell
Install-Module -Name ps2exe -Scope CurrentUser
Invoke-ps2exe native\windows\src\vision-mcp-helper.ps1 native\windows\vision-mcp-helper.exe -noConsole
```

或一键：`vision-mcp install-helper`（CLI 子命令；Windows 分支自动提示 ps2exe 命令）。

## 2. 权限

| 能力 | 来源 | 何时需要 |
| ---- | ---- | -------- |
| 窗口枚举 / 移动 | `EnumWindows` / `MoveWindow` / `SetForegroundWindow` | 默认用户级即可 |
| 捕获窗口 | `BitBlt` / `PrintWindow` | 默认；DirectX 游戏窗口可能黑屏 |
| 输入注入 | `SendInput` / `mouse_event` | 默认；**高完整度等级 app（任务管理器/反作弊）会拒绝**——helper 需以管理员身份运行 |
| UI Automation | `UIAutomationClient` | 默认；某些 elevated app 需 helper 同级权限 |
| 屏幕录制 | 系统隐私 → 屏幕录制（Win11） | Win11 24H2+ 部分应用受隐私 API 控制；默认放行 |

权限缺失或被拒时返回 `PERMISSION_DENIED` / `INPUT_LEASE_DENIED`，agent 应直接向用户展示权限步骤。

## 3. Capsule 行为

**不创建虚拟显示器**（设计文档 §8.4 提到的 IDD 驱动方案不在 MVP）。`capsule.ensureDisplay` 直接挑稳定 display：
1. 优先窗口当前所在的 display（用户已拖到副屏的窗口保留在副屏）
2. 否则 primary
3. 兜底第一个能装下 `visual_box.display` 尺寸的 display

`capsule.migrate` 把窗口放到选中 display 的工作区中心，**完整可见**。所有动作用归一化客户区坐标。

## 4. 截图：PrintWindow + BitBlt fallback

`capture.window` 优先用 `PrintWindow(hwnd, hdcBlt, PW_RENDERFULLCONTENT)`（Win 8.1+），能抓**被遮挡 / 部分屏外**的窗口完整内容。`PW_RENDERFULLCONTENT = 2` 让 DWM 复合窗口（含半透明 / 圆角）也能正常 capture。

`capture.rect` / `capture.display` 用 `Graphics.CopyFromScreen` BitBlt：屏幕坐标范围截图，速度快但抓不到屏外窗口。

**已知失败场景**：
- DirectX 全屏游戏：PrintWindow 拿黑屏；BitBlt 也常黑。生产建议切到 `Windows.Graphics.Capture`（需 C# / Rust 编译，PowerShell 难直接调）。
- Chrome / Edge / VSCode 等 GPU 加速渲染窗口：PrintWindow 一般 OK，BitBlt 偶尔黑。

## 5. 输入

- `input.click point button click_count` — `SetCursorPos` + `mouse_event(LEFT_DOWN | LEFT_UP)`，标准 click
- `input.type text` — Clipboard 粘贴（`SendKeys ^v`），**支持中文/Unicode**（SendKeys 直接发不支持非 ASCII）
- `input.key combo` — `SendKeys.SendWait`，标准映射（cmd→^ / shift→+ / alt→% / return→{ENTER} / esc→{ESC} 等）
- `input.scroll point dx_px dy_px` — `mouse_event(MOUSEEVENTF_WHEEL, dwData=-dy)`
- `input.drag from to_point_px steps duration_ms` — 平滑拖拽（`SetCursorPos` 逐步 + `LEFT_DOWN/MOVE/UP`）

### 5.1 input.ax_press（高级，等价 macOS AX-press）

`input.ax_press handle norm` — 用 UI Automation 直接对窗口内 norm 位置的元素调用模式动作，**不依赖鼠标**：

1. 首选 `InvokePattern.Invoke()`（普通按钮 / 菜单项 / 链接）
2. fallback `SelectionItemPattern.Select()`（列表项 / TabItem）
3. fallback `TogglePattern.Toggle()`（CheckBox / 开关）
4. fallback `ExpandCollapsePattern.Expand()`（TreeView / 折叠面板）

**适用**：所有暴露 UIA 模式的标准控件（WinForms / WPF / UWP / WinUI / Win32 native 都支持）。
**不适用**：DirectX 游戏 / 自绘 UI（如 Chrome 的网页内容 / 自定义 control 不实现 UIA pattern）—— 这种情况用普通 `input.click`。

### 5.2 SendInput 被拒（INPUT_LEASE_DENIED）

Win10+ 对**高完整度等级 app**（任务管理器、反作弊、UAC 弹窗）拒绝来自普通完整度等级进程的输入注入。处理方式：

- helper **以管理员身份**运行（`Run as administrator` 或安装时声明 `requestedExecutionLevel=requireAdministrator`）
- 用户级 app 之间互发输入：正常放行，无需 elevation

## 6. 窗口控制

- `window.list filter` — `EnumWindows` 枚举所有 visible window；按 process_name / title_regex / class_name 过滤
- `window.get handle` — 拿 bounds / client_bounds / state
- `window.move handle rect` — `ShowWindow(SW_RESTORE)` + `MoveWindow` + `Raise-Window-Strong`
- `window.restore handle snapshot` — 恢复 attach 前 placement
- `window.activate handle` / `window.raise handle` — 都走 `Raise-Window-Strong`：
  - 先试 `SetForegroundWindow`
  - 若被前台锁定保护拒绝 → 用 `AttachThreadInput` 把当前线程附加到前台窗口的输入队列 → `BringWindowToTop` + 重新 `SetForegroundWindow` → 解除附加

## 7. CLI 命令族（跨平台同名）

| 命令 | 用途 |
| ---- | ---- |
| `vision-mcp displays [--json]` | 列出所有显示器及类型 |
| `vision-mcp capsule <app>` | 一键 ensure + attach + migrate 到 display 工作区中心 |
| `vision-mcp restore <app>` | 把窗口迁回主屏中央 |
| `vision-mcp live-view <app>` | 浏览器实时查看 capsule + POST /takeover 接管 |
| `vision-mcp ax-press <app> --norm x,y` | UI Automation 操作 norm 位置元素 |
| `vision-mcp install-helper` | Windows 分支会给出 ps2exe 编译指引 |

## 8. 已知限制

- **不创建系统级虚拟显示器**（设计文档 §8.4：IDD 驱动签名 + 安装器复杂，MVP 不实现）。
- **DPI per-monitor**：helper 启动声明了 `PROCESS_PER_MONITOR_DPI_AWARE`，但 ps2exe 编译版需要 manifest 同步声明才完全准确。
- **DirectX 全屏 / 反作弊**：PrintWindow / SendInput 都可能被拒；标记 unsupported。
- **UAC 弹窗 / 高完整度 app**：helper 需 elevation 才能注入。
- **PowerShell 启动开销**：~400ms / 进程；生产编译为 exe。
- **UIA 对 Chrome / Electron 网页内容覆盖弱**：网页元素需 Chromium 启用 `--force-renderer-accessibility`，否则 ax_press 对网页内容无效。
- **Windows.Graphics.Capture（WGC）**：能抓 DirectX 窗口，但 PowerShell 调 WinRT 复杂；生产建议改 C# 编译。

## 9. 流程示例（同 macOS）

```powershell
# 1. 用 capsule 一键把目标 app 吸入主屏
vision-mcp capsule erp

# 2. 跑 workflow
vision-mcp workflow erp --id login_and_create_invoice `
  --inputs '{"username":"alice","password":"x","customer_name":"ACME","amount":"99"}'

# 3. 失败时 ax_press 或写 patch
vision-mcp ax-press erp --norm 0.5,0.3      # UIA Invoke
vision-mcp patch erp --state invoice.editor --control submit `
  --bbox-norm 0.74,0.82,0.08,0.04 `
  --reason "submit 按钮在最新 build 上移了 0.02 norm"
```

## 10. helper 协议同步度（对照 macOS）

| RPC | macOS (Swift) | Windows (PS1) | 备注 |
|-----|---------------|---------------|------|
| `version` | ✅ | ✅ | 含 `elevated: true/false` |
| `capsule.list_displays` | ✅ | ✅ | Win 端含 per-monitor DPI |
| `capsule.ensure_*` | ✅ | ✅ | 都不真创建虚拟显示器 |
| `window.list/get/move/restore` | ✅ | ✅ | Win 端含 client_bounds 区分 |
| `window.activate/raise` | ✅ AXRaise | ✅ AttachThreadInput hack | |
| `ax.dump` | ✅ AXUIElement | ✅ UIAutomation TreeWalker | |
| `capture.rect` | ✅ screencapture | ✅ BitBlt | |
| `capture.rect_annotated` | ✅ NSBitmap 画 | ✅ System.Drawing.Graphics | |
| `capture.window` | ✅ SCKit | ✅ PrintWindow + BitBlt fallback | |
| `capture.display` | ✅ | ✅ | |
| `ocr.recognize_rect` | ✅ Vision | ❌ | Windows.Media.Ocr 需 C# 编译；MVP 走 cloud OCR provider |
| `input.click/type/key/scroll/drag` | ✅ | ✅ | |
| `input.ax_press` | ✅ AXPress + Tree BFS | ✅ UIA FromPoint + InvokePattern fallback | |
| `input.subscribe` | (no-op) | (no-op) | M2 里程碑：全局 hook |
