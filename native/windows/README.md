# vision-mcp-helper (Windows)

骨架实现：PowerShell 写的 JSON-RPC sidecar，与 macOS swift helper 同协议。

## 直接运行

```powershell
powershell -ExecutionPolicy Bypass -File src/vision-mcp-helper.ps1
```

vision-mcp core 通过 `VISION_MCP_NATIVE_HELPER` 环境变量找到它。在 Windows 下：

```powershell
$env:VISION_MCP_NATIVE_HELPER = "powershell"
# 或者编译为 exe（推荐）
```

## 编译为 exe（生产推荐）

```powershell
Install-Module ps2exe -Scope CurrentUser
Invoke-PS2EXE -inputFile src\vision-mcp-helper.ps1 -outputFile vision-mcp-helper.exe -noConsole
```

之后用：
```
$env:VISION_MCP_NATIVE_HELPER = "C:\path\to\vision-mcp-helper.exe"
```

## 已实现的方法

| RPC | 实现 | 性能 |
| --- | ---- | ---- |
| `version` | 返回 `{version, platform=windows}` | < 5ms |
| `capsule.list_displays` | `System.Windows.Forms.Screen.AllScreens` | < 50ms |
| `capsule.ensure_virtual_display` | 暂无虚拟显示器，返回主屏 | - |
| `window.list` | `EnumWindows + GetWindowText + GetWindowRect` | ~50ms |
| `window.get` | listWindows + filter | ~50ms |
| `window.move` | `MoveWindow + SetForegroundWindow` | ~150ms |
| `window.activate` | `SetForegroundWindow` | < 10ms |
| `capture.rect` | `Graphics.CopyFromScreen` → PNG | ~200ms |
| `input.click` | `SetCursorPos + mouse_event` | < 10ms |
| `input.type` | 剪贴板粘贴（支持中文 / Unicode） | ~100ms |
| `input.key` | `SendKeys.SendWait` | < 50ms |
| `input.scroll` | `mouse_event(MOUSEEVENTF_WHEEL)` | < 10ms |

## 未实现 / 后续

- **OCR**：Windows 10+ 有 `Windows.Media.Ocr`，可用类似 swift Vision 框架的封装。
- **AX 树 dump**：用 `System.Windows.Automation.AutomationElement` 树遍历；性能可能不如 macOS swift，需测试。
- **annotated snapshot**：用 `System.Drawing.Graphics` 在 Bitmap 上画 grid + bbox 标签后输出 PNG。
- **IDD 虚拟显示器**：需要驱动签名，生产推荐与 IddCx sample 集成；MVP 用主屏 OK。
- **Windows.Graphics.Capture**：比 BitBlt 快 5-10x，但需要 WinRT 绑定，编译为 C# exe 更简洁。

## 限制

- PowerShell 启动 ~400ms，每次冷启动慢。推荐编译为 exe。
- `SendKeys` 在 elevated app 上不工作；vision-mcp 用 `INPUT` API 替代更稳。
- `Graphics.CopyFromScreen` 在 fullscreen DirectX app 上拿不到画面；需要切到 Windows.Graphics.Capture。

## 与 macOS helper 等价的 protocol

```
> {"id":"1","method":"capsule.list_displays"}
< {"id":"1","result":[{"id":"display-0", "bounds":{...}, "scale":1.0, ...}]}

> {"id":"2","method":"input.click","params":{"point":{"x":500,"y":400}}}
< {"id":"2","result":{"ok":true}}
```
