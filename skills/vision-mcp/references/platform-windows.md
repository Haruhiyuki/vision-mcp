# Windows 平台

跟 `platform-macos.md` 对称。RPC 协议字段名跨平台同 schema；本文只列 Windows 特有行为。

## 1. 适配器与 native helper

- TypeScript 层：`WindowsPlatformAdapter`（生产）/ `MockPlatformAdapter`（测试）。
- Native helper：`native/windows/src/vision-mcp-helper.ps1`（PowerShell 5.1 + Win32 P/Invoke + UI Automation + System.Drawing + WinRT）。
  - JSON-RPC over stdio，**必须** Windows PowerShell 5.1（`powershell.exe`），不能 pwsh.exe / PowerShell 7（UIAutomationClient Add-Type 在 Core 必失败；helper 启动期自检并报 `PWSH_INCOMPATIBLE`）
  - NativeBridge 自动用 `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <ps1>` 包一层；agent 不用手设
  - 首次 RPC ~400ms（含 Add-Type UIA/Drawing/WindowsBase/Accessibility/WinRT），warm RPC 20-300ms
  - 启动时 `SetProcessDpiAwareness(2)` 拿真 per-monitor DPI

环境变量（默认不必设；CLI 自动从 `cli/native` 或 `repo/native` 找）：

```powershell
$env:VISION_MCP_NATIVE_HELPER = "C:\path\to\native\windows\src\vision-mcp-helper.ps1"
$env:VISION_MCP_NATIVE_DEBUG = "1"   # 打开 helper RPC 协议日志（stderr 输出）
```

**编译为 .exe 不可行**：PS2EXE 的默认 Host 拦截 `[Console]::In`，`-noConsole` 又编成 GUI 子系统没 stdio。.ps1 + 包 powershell.exe 是 supported 路径。详见 `native/windows/README.md §2`。

## 2. 权限

| 能力 | 来源 | 何时需要 |
| ---- | ---- | -------- |
| 窗口枚举 / 移动 | `EnumWindows` / `MoveWindow` | 用户级默认放行 |
| 截屏 | `PrintWindow` / GDI `CopyFromScreen` | 用户级默认；Win11 隐私 → 屏幕录制 可能受控 |
| 输入注入 | `SendInput` | 用户级默认；**高完整度等级 app（任务管理器 / 反作弊 / UAC 弹窗）会 UIPI 拒绝** → vision-mcp 整个进程必须 elevated |
| UI Automation | `UIAutomationClient` | 用户级默认；elevated app 同样要 helper 同级权限 |
| OCR | `Windows.Media.Ocr` (WinRT) | 用户级默认；**对应语言包必须装**（设置 → 时间和语言 → 添加语言 → 勾选 OCR） |
| MSAA | `oleacc.dll AccessibleObjectFromWindow` | 默认放行；UIPI 同上 |

`vision-mcp doctor` 一键检测 PowerShell 版本 / helper / elevation / OCR 语言 / displays。报 issue 必附 doctor 输出。

## 3. Capsule 行为

**不创建虚拟显示器**（设计文档 §8.4）。`capsule.ensureDisplay` 直接挑稳定 display：
1. 窗口当前所在 display
2. primary
3. 第一个能装下 `visual_box.display` 尺寸的

`capsule.migrate` 把窗口放到 display 工作区中心，**完整可见**。Steam / Discord 等有最小窗口尺寸 ≥1364×810 — `visual_box.display` 写实测尺寸，`tolerate_client_size_delta_px` 放宽到 80。

## 4. 截图：PrintWindow > BitBlt > 屏外 fallback

- `capture.window`：`PrintWindow(hwnd, hdcBlt, PW_RENDERFULLCONTENT=2)`（Win 8.1+），能抓**被遮挡 / 部分屏外 / 后台**窗口
- `capture.rect` / `capture.display`：`Graphics.CopyFromScreen` BitBlt — 只屏内
- DirectX 全屏 / 反作弊 / GPU 合成（Edge 内容区）可能 PrintWindow 黑屏 → BitBlt 兜底；终极方案 WGC（roadmap）

## 5. 输入（全部 SendInput 路径）

