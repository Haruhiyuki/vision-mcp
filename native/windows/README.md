# vision-mcp-helper (Windows)

PowerShell + Win32 P/Invoke + UI Automation 实现的 JSON-RPC sidecar，与 macOS swift helper 同协议。

## 1. 直接运行（开发期）

```powershell
powershell -ExecutionPolicy Bypass -File src\vision-mcp-helper.ps1
```

通过 `VISION_MCP_NATIVE_HELPER` 环境变量让 vision-mcp core 找到它：

```powershell
$env:VISION_MCP_NATIVE_HELPER = "C:\path\to\src\vision-mcp-helper.ps1"
# 或直接配 powershell + ps1 路径
```

## 2. 编译为 exe（v0.1 暂不可用，留作记录）

**当前不要用 ps2exe**：

- `-noConsole`：编成 Windows GUI 子系统，子进程根本没 stdin/stdout pipe → ReadLine 永远阻塞。
- 默认（无 `-noConsole`）：ps2exe 用自定义 PSHost，把 `[Console]::In.ReadLine()` 重定向到 Forms 输入框 → 父进程的 pipe 写入不会到达脚本。

两条路在做 JSON-RPC sidecar 时都不可用。已在 commit `b3cb50e` 验证过。

如果你要 .exe 提速，目前 supported 方案：

1. **用 .ps1（默认）**：`NativeBridge` 自动用 `powershell.exe -File` 包一层。冷启动 ~400ms（Add-Type UIA / Drawing），之后稳定 ~50ms/RPC。对长寿命 sidecar 完全够用。
2. **dotnet AOT launcher（roadmap）**：5 行 C# `Process.Start("powershell.exe", ...)` 包一层，跳过 PowerShell 5.1 启动期。等 prebuilt 发布。

## 3. 实现的 RPC 方法

| RPC | 实现 | 性能 |
| --- | ---- | ---- |
| `version` | 返回 `{version, platform=windows, elevated}` | < 5ms |
| `capsule.list_displays` | `System.Windows.Forms.Screen.AllScreens` + `GetDpiForWindow` 拿真实 per-monitor DPI | < 30ms |
| `capsule.ensure_virtual_display` | 不创建虚拟显示器；返回 displays[0]（runtime 走 pickStableDisplay） | < 30ms |
| `window.list` | `EnumWindows + GetWindowText + GetWindowRect + GetClientRect`，含 is_foreground / is_maximized / native_handle=HWND | ~50ms |
| `window.get` | `window.list` + filter | ~50ms |
| `window.move` | `ShowWindow(SW_RESTORE)` → `MoveWindow` → `Raise-Window-Strong` | ~150ms |
| `window.restore` | 同 `window.move` 用 snapshot.placement.bounds | ~150ms |
| `window.activate` / `window.raise` | `Raise-Window-Strong`：`SetForegroundWindow` → 失败时 `AttachThreadInput` hack 兜底 | < 30ms |
| **`ax.dump`** | `AutomationElement.FromHandle` + `TreeWalker.ControlViewWalker` 遍历控件树 | 50–500ms（取决于窗口复杂度） |
| `capture.rect` | `Graphics.CopyFromScreen` → PNG | ~200ms |
| **`capture.rect_annotated`** | `Graphics.DrawLine + DrawRectangle + DrawString` 画网格 / bbox / 标签 | ~250ms |
| **`capture.window`** | `PrintWindow(hwnd, hdcBlt, PW_RENDERFULLCONTENT=2)` 抓窗口（含被遮挡 / 部分屏外） | ~150ms |
| `capture.display` | `Capture-Rect(display.bounds)` | ~200ms |
| `input.click` | `SendInput` MOUSEINPUT（含 modifier-down/up 包裹，支持 cmd/ctrl/shift/alt-click） | < 10ms |
| `input.type` | `SendInput` + `KEYEVENTF_UNICODE` (VK_PACKET) — 中文/Emoji 直接注入，不污染剪贴板、绕过 IME 候选框；支持 `clear_first` | ~30ms |
| `input.key` | `SendInput` VK 码（Resolve-Vk 把 cmd/ctrl/shift/alt + return/escape/tab/F1-F12 等名称解析为 VK），未识别键 fallback `SendKeys.SendWait` | < 20ms |
| `input.scroll` | `SendInput` MOUSEWHEEL，32-bit 位级强转避免 uint OverflowException，支持正负 dy + 水平 dx | < 10ms |
| **`input.drag`** | `SendInput` MOUSE_DOWN → MOVE 逐步 → MOUSE_UP（mouse_event 在 Win10+ 已 deprecated，SendInput 是唯一受 UIPI 完整管的路径） | 200ms（默认 duration） |
| **`input.ax_press`** | `AutomationElement.FromPoint(x,y)` + `InvokePattern → SelectionItem → Toggle → ExpandCollapse` 依次尝试 | < 30ms |
| **`ax.dump_msaa`** | `AccessibleObjectFromWindow + AccessibleChildren` MSAA fallback；`ax.dump` 在 UIA 节点 < 3 时也会自动走这条 | < 30ms |
| **`ocr.recognize_rect`** | `Windows.Media.Ocr` WinRT（懒加载）+ GDI `CopyFromScreen` + `BitmapDecoder` → `SoftwareBitmap` → `OcrEngine.RecognizeAsync` | 120-180ms（1200x600 含约 160 词） |
| **`ocr.languages`** | `AvailableRecognizerLanguages`（设置 → 时间和语言 → 添加语言） | < 10ms |
| `input.subscribe` | no-op（lease 用键盘热键打断） | - |