- `input.click point button click_count [modifiers]`：`SetCursorPos` + `SendInput MOUSEINPUT`。`modifiers: ["cmd"|"ctrl"|"shift"|"alt"]` 包 down→click→up
- `input.type text [clear_first]`：`SendInput KEYBDINPUT KEYEVENTF_UNICODE` (VK_PACKET)，**不污染剪贴板 + 绕过 IME**（之前 SendKeys ^v 会触发中文输入法候选框）
- `input.key combo`：modifier+main VK 数组 SendInput；支持 `cmd/win/ctrl/shift/alt+<letter>/F1-F12/return/escape/...`；未识别键名 fall back SendKeys
- `input.scroll point dy_px dx_px`：`SendInput MOUSEINPUT MOUSEEVENTF_WHEEL/HWHEEL`，正/负数自动 32-bit 位级强转 uint
- `input.drag from to_point_px steps duration_ms`：SendInput LEFT_DOWN → SetCursorPos 逐步 → LEFT_UP

`mouse_event` 在 Win10+ 已 deprecated，全部走 SendInput；高完整度 app 仍受 UIPI 限制。

## 6. AX：UIA 主路径 + MSAA fallback

### 6.1 UI Automation（`ax.dump` 主路径）

- `AutomationElement.FromHandle` → `TreeWalker.ControlViewWalker` 遍历
- `ax.dump` 参数：
  - `max_nodes` (默认 500) / `max_depth` (默认 6)
  - **`interactive_only: true`** — walker 剪枝：只 emit Button/Edit/Link/CheckBox/MenuItem/Tab/ListItem 等带语义节点；CEF 深树场景从 500 缩到几十
  - **`skip_empty: true`** — 过滤无 name/desc/class 的 Pane/Group/Custom/Image（CEF 90% 是这种空 Pane）
  - **`viewport_norm: [nx,ny,nw,nh]`** — bbox 与视口不相交的子树整个跳过

### 6.2 MSAA fallback（`ax.dump_msaa` / 自动）

老 Win32 / MFC / GDI 自绘 app UIA 看不到，但 IAccessible 能拿到（`AccessibleObjectFromWindow + AccessibleChildren`）。

- `ax.dump` 自动 fallback：UIA 节点 < 3 时跑 MSAA，取节点数大者返回
- `ax.dump_msaa` 强制走 MSAA（调试 / 比较两条路径）

### 6.3 `input.ax_press`（UIA InvokePattern）

`input.ax_press handle norm` — `AutomationElement.FromPoint(x,y)` 后依次试：

1. `InvokePattern.Invoke()`（普通按钮 / 菜单项 / 链接）
2. `SelectionItemPattern.Select()`（ListItem / TabItem）
3. `TogglePattern.Toggle()`（CheckBox / 开关）
4. `ExpandCollapsePattern.Expand()`（TreeView / 折叠面板）

**等价 macOS AXPress**。适用 WinForms / WPF / UWP / WinUI / Win32 native；**不适用** CEF 网页内容（Steam/Discord/Edge — UIA 树只看到 `Chrome_RenderWidgetHostHWND` 空壳）+ DirectX 游戏自绘 UI。

## 7. OCR：Windows.Media.Ocr (WinRT)

`ocr.recognize_rect rect` / `ocr.recognize_window handle [region_norm]` / `ocr.languages`

- `recognize_rect`：GDI `CopyFromScreen` → BitmapDecoder → SoftwareBitmap → OcrEngine。**目标窗口必须可见 + 前台**
- `recognize_window`：`PrintWindow` 抓窗口位图喂 OCR。**不依赖前台 / 可见性**——屏外 workspace / 被遮挡窗口都能 OCR。CLI `click-text` 在 Windows 上自动选这条路
- 语言：`AvailableRecognizerLanguages` 看装了哪些（默认 en-US；中文需"中文(简体, 中国)"+ 勾选 OCR）
- 性能：首次 ~1s（WinRT 懒加载），warm 1200×600 ≈ 170ms（约 160 词）
- 单边限制 10000px；不返回 per-word confidence（统一 1.0；macOS Vision framework 给真值）

## 8. 窗口前台（CEF / Steam / Discord 难题）

Win10+ UIPI 经常拒 `SetForegroundWindow`。helper `Raise-Window-Strong` 4 招：

1. `SwitchToThisWindow`（Windows Alt+Tab 用的同一 undocumented API；对 CEF app 几乎必成）
2. `AttachThreadInput` hack
3. Alt-key 抖动重置前台锁定计时器 + `SetForegroundWindow`
4. minimize + restore 兜底（视觉跳动）

**注意 testing artifact**：UIPI 要求调用方 = 前台进程。agent 通过 MCP host 跑时，host 终端是前台 → raise 成功；纯自动化 / CI 中无终端前台 → raise 可能失败。doctor --watch 时观察。

## 9. window.list 高级选项