## 4. 与 macOS helper 等价的 protocol

```jsonl
> {"id":"1","method":"capsule.list_displays"}
< {"id":"1","result":[{"id":"display-0","bounds":{...},"scale":1.5,"dpi_x":144,"kind":"primary","is_primary":true,...}]}

> {"id":"2","method":"input.ax_press","params":{"handle":"131072","norm":[0.4,0.5]}}
< {"id":"2","result":{"ok":true,"via":"invoke_pattern","matched_role":"ControlType.Button","matched_name":"提交"}}

> {"id":"3","method":"capture.window","params":{"handle":"131072"}}
< {"id":"3","result":{"png_base64":"...","width":1280,"height":800,"via":"print_window"}}
```

## 5. Windows 平台优化要点（对照 macOS）

| 优化 | macOS | Windows |
| ---- | ----- | ------- |
| 现代窗口截图 API | SCKit `SCScreenshotManager.captureImage` | `PrintWindow PW_RENDERFULLCONTENT` |
| 零鼠标操作 | AXUIElement `AXPress` | UIAutomation `InvokePattern`；老 Win32 自绘 app 走 MSAA `AccessibleObjectFromWindow` fallback |
| 强力 raise window | AXRaise | `AttachThreadInput` hack |
| 中文 / Unicode 输入 | NSPasteboard 粘贴 | `SendInput` + `KEYEVENTF_UNICODE` (VK_PACKET)；不污染剪贴板、绕过 IME 候选框 |
| 鼠标 / 键盘注入 | CGEventPost | `SendInput` INPUT 数组（受 UIPI 完整管） |
| Per-monitor DPI | NSScreen.backingScaleFactor | `SetProcessDpiAwareness(2)` + `MonitorFromPoint` + `GetDpiForMonitor`（控制台进程 ActiveForm 永远 null，必须按显示器拿） |
| AX tree dump | `AXUIElementCreateApplication + AXChildren` | `AutomationElement.FromHandle + TreeWalker`；UIA 节点 < 3 时自动 fallback MSAA |
| OCR | Vision framework `VNRecognizeTextRequest` | `Windows.Media.Ocr` WinRT（懒加载 + AsTask 转 IAsyncOperation） |
| Annotated 截图 | NSBitmap + NSBezierPath | `Graphics.DrawLine + DrawRectangle + DrawString`，#N 前缀让 agent 说 "click #7" |

## 6. 已知限制 / 未实现

- **OCR 走 GDI screen pixels**：`Windows.Media.Ocr` 需要 SoftwareBitmap，目前 helper 用 `CopyFromScreen` 抓——目标窗口必须可见 + 前台；屏外 workspace OCR 不到（roadmap：feed PrintWindow bitmap 到 OCR engine）。
- **AX 树 dump 性能**：UIA TreeWalker 对深层窗口（Chrome 等）可能 > 1s；helper 默认 maxNodes=300、maxDepth=5（比 macOS 保守）。
- **IDD 虚拟显示器**：需要驱动签名 + 企业部署，**不在 MVP**；生产可与 IddCx sample 集成。
- **Windows.Graphics.Capture (WGC)**：比 PrintWindow 快 5-10x、能抓 DirectX 窗口，但需要 WinRT IDirect3D 包装（C# / Rust 更简洁）。MVP 用 `PrintWindow`。
- **PS5.1 + WinRT 限制**：所有 IAccessible 互操作和 IAsyncOperation→Task 转换都包在 C# Add-Type 里（PS 直接 cast `System.__ComObject` 到 `Accessibility.IAccessible` 抛 InvalidCastException）。修改 helper 时注意。
- **CEF / Chromium-based app**（Steam / Discord / VS Code / Edge）：UIA 只看到 `Chrome_RenderWidgetHostHWND` 空壳，DOM 元素不可见。走 OCR + click 视觉路线，或等 CEF 启 UIA accessibility bridge。

## 7. 性能基准（PowerShell 5.1 + Win10）

| 操作 | 耗时 |
| ---- | ---- |
| `version` | < 5ms |
| `window.list`（~50 个窗口） | 40–60ms |
| `ax.dump`（VSCode，maxNodes=300） | 120–300ms |
| `capture.rect`（1920x1080） | 150–250ms |
| `capture.window`（1280x800 PrintWindow） | 100–200ms |
| `input.click` | < 10ms |
| `input.ax_press`（InvokePattern） | 20–40ms |

冷启动（首次 RPC）会多 ~400ms（Add-Type 加载 UIA / Drawing assemblies）。

## 8. 故障排查

### 通用问题

| 现象 | 原因 | 解决 |
| ---- | ---- | ---- |
| `INPUT_LEASE_DENIED` | 目标 app 是高完整度等级（任务管理器/反作弊） | 整个 Node 进程以管理员身份运行（helper 跟随父进程权限）|
| `capture.window` 黑屏 | DirectX 全屏 / 反作弊保护 / DWM 复合关 | 用 `capture.rect`（BitBlt）兜底；或迁出 fullscreen。终极方案 WGC（roadmap）|
| `input.ax_press` 返回 `no_pattern` | 元素是自绘 UI，不实现 UIA pattern | 改用 `input.click`（坐标）；或上 MSAA fallback（roadmap）|
| `Add-Type UIAutomationClient` 失败 | 用了 PowerShell Core (pwsh.exe) | helper 启动期会自检并报 `PWSH_INCOMPATIBLE`；CLI 自动包 `powershell.exe -File` 避开这条 |
| `windows is not iterable` 之类的 JS 报错 | 旧 helper PS 5.1 ConvertTo-Json 展平了 1-element 数组 | 升级 helper 到 b3cb50e 之后版本（已用 ArrayList 修复）|
| 中文 / Emoji 标题乱码 | OutputEncoding 不是 UTF-8 | helper 启动期已强制 UTF-8；老 helper 升级即可 |
| `SetForegroundWindow` 静默失败 | Win10+ 前台锁定保护 | helper 已内置 `AttachThreadInput` hack；仍失败时用 `Alt+Tab` 模拟 |

### SmartScreen 拦截（未签名 .exe）

如果你拿到第三方 prebuilt `vision-mcp-helper.exe`（或自己 ps2exe 编的实验版），第一次双击会被 Windows SmartScreen 拦截：

1. **解除阻止**（最简单）：右键 .exe → 属性 → 勾选底部"解除阻止" → 应用。这是 NTFS Zone.Identifier ADS，安装包/MOTW 标记导致。
2. **PowerShell 一键解除**：`Unblock-File "C:\path\to\vision-mcp-helper.exe"`
3. **管理员首次运行**：右键 → "以管理员身份运行"，SmartScreen 走过一次后记住。
4. **正式签名（生产）**：申请 OV/EV 代码签名证书（DigiCert / Sectigo / SSL.com 一年 ~$200），用 `signtool sign /tr http://timestamp.digicert.com /td sha256 /fd sha256 /a vision-mcp-helper.exe`。EV 签名直接绕过 SmartScreen 信誉积累期，OV 需要积累 ~3000+ 用户下载量。
5. **CI 流水线签名**：在 GitHub Actions 用 [Azure Trusted Signing](https://learn.microsoft.com/azure/trusted-signing) 或托管 signtool 任务，避免私钥落地。

### 企业 GPO 锁定环境

| 锁定项 | 现象 | 应对 |
| ----- | ---- | ---- |
| PowerShell ExecutionPolicy=AllSigned | `.ps1` 加载失败 | CLI 用 `-ExecutionPolicy Bypass`，在大多数策略下有效；如果是 GPO ConstrainedLanguage 锁死，需要 admin 在 [`HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment`] 加 `__PSLockdownPolicy` 例外，或申请白名单 |
| AppLocker / WDAC 限可执行 | `powershell.exe` 不能运行任意 .ps1 | 把 helper .ps1 加入 Publisher 白名单（用企业签名）或 Path 例外 |
| Defender ASR 规则拦 PowerShell | helper 进程被立即 kill | 把 vision-mcp 的 Node 进程 + helper .ps1 加 ASR 例外（[Block all Office applications from creating child processes] 等规则）|
| Windows Sandbox / WDAG | 抓不到 host 桌面 | 设计上 vision-mcp 不跨沙箱；只能在沙箱内自己跑一份 |

### Sandboxed app（UWP / MSIX）

UWP / MSIX 打包的 app（Edge、Calculator 现代版、商店应用）有几个特殊点：

- **进程名**：MainModule 是宿主 `ApplicationFrameHost.exe` 或 `RuntimeBroker.exe`，不是直接对应的 exe。`window.list` 的 `process_name` 看到的是宿主名 → 用 `title_regex` 选窗口更可靠。
- **窗口层级**：UWP 窗口实际由 `Windows.UI.Core.CoreWindow` 子窗口承载；UIAutomation 树多一层 `Pane`。`ax.dump` 可能要 `max_depth=8` 才能看到内容。
- **AppContainer 隔离**：UWP 进程是 low-integrity，但作为 attacker 的 vision-mcp 反而是 medium/high integrity，UAC 方向反着，可以正常注入输入。
- **PrintWindow**：UWP 的 DirectComposition 渲染对 `PrintWindow PW_RENDERFULLCONTENT` 一般 OK，但 Edge 这种用 GPU 合成的会黑屏 → 走 BitBlt 屏幕区域或 WGC。

### 报 issue 时附上 doctor 输出

```powershell
vision-mcp doctor > vision-mcp-doctor.txt
```

把 `vision-mcp-doctor.txt` 贴进 issue。它包含 OS / PowerShell 版本 / helper 路径 / displays 列表 / elevation 状态。