```js
{ filter: { include_invisible: true } }
```

默认只列可见 + 有标题的窗口。`include_invisible: true` 也返回 hidden modal dialog（如 Steam 卸载对话框预创建在 -32000,-32000）+ 无标题 popup。

## 10. CLI 命令族（跨平台同名 — 我把所有探索命令都打到 Windows）

| 命令 | 用途 | Windows 状态 |
| ---- | ---- | ----------- |
| `vision-mcp displays [--json]` | 列所有显示器 + per-monitor DPI | ✅ |
| `vision-mcp capsule <app> [--display id]` | ensure + attach + migrate | ✅ |
| `vision-mcp restore <app>` | 迁回主屏中央 | ✅ |
| `vision-mcp live-view <app>` | 浏览器实时看 capsule + 接管 | ✅ |
| `vision-mcp snapshot <app> [--out]` | 截图 + AX 候选 + state match | ✅ |
| **`vision-mcp annotated <app> [--grid-step]`** | 截图叠加网格 + 候选框 + `#N label`，让 agent 说 "click #7" | ✅（AX 空时 OCR 兜底） |
| `vision-mcp click-text <app> --text` | OCR 找文字 → click 中心；Windows 走 PrintWindow OCR（屏外可用） | ✅ |
| `vision-mcp ax-press <app> --norm x,y` | UIA InvokePattern | ✅ |
| `vision-mcp build / explore / record / discover` | 探索建图 | ✅ |
| **`vision-mcp doctor [--watch sec]`** | 一键自检（OS / PS / helper / DPI / OCR 语言 / displays / GDI handle leak） | ✅（Windows 独有 + macOS health.snapshot 也补了） |
| `vision-mcp install-helper [--silent]` | 自检 PS5.1 + 写部署说明（不再尝试 ps2exe） | ✅ |

## 11. 已知限制

- **不创建系统级虚拟显示器**（IDD 驱动签名 + 企业部署，不在 MVP）
- **UAC 高完整度 app**：vision-mcp 整个进程必须 elevated 才能 SendInput / UIA / capture
- **DirectX 全屏 / 反作弊**：PrintWindow + SendInput 可能被拒；标 unsupported
- **CEF / Chromium app** (Steam/Discord/VS Code/Edge)：UIA 只看 `Chrome_RenderWidgetHostHWND` 空壳，DOM 元素拿不到 → map 必须 OCR + bbox（见 `map-design.md §4`）
- **PowerShell 5.1 only**：pwsh 7 / .NET Core 不能 Add-Type UIAutomationClient
- **OCR 语言包**：默认装 en-US；中文 / 日文 / 韩文需手动添加语言包并勾选 OCR
- **Windows.Graphics.Capture (WGC)**：能抓 DirectX 窗口比 PrintWindow 快 5-10x，但需 C# / Rust 编译 WinRT 绑定；roadmap

## 12. 平台差异速查（跟 macOS 对照）

| 行为 | macOS | Windows |
| ---- | ----- | ------- |
| Modifier 键 | `cmd+s` `cmd+f` `cmd+[` | `ctrl+s` `ctrl+f` `alt+left` |
| Back 导航 | `cmd+[` / 工具栏 ◁ | `alt+left` / 浏览器 Back |
| 关菜单 / 模态 | `Escape` | `Escape` |
| AX 拿不到内容时 | osascript / Vision OCR 兜底 | MSAA / Windows.Media.Ocr 兜底 |
| 强制窗口前台 | `NSWorkspace.activate` | `SwitchToThisWindow` (Alt+Tab 同 API) |
| 现代截图 API | ScreenCaptureKit (macOS 14+) | PrintWindow PW_RENDERFULLCONTENT (Win 8.1+) |
| 中文输入 | NSPasteboard 粘贴 | SendInput VK_PACKET（绕过 IME，不污染剪贴板）|
| 屏外 OCR | screencapture window mode | PrintWindow → OcrEngine |
| 健康检查 | `health.snapshot` (mach_task_basic_info) | `health.snapshot` (GetGuiResources GDI/USER) |

写 cross-platform workflow 时把 modifier 写到 step.params 由 agent 按平台覆盖：

```yaml
# region.kbd.save 通用：control 不绑 combo
- id: kbd_save
  action_types: [key]
# workflow 步骤按平台传
steps:
  - action_id: kbd.kbd_save
    params: { combo: "ctrl+s" }   # 或 "cmd+s" (macOS)
```

或在 map 里写 `app.platform: any` 时为两平台分别给一份 workflow。
