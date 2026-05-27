# vision-mcp-helper (Windows)
#
# 长寿命 JSON-RPC sidecar：从 stdin 按行读 JSON 命令，到 stdout 写响应。
#
# 协议同 macOS swift helper（packages/core/src/platform/native-bridge.ts 调用）。
# 用 Win32 P/Invoke + UI Automation + System.Drawing 实现。
#
# 启动：
#   powershell -ExecutionPolicy Bypass -File vision-mcp-helper.ps1
# 生产推荐编译为 exe（启动 ~10ms vs PowerShell ~400ms）：
#   Install-Module -Name ps2exe -Scope CurrentUser
#   Invoke-ps2exe vision-mcp-helper.ps1 vision-mcp-helper.exe
#
# 当前实现的 RPC（与 macOS helper 同协议）：
#   version
#   capsule.list_displays / capsule.ensure_virtual_display / capsule.ensure_workspace_display
#   window.list / window.get / window.move / window.restore / window.activate / window.raise
#   capture.rect / capture.rect_annotated / capture.window / capture.display
#   ax.dump                              ← UI Automation tree dump
#   input.click / input.type / input.key / input.scroll / input.drag
#   input.ax_press                        ← UI Automation InvokePattern (等价 macOS AXPress)
#   input.subscribe                       ← no-op（设计文档 §8 lease 用键盘热键打断）
#
# 已知限制（Windows 平台特性）：
#   - UAC 高完整度等级 app（任务管理器等）：SendInput 会被拒绝。需要 helper 以
#     管理员身份运行才能注入到这类窗口。
#   - DPI per-monitor：本 helper 默认按 96 DPI 报告；进程必须声明
#     PROCESS_PER_MONITOR_DPI_AWARE 才能拿真实 DPI（生产应用 manifest 声明）。
#   - 反作弊 / 游戏全屏：SendInput / BitBlt 都可能被拒；建议跳过这类 app。
#   - BitBlt 抓 GPU 加速窗口（DirectX）可能黑屏；生产建议切到 Windows.Graphics.Capture
#     （需要 C# / Rust 编译，PowerShell 难直接调）。

# ---------- 启动期：UTF-8 stdout，避免中文窗口标题 / OCR 文本乱码 ----------
# 必须在任何 Send-Result 之前设置；ps2exe 产物没有 profile.ps1 不会自动配。
try {
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
    [Console]::InputEncoding  = New-Object System.Text.UTF8Encoding($false)
    $OutputEncoding = [Console]::OutputEncoding
} catch { }

# PowerShell 7 / pwsh.exe 无法 Add-Type UIAutomationClient（依赖 WPF / .NET Framework）。
# 提前检测并给出可识别的错误码，让 NativeBridge 能 fallback 到 powershell.exe。
if ($PSVersionTable.PSEdition -eq 'Core') {
    [Console]::Out.WriteLine('{"id":null,"error":"vision-mcp-helper 必须用 Windows PowerShell 5.1 (powershell.exe) 运行；当前是 pwsh.exe (PowerShell Core)，无法加载 UIAutomationClient。","code":"PWSH_INCOMPATIBLE"}')
    [Console]::Out.Flush()
    exit 2
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
# WindowsBase 才有 System.Windows.Point —— UIA-Invoke-At-Point 需要。
# UIAutomationClient 不自动拉 WindowsBase。
Add-Type -AssemblyName WindowsBase
Add-Type -AssemblyName PresentationCore

# Win32 互操作：窗口/输入/DPI/HDC
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public class Win32 {
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
    [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hWnd, out RECT lpRect);
    [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr hWnd, int X, int Y, int nWidth, int nHeight, bool bRepaint);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out int lpdwProcessId);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
    // SwitchToThisWindow 是 Windows 自己 Alt+Tab 用的 API（undocumented but stable since XP）；
    // 在 Win10+ UIPI 锁前台时仍能把窗口拉到前台
    [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr hWnd, bool fUnknown);
    [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hWnd, ref POINT lpPoint);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT lpPoint);
    [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, int dx, int dy, uint dwData, IntPtr dwExtraInfo);
    [DllImport("user32.dll")] public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
    [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdcBlt, uint nFlags);
    [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr hObject);
    [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleDC(IntPtr hdc);
    [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleBitmap(IntPtr hdc, int nWidth, int nHeight);
    [DllImport("gdi32.dll")] public static extern IntPtr SelectObject(IntPtr hdc, IntPtr hgdiobj);
    [DllImport("gdi32.dll")] public static extern bool BitBlt(IntPtr hdcDest, int nXDest, int nYDest, int nWidth, int nHeight, IntPtr hdcSrc, int nXSrc, int nYSrc, uint dwRop);
    [DllImport("gdi32.dll")] public static extern bool DeleteDC(IntPtr hdc);

    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int left, top, right, bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int x, y; }

    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT { public int type; public InputUnion u; }

    [StructLayout(LayoutKind.Explicit)]
    public struct InputUnion {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }

    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }
}
"@

# ---------- 启动期：声明 DPI awareness + 检查 integrity level ----------

try {
    # PROCESS_PER_MONITOR_DPI_AWARE = 2；若 ps2exe 编译版没有 manifest 声明，此 API 至少让本进程拿真 DPI
    Add-Type -TypeDefinition '[System.Runtime.InteropServices.DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int v);' -Name DpiAware -Namespace W32
    [W32.DpiAware]::SetProcessDpiAwareness(2) | Out-Null
} catch { }

$script:isElevated = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

# 多显示器 + per-monitor DPI：MonitorFromPoint + GetDpiForMonitor
try {
    Add-Type @"
using System;
using System.Runtime.InteropServices;
public class DpiUtil {
    [DllImport("user32.dll")] public static extern IntPtr MonitorFromPoint(POINT pt, uint dwFlags);
    [DllImport("shcore.dll")] public static extern int GetDpiForMonitor(IntPtr hmonitor, int dpiType, out uint dpiX, out uint dpiY);
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int x; public int y; }
    public const uint MONITOR_DEFAULTTONEAREST = 2;
    public const int MDT_EFFECTIVE_DPI = 0;
}
"@
} catch { }

function Get-MonitorDpiForBounds($bounds) {
    # 在 monitor 中心取一个点，让 MonitorFromPoint 选中该屏；再 GetDpiForMonitor。
    # Win 8.1+ 才有 GetDpiForMonitor；老 Windows 上 catch 返回 96。
    try {
        $cx = [int]($bounds.X + $bounds.Width / 2)
        $cy = [int]($bounds.Y + $bounds.Height / 2)
        $pt = New-Object DpiUtil+POINT
        $pt.x = $cx; $pt.y = $cy
        $hMon = [DpiUtil]::MonitorFromPoint($pt, [DpiUtil]::MONITOR_DEFAULTTONEAREST)
        $dx = 0; $dy = 0
        $hr = [DpiUtil]::GetDpiForMonitor($hMon, [DpiUtil]::MDT_EFFECTIVE_DPI, [ref]$dx, [ref]$dy)
        if ($hr -eq 0 -and $dx -gt 0) {
            return @{ x = [int]$dx; y = [int]$dy }
        }
    } catch { }
    return @{ x = 96; y = 96 }
}

# ---------- JSON 输出 ----------
# 重要：PowerShell 5.1 的 ConvertTo-Json 对 1-element 数组会展平成单对象。
# 这会让 JS 适配器拿到 result={...} 而非 result=[{...}]，触发 "not iterable"。
# 对策：array-returning endpoints 调 Send-Result -AsArray；Send-Result 内部
# 把值放进 ArrayList（ConvertTo-Json 对 ArrayList 即使 0/1 元素也保持 [...]）。

function Send-Result($id, $result, [switch]$AsArray) {
    if ($AsArray) {
        $al = New-Object System.Collections.ArrayList
        if ($null -ne $result) {
            if ($result -is [System.Collections.IEnumerable] -and $result -isnot [string] -and $result -isnot [hashtable]) {
                foreach ($x in $result) { [void]$al.Add($x) }
            } else {
                [void]$al.Add($result)
            }
        }
        $result = $al
    }
    $obj = @{ id = $id; result = $result }
    [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 12))
    [Console]::Out.Flush()
}

function Send-Error($id, $message, $code = "UNKNOWN") {
    $obj = @{ id = $id; error = $message; code = $code }
    [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress))
    [Console]::Out.Flush()
}

# ---------- Displays ----------

function List-Displays {
    $screens = [System.Windows.Forms.Screen]::AllScreens
    $out = New-Object System.Collections.ArrayList
    for ($i = 0; $i -lt $screens.Length; $i++) {
        $s = $screens[$i]
        # per-monitor DPI（Win 8.1+ MDT_EFFECTIVE_DPI）；老 Windows 回退 96
        $dpi = Get-MonitorDpiForBounds $s.Bounds
        $kind = if ($s.Primary) { "primary" } else { "extended" }
        [void]$out.Add(@{
            id                       = "display-$i"
            bounds                   = @{ x = $s.Bounds.X; y = $s.Bounds.Y; width = $s.Bounds.Width; height = $s.Bounds.Height }
            work_area                = @{ x = $s.WorkingArea.X; y = $s.WorkingArea.Y; width = $s.WorkingArea.Width; height = $s.WorkingArea.Height }
            scale                    = [Math]::Round($dpi.x / 96.0, 2)
            dpi_x                    = $dpi.x
            dpi_y                    = $dpi.y
            refresh_rate_hz          = 60
            is_primary               = $s.Primary
            is_virtual               = $false
            kind                     = $kind
            name                     = $s.DeviceName
            native_handle            = "$i"
        })
    }
    # 返回 ArrayList；调用方 Send-Result -AsArray 强制 JSON 数组
    return $out
}

# ---------- Windows ----------

function List-Windows($filter) {
    $cb = [Win32+EnumWindowsProc] {
        param($hWnd, $lParam)
        if (-not [Win32]::IsWindowVisible($hWnd)) { return $true }
        $len = [Win32]::GetWindowTextLength($hWnd)
        if ($len -eq 0) { return $true }
        $sb = New-Object System.Text.StringBuilder ($len + 1)
        [Win32]::GetWindowText($hWnd, $sb, $sb.Capacity) | Out-Null
        $title = $sb.ToString()
        $rect = New-Object Win32+RECT
        [Win32]::GetWindowRect($hWnd, [ref]$rect) | Out-Null
        $client = New-Object Win32+RECT
        [Win32]::GetClientRect($hWnd, [ref]$client) | Out-Null
        # $pid 是 PowerShell 自动只读变量（当前进程的 PID）——必须用其他名字
        $wpid = 0
        [Win32]::GetWindowThreadProcessId($hWnd, [ref]$wpid) | Out-Null
        $procName = try { (Get-Process -Id $wpid -ErrorAction Stop).ProcessName } catch { "?" }
        $isFg = ([Win32]::GetForegroundWindow() -eq $hWnd)
        # GetClientRect 总返回 (0,0) 起点——客户区屏幕坐标要 ClientToScreen 一次
        $clientOrigin = New-Object Win32+POINT
        $clientOrigin.x = 0; $clientOrigin.y = 0
        [Win32]::ClientToScreen($hWnd, [ref]$clientOrigin) | Out-Null
        $script:tmpList += @{
            id            = "$hWnd"
            title         = $title
            process_name  = $procName
            process_id    = $wpid
            bounds        = @{ x = $rect.left; y = $rect.top; width = $rect.right - $rect.left; height = $rect.bottom - $rect.top }
            client_bounds = @{ x = $clientOrigin.x; y = $clientOrigin.y; width = $client.right - $client.left; height = $client.bottom - $client.top }
            is_minimized  = [bool][Win32]::IsIconic($hWnd)
            is_maximized  = [bool][Win32]::IsZoomed($hWnd)
            is_fullscreen = $false
            is_foreground = $isFg
            native_handle = "$hWnd"
        }
        return $true
    }
    $script:tmpList = @()
    [Win32]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
    # filter 都加 @(...) 包装：单元素 Where-Object 结果会被 PowerShell 展平成标量
    $list = $script:tmpList
    if ($filter) {
        if ($filter.process_name) { $list = @($list | Where-Object { $_.process_name -eq $filter.process_name }) }
        if ($filter.title_regex)  { $list = @($list | Where-Object { $_.title -match $filter.title_regex }) }
        if ($filter.class_name)   { $list = @($list | Where-Object { $_.class_name -eq $filter.class_name }) }
    }
    # 转 ArrayList，配合 Send-Result -AsArray 强制 JSON 数组（PS 5.1 ConvertTo-Json
    # 默认会把 1-element 数组展平成单对象，让 JS 适配器 "not iterable" 报错）
    $al = New-Object System.Collections.ArrayList
    foreach ($w in $list) { [void]$al.Add($w) }
    return $al
}

function Move-Window-By-Handle($handle, $rect) {
    $hwnd = [IntPtr]::new([int64]$handle)
    [Win32]::ShowWindow($hwnd, 9) | Out-Null  # SW_RESTORE
    [Win32]::MoveWindow($hwnd, $rect.x, $rect.y, $rect.width, $rect.height, $true) | Out-Null
    Raise-Window-Strong $hwnd
    Start-Sleep -Milliseconds 120
    $r = New-Object Win32+RECT
    [Win32]::GetWindowRect($hwnd, [ref]$r) | Out-Null
    return @{
        bounds = @{ x = $r.left; y = $r.top; width = $r.right - $r.left; height = $r.bottom - $r.top }
        client_bounds = @{ x = $r.left; y = $r.top; width = $r.right - $r.left; height = $r.bottom - $r.top }
        native_handle = $handle
        is_minimized = $false
        is_foreground = $true
    }
}

# 强力 raise：直接 SetForegroundWindow 在 Win10+ 经常被 UIPI（前台锁定保护）拒绝。
# 用 4 招由轻到重逐个尝试，命中即停：
#   1. SetForegroundWindow 直来直去
#   2. AttachThreadInput hack（附到当前前台窗口的输入队列）
#   3. Alt-key 抖动 hack：Win32 把 Alt 按下视为"用户主动操作"，会重置前台锁定
#      计时器 → 下一次 SetForegroundWindow 几乎一定成功
#   4. Minimize + Restore 翻一翻（最后兜底，会有视觉跳动）
function Raise-Window-Strong($hwnd) {
    [Win32]::ShowWindow($hwnd, 9) | Out-Null  # SW_RESTORE（去最小化）
    # 1. SwitchToThisWindow（Alt+Tab 用的同一条 API，对 CEF/Steam/Discord 这种
    #    显式拒 SetForegroundWindow 的 app 也能生效；视觉上和 Alt+Tab 完全一样）
    [Win32]::SwitchToThisWindow($hwnd, $true)
    Start-Sleep -Milliseconds 50
    if ([Win32]::GetForegroundWindow() -eq $hwnd) { return }

    [Win32]::SetForegroundWindow($hwnd) | Out-Null
    if ([Win32]::GetForegroundWindow() -eq $hwnd) { return }

    # 2. AttachThreadInput
    $fgPid = 0
    $fgWnd = [Win32]::GetForegroundWindow()
    $fgThread = [Win32]::GetWindowThreadProcessId($fgWnd, [ref]$fgPid)
    $curThread = [Win32]::GetCurrentThreadId()
    [Win32]::AttachThreadInput($curThread, $fgThread, $true) | Out-Null
    [Win32]::BringWindowToTop($hwnd) | Out-Null
    [Win32]::SetForegroundWindow($hwnd) | Out-Null
    [Win32]::AttachThreadInput($curThread, $fgThread, $false) | Out-Null
    if ([Win32]::GetForegroundWindow() -eq $hwnd) { return }

    # 3. Alt-key 抖动：SendInput Alt down+up，把"用户最后输入"重置成本进程的事件
    #    然后立刻 SetForegroundWindow 几乎必成
    $altDown = New-Object Win32+INPUT
    $altDown.type = 1; $altDown.u.ki.wVk = 0x12; $altDown.u.ki.wScan = 0; $altDown.u.ki.dwFlags = 0; $altDown.u.ki.time = 0
    $altUp = New-Object Win32+INPUT
    $altUp.type = 1; $altUp.u.ki.wVk = 0x12; $altUp.u.ki.wScan = 0; $altUp.u.ki.dwFlags = 0x0002; $altUp.u.ki.time = 0
    $arr = New-Object 'Win32+INPUT[]' 2
    $arr[0] = $altDown; $arr[1] = $altUp
    [Win32]::SendInput(2, $arr, [System.Runtime.InteropServices.Marshal]::SizeOf([Type][Win32+INPUT])) | Out-Null
    Start-Sleep -Milliseconds 30
    [Win32]::SetForegroundWindow($hwnd) | Out-Null
    if ([Win32]::GetForegroundWindow() -eq $hwnd) { return }

    # 4. 最后兜底：minimize + restore（视觉跳动）
    [Win32]::ShowWindow($hwnd, 6) | Out-Null  # SW_MINIMIZE
    Start-Sleep -Milliseconds 50
    [Win32]::ShowWindow($hwnd, 9) | Out-Null  # SW_RESTORE
    [Win32]::SetForegroundWindow($hwnd) | Out-Null
}

# ---------- Capture ----------

function Capture-Rect($rect) {
    $bmp = New-Object System.Drawing.Bitmap $rect.width, $rect.height
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($rect.x, $rect.y, 0, 0, $bmp.Size)
    $g.Dispose()
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $bytes = $ms.ToArray()
    $bmp.Dispose()
    return @{
        png_base64 = [Convert]::ToBase64String($bytes)
        width      = $rect.width
        height     = $rect.height
    }
}

# 用 PrintWindow API 抓窗口内容（包含被遮挡 / 部分屏外的窗口）。
# 等价 macOS SCKit captureWindow。
# 失败时（DirectX 加速窗口）fallback 到 BitBlt。
function Capture-Window-By-Handle($handle) {
    $hwnd = [IntPtr]::new([int64]$handle)
    $r = New-Object Win32+RECT
    [Win32]::GetWindowRect($hwnd, [ref]$r) | Out-Null
    $w = $r.right - $r.left
    $h = $r.bottom - $r.top
    if ($w -le 0 -or $h -le 0) { return $null }
    $bmp = New-Object System.Drawing.Bitmap $w, $h
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $hdcBmp = $g.GetHdc()
    # PW_RENDERFULLCONTENT = 0x00000002（Win 8.1+ 支持 DWM 复合窗口）
    $ok = [Win32]::PrintWindow($hwnd, $hdcBmp, 2)
    $g.ReleaseHdc($hdcBmp)
    $g.Dispose()
    if (-not $ok) {
        # fallback：屏幕区域截图（屏外窗口拿不到内容）
        $bmp.Dispose()
        $rect = @{ x = $r.left; y = $r.top; width = $w; height = $h }
        $res = Capture-Rect $rect
        $res.via = "screen_bitblt"
        return $res
    }
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $bytes = $ms.ToArray()
    $bmp.Dispose()
    return @{
        png_base64 = [Convert]::ToBase64String($bytes)
        width      = $w
        height     = $h
        via        = "print_window"
    }
}

function Capture-Display($displayId) {
    if (-not $displayId) { return $null }
    $idx = [int]($displayId -replace "display-", "")
    $screens = [System.Windows.Forms.Screen]::AllScreens
    if ($idx -lt 0 -or $idx -ge $screens.Length) { return $null }
    $s = $screens[$idx]
    $rect = @{ x = $s.Bounds.X; y = $s.Bounds.Y; width = $s.Bounds.Width; height = $s.Bounds.Height }
    $r = Capture-Rect $rect
    $r.display_id = $displayId
    $dpi = Get-MonitorDpiForBounds $s.Bounds
    $r.scale = [Math]::Round($dpi.x / 96.0, 2)
    return $r
}

# 在 capture 之上画 grid + bbox。等价 macOS captureAnnotated。
function Capture-Rect-Annotated($rect, $boxes, $gridStep) {
    $cap = Capture-Rect $rect
    $bytes = [Convert]::FromBase64String($cap.png_base64)
    $ms = New-Object System.IO.MemoryStream
    $ms.Write($bytes, 0, $bytes.Length)
    $bmp = [System.Drawing.Image]::FromStream($ms)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $palette = @(
        [System.Drawing.Color]::FromArgb(220, 220, 60, 60),
        [System.Drawing.Color]::FromArgb(220, 60, 100, 220),
        [System.Drawing.Color]::FromArgb(220, 60, 200, 80),
        [System.Drawing.Color]::FromArgb(220, 230, 140, 30),
        [System.Drawing.Color]::FromArgb(220, 160, 60, 220),
        [System.Drawing.Color]::FromArgb(220, 40, 180, 200)
    )
    # 网格
    if ($gridStep -gt 0) {
        $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(90, 120, 120, 120), 1)
        $font = New-Object System.Drawing.Font "Segoe UI", 9
        $brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(180, 50, 100, 200))
        $t = $gridStep
        while ($t -lt 1.0) {
            $xp = [int]($t * $rect.width)
            $yp = [int]($t * $rect.height)
            $g.DrawLine($pen, $xp, 0, $xp, $rect.height)
            $g.DrawLine($pen, 0, $yp, $rect.width, $yp)
            $t += $gridStep
        }
        $pen.Dispose()
        $font.Dispose()
        $brush.Dispose()
    }
    # box
    $i = 0
    foreach ($b in $boxes) {
        $bx = $b.bbox_norm
        if ($bx -and $bx.Length -eq 4) {
            $col = $palette[$i % $palette.Length]
            $pen = New-Object System.Drawing.Pen $col, 2
            $rx = [int]($bx[0] * $rect.width)
            $ry = [int]($bx[1] * $rect.height)
            $rw = [int]($bx[2] * $rect.width)
            $rh = [int]($bx[3] * $rect.height)
            $g.DrawRectangle($pen, $rx, $ry, $rw, $rh)
            if ($b.label) {
                $font = New-Object System.Drawing.Font "Segoe UI", 10
                $brush = New-Object System.Drawing.SolidBrush $col
                $g.DrawString($b.label, $font, $brush, $rx + 2, $ry + 2)
                $font.Dispose()
                $brush.Dispose()
            }
            $pen.Dispose()
        }
        $i++
    }
    $g.Dispose()
    $ms2 = New-Object System.IO.MemoryStream
    $bmp.Save($ms2, [System.Drawing.Imaging.ImageFormat]::Png)
    $b64 = [Convert]::ToBase64String($ms2.ToArray())
    $bmp.Dispose()
    return @{
        png_base64 = $b64
        width      = $rect.width
        height     = $rect.height
        box_count  = $boxes.Length
    }
}

# ---------- Input ----------

function Post-Click($point, $button = "left", $count = 1) {
    [Win32]::SetCursorPos([int]$point.x, [int]$point.y) | Out-Null
    $down = if ($button -eq "right") { 0x0008 } elseif ($button -eq "middle") { 0x0020 } else { 0x0002 }
    $up   = if ($button -eq "right") { 0x0010 } elseif ($button -eq "middle") { 0x0040 } else { 0x0004 }
    for ($i = 0; $i -lt $count; $i++) {
        [Win32]::mouse_event($down, 0, 0, 0, [IntPtr]::Zero)
        [Win32]::mouse_event($up,   0, 0, 0, [IntPtr]::Zero)
        if ($i -lt $count - 1) { Start-Sleep -Milliseconds 50 }
    }
}

function Post-Drag($from, $to, $steps = 20, $durationMs = 200) {
    [Win32]::SetCursorPos([int]$from.x, [int]$from.y) | Out-Null
    [Win32]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)  # leftDown
    $sleepMs = [Math]::Max(1, [int]($durationMs / $steps))
    for ($i = 1; $i -le $steps; $i++) {
        $t = $i / $steps
        $x = [int]($from.x + ($to.x - $from.x) * $t)
        $y = [int]($from.y + ($to.y - $from.y) * $t)
        [Win32]::SetCursorPos($x, $y) | Out-Null
        [Win32]::mouse_event(0x0001, 0, 0, 0, [IntPtr]::Zero)  # mouseMove
        Start-Sleep -Milliseconds $sleepMs
    }
    [Win32]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)  # leftUp
}

function Post-Type($text) {
    # 用 SendInput + KEYEVENTF_UNICODE (VK_PACKET) 注入文本。
    # 优点（对照原 Clipboard + SendKeys ^v 方案）：
    #   - 不污染剪贴板
    #   - 不触发输入法候选框（VK_PACKET 走系统层 Unicode 通道，绕过 IME）
    #   - 对 elevated app（任务管理器等）仍可能被 UIPI 拒绝，但 SendKeys 同样被拒
    if (-not $text) { return }
    $chars = $text.ToCharArray()
    $inputs = New-Object 'Win32+INPUT[]' ($chars.Length * 2)
    for ($i = 0; $i -lt $chars.Length; $i++) {
        $down = New-Object Win32+INPUT
        $down.type = 1  # INPUT_KEYBOARD
        $down.u.ki.wVk = 0
        $down.u.ki.wScan = [uint16]([int][char]$chars[$i])
        $down.u.ki.dwFlags = 0x0004  # KEYEVENTF_UNICODE
        $down.u.ki.time = 0
        $down.u.ki.dwExtraInfo = [IntPtr]::Zero
        $inputs[$i * 2] = $down
        $up = New-Object Win32+INPUT
        $up.type = 1
        $up.u.ki.wVk = 0
        $up.u.ki.wScan = [uint16]([int][char]$chars[$i])
        $up.u.ki.dwFlags = 0x0004 -bor 0x0002  # KEYEVENTF_UNICODE | KEYEVENTF_KEYUP
        $up.u.ki.time = 0
        $up.u.ki.dwExtraInfo = [IntPtr]::Zero
        $inputs[$i * 2 + 1] = $up
    }
    [Win32]::SendInput([uint32]$inputs.Length, $inputs, [System.Runtime.InteropServices.Marshal]::SizeOf([Type][Win32+INPUT])) | Out-Null
}

# 字符串组合键名 → Win32 虚拟键码。覆盖 vision-mcp 常用按键
# （单字母 / 单数字直接走 ASCII 大写；其他按表查）。
$script:vkMap = @{
    "return" = 0x0D; "enter" = 0x0D;
    "escape" = 0x1B; "esc" = 0x1B;
    "tab" = 0x09; "space" = 0x20;
    "up" = 0x26; "down" = 0x28; "left" = 0x25; "right" = 0x27;
    "backspace" = 0x08; "delete" = 0x2E;
    "home" = 0x24; "end" = 0x23; "pageup" = 0x21; "pagedown" = 0x22;
    "insert" = 0x2D;
    "f1" = 0x70; "f2" = 0x71; "f3" = 0x72; "f4" = 0x73;
    "f5" = 0x74; "f6" = 0x75; "f7" = 0x76; "f8" = 0x77;
    "f9" = 0x78; "f10" = 0x79; "f11" = 0x7A; "f12" = 0x7B;
    "minus" = 0xBD; "-" = 0xBD;
    "equal" = 0xBB; "=" = 0xBB; "plus" = 0xBB;
    "comma" = 0xBC; "," = 0xBC;
    "period" = 0xBE; "." = 0xBE;
    "slash" = 0xBF; "/" = 0xBF;
    "semicolon" = 0xBA; ";" = 0xBA;
    "quote" = 0xDE; "'" = 0xDE;
    "backslash" = 0xDC; "\" = 0xDC;
    "lbracket" = 0xDB; "[" = 0xDB;
    "rbracket" = 0xDD; "]" = 0xDD;
    "backtick" = 0xC0; "``" = 0xC0;
}

# 把一个键名解析成 VK 码。失败返回 0。
function Resolve-Vk($name) {
    $n = $name.ToLower().Trim()
    if (-not $n) { return 0 }
    if ($script:vkMap.ContainsKey($n)) { return $script:vkMap[$n] }
    if ($n.Length -eq 1) {
        $c = [int][char]$n.ToUpper()
        # A-Z / 0-9 / 其他 ASCII 直接当 VK
        if (($c -ge 0x30 -and $c -le 0x39) -or ($c -ge 0x41 -and $c -le 0x5A)) { return $c }
    }
    return 0
}

# Post-Key：完整 SendInput 路径替代 SendKeys。
# 为何换：SendKeys 对 elevated app（任务管理器 / 反作弊）静默失败，且对中文 IME
# 状态不稳定。SendInput INPUT 数组直接走系统输入队列，权限边界由 UIPI 控制
# （提升 helper 整体进程权限即可）。
function Post-Key($combo) {
    if (-not $combo) { return }
    $parts = $combo -split "\+" | ForEach-Object { $_.Trim().ToLower() }
    $mods = New-Object System.Collections.ArrayList
    $main = $null
    foreach ($p in $parts) {
        switch ($p) {
            "cmd"     { [void]$mods.Add(0x5B) }   # VK_LWIN（macOS Cmd → Win 键）
            "win"     { [void]$mods.Add(0x5B) }
            "ctrl"    { [void]$mods.Add(0x11) }   # VK_CONTROL
            "control" { [void]$mods.Add(0x11) }
            "shift"   { [void]$mods.Add(0x10) }   # VK_SHIFT
            "alt"     { [void]$mods.Add(0x12) }   # VK_MENU
            "option"  { [void]$mods.Add(0x12) }
            default   { $main = $p }
        }
    }
    if (-not $main) { return }
    $mainVk = Resolve-Vk $main
    if ($mainVk -eq 0) {
        # 未识别的键名：fall back 到 SendKeys（最大兼容性）
        [System.Windows.Forms.SendKeys]::SendWait($combo)
        return
    }
    # 构造 INPUT 数组：modifiers down → main down → main up → modifiers up（反序）
    $count = $mods.Count * 2 + 2
    $inputs = New-Object 'Win32+INPUT[]' $count
    $idx = 0
    function Make-KeyInput([uint16]$vk, [bool]$up) {
        $i = New-Object Win32+INPUT
        $i.type = 1
        $i.u.ki.wVk = $vk
        $i.u.ki.wScan = 0
        $i.u.ki.dwFlags = if ($up) { 0x0002 } else { 0 }  # KEYEVENTF_KEYUP
        $i.u.ki.time = 0
        $i.u.ki.dwExtraInfo = [IntPtr]::Zero
        return $i
    }
    foreach ($m in $mods) { $inputs[$idx++] = Make-KeyInput $m $false }
    $inputs[$idx++] = Make-KeyInput $mainVk $false
    $inputs[$idx++] = Make-KeyInput $mainVk $true
    for ($i = $mods.Count - 1; $i -ge 0; $i--) { $inputs[$idx++] = Make-KeyInput $mods[$i] $true }
    [Win32]::SendInput([uint32]$count, $inputs, [System.Runtime.InteropServices.Marshal]::SizeOf([Type][Win32+INPUT])) | Out-Null
}

# ---------- UI Automation: AX tree dump + InvokePattern ----------
# 等价 macOS 的 AXUIElement 树 + AXPerformAction("AXPress")。
# 对支持 InvokePattern 的元素（普通按钮、菜单项、链接）等价"零鼠标点击"；
# 对 ListItem / TabItem 等用 SelectionItemPattern。

function Dump-UIA-Tree($handle, $maxNodes = 500, $maxDepth = 6) {
    $hwnd = [IntPtr]::new([int64]$handle)
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
    if (-not $root) { return @() }
    $out = New-Object System.Collections.ArrayList
    $stack = New-Object System.Collections.Stack
    $stack.Push(@{ el = $root; depth = 0; path = "win[0]" })
    while ($stack.Count -gt 0 -and $out.Count -lt $maxNodes) {
        $cur = $stack.Pop()
        $el = $cur.el
        if (-not $el) { continue }
        try {
            $info = $el.Current
            $role = $info.ControlType.ProgrammaticName  # 形如 "ControlType.Button"
            $name = $info.Name
            $autoId = $info.AutomationId
            $cls = $info.ClassName
            $bb = $info.BoundingRectangle
            # UIA 把不可见 / 未渲染的元素 BoundingRectangle 设成 Rect.Empty —
            # X/Y = double.PositiveInfinity, W/H = double.NegativeInfinity。
            # PowerShell 的 ConvertTo-Json 把 Infinity 直接写成裸字面量
            # ("pos":[Infinity,Infinity])，这是无效 JSON，会让 Node 端 parse_error
            # 后请求挂到 timeout。这里把 non-finite 全部归零（上层 normalize 会过滤掉
            # w/h<=0 的节点，正好排除这些不可见元素）。
            function ToFinite([double]$v) {
                if ([double]::IsInfinity($v) -or [double]::IsNaN($v)) { return 0.0 }
                return $v
            }
            $node = @{
                role  = $role
                name  = $name
                desc  = $autoId
                class = $cls
                pos   = @((ToFinite $bb.X), (ToFinite $bb.Y))
                size  = @((ToFinite $bb.Width), (ToFinite $bb.Height))
                depth = $cur.depth
                path  = $cur.path
            }
            [void]$out.Add($node)
            if ($cur.depth -lt $maxDepth) {
                $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
                $child = $walker.GetFirstChild($el)
                $idx = 0
                while ($child -and $idx -lt 60) {
                    $stack.Push(@{ el = $child; depth = $cur.depth + 1; path = "$($cur.path)/$role[$idx]" })
                    $child = $walker.GetNextSibling($child)
                    $idx++
                }
            }
        } catch { }
    }
    return @(,$out.ToArray())
}

# 对屏幕坐标点上的 UIAutomation element 直接调 InvokePattern.Invoke()。
# 找元素：FromPoint。然后尝试 Invoke / Toggle / Select 顺序。
function UIA-Invoke-At-Point($x, $y) {
    try {
        $pt = New-Object System.Windows.Point ([double]$x), ([double]$y)
        $el = [System.Windows.Automation.AutomationElement]::FromPoint($pt)
        if (-not $el) { return @{ ok = $false; via = "fromPoint_null" } }
        $info = $el.Current
        $role = $info.ControlType.ProgrammaticName
        $name = $info.Name
        # 1. Invoke
        $invokePat = $null
        if ($el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$invokePat)) {
            $invokePat.Invoke()
            return @{ ok = $true; via = "invoke_pattern"; matched_role = $role; matched_name = $name }
        }
        # 2. SelectionItem
        $selPat = $null
        if ($el.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$selPat)) {
            $selPat.Select()
            return @{ ok = $true; via = "selection_pattern"; matched_role = $role; matched_name = $name }
        }
        # 3. Toggle
        $togglePat = $null
        if ($el.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$togglePat)) {
            $togglePat.Toggle()
            return @{ ok = $true; via = "toggle_pattern"; matched_role = $role; matched_name = $name }
        }
        # 4. ExpandCollapse
        $expandPat = $null
        if ($el.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$expandPat)) {
            $expandPat.Expand()
            return @{ ok = $true; via = "expand_pattern"; matched_role = $role; matched_name = $name }
        }
        return @{ ok = $false; via = "no_pattern"; matched_role = $role; matched_name = $name }
    } catch {
        return @{ ok = $false; via = "exception"; error = $_.Exception.Message }
    }
}

# 等价 macOS axPressInWindowAtNorm：给 (handle, norm)，找窗口内 norm 位置元素并 Invoke。
function UIA-Invoke-At-Norm($handle, $normX, $normY) {
    $hwnd = [IntPtr]::new([int64]$handle)
    $r = New-Object Win32+RECT
    [Win32]::GetWindowRect($hwnd, [ref]$r) | Out-Null
    $x = [int]($r.left + $normX * ($r.right - $r.left))
    $y = [int]($r.top + $normY * ($r.bottom - $r.top))
    return UIA-Invoke-At-Point $x $y
}

# ---------- 主循环 ----------

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    # 防御 UTF-8 BOM（PowerShell Set-Content -Encoding utf8 / Windows 一些
    # 工具会在文本开头加 BOM）；ConvertFrom-Json 不接受 BOM 前缀。
    if ($line.Length -gt 0 -and $line[0] -eq [char]0xFEFF) { $line = $line.Substring(1) }
    $line = $line.Trim()
    if (-not $line) { continue }
    try {
        $msg = $line | ConvertFrom-Json
    } catch {
        Send-Error $null "bad request" "BAD_REQUEST"
        continue
    }
    $id = $msg.id
    $method = $msg.method
    $p = if ($msg.params) { $msg.params } else { @{} }
    try {
        switch ($method) {
            "version" {
                Send-Result $id @{ version = "0.2"; platform = "windows"; elevated = $script:isElevated }
                break
            }
            "capsule.list_displays"           { Send-Result $id (List-Displays) -AsArray; break }
            "capsule.ensure_virtual_display"  {
                $d = List-Displays
                if ($d.Count -eq 0) { Send-Error $id "no displays" "CAPSULE_DISPLAY_MISSING" } else { Send-Result $id $d[0] }
                break
            }
            "capsule.ensure_workspace_display"{
                # Windows 不创建虚拟显示器，但要挑稳定 display（参 macOS workspace_display
                # 行为）：选 work_area 最大且能容纳契约尺寸的显示器，优先 primary。
                $all = List-Displays
                if ($all.Count -eq 0) { Send-Error $id "no displays" "CAPSULE_DISPLAY_MISSING"; break }
                $minW = if ($p.geometry.width_px) { [int]$p.geometry.width_px } else { 0 }
                $minH = if ($p.geometry.height_px) { [int]$p.geometry.height_px } else { 0 }
                $fits = $all | Where-Object { $_.work_area.width -ge $minW -and $_.work_area.height -ge $minH }
                if (-not $fits) { $fits = $all }
                # 优先 primary，否则面积最大
                $pick = $fits | Sort-Object @{ Expression = { -[int]$_.is_primary }; Ascending = $true }, @{ Expression = { -($_.work_area.width * $_.work_area.height) }; Ascending = $true } | Select-Object -First 1
                Send-Result $id $pick
                break
            }
            "window.list"                     { Send-Result $id (List-Windows $p.filter) -AsArray; break }
            "window.get" {
                $list = List-Windows $null
                $found = $list | Where-Object { $_.native_handle -eq $p.handle -or $_.id -eq $p.handle } | Select-Object -First 1
                if ($found) { Send-Result $id $found } else { Send-Error $id "window not found" "WINDOW_NOT_FOUND" }
                break
            }
            "window.move"     { Send-Result $id (Move-Window-By-Handle $p.handle $p.rect); break }
            "window.restore"  { Send-Result $id (Move-Window-By-Handle $p.handle $p.snapshot.placement.bounds); break }
            "window.activate" {
                $hwnd = [IntPtr]::new([int64]$p.handle)
                Raise-Window-Strong $hwnd
                Send-Result $id @{ ok = $true }
                break
            }
            "window.raise" {
                $hwnd = [IntPtr]::new([int64]$p.handle)
                Raise-Window-Strong $hwnd
                Send-Result $id @{ ok = $true }
                break
            }
            "ax.dump" {
                $maxNodes = if ($p.max_nodes) { [int]$p.max_nodes } else { 500 }
                $maxDepth = if ($p.max_depth) { [int]$p.max_depth } else { 6 }
                Send-Result $id (Dump-UIA-Tree $p.handle $maxNodes $maxDepth) -AsArray
                break
            }
            "capture.rect" {
                Send-Result $id (Capture-Rect $p.rect)
                break
            }
            "capture.rect_annotated" {
                $gridStep = if ($p.grid_step) { [double]$p.grid_step } else { 0.0 }
                $boxes = if ($p.boxes) { $p.boxes } else { @() }
                Send-Result $id (Capture-Rect-Annotated $p.rect $boxes $gridStep)
                break
            }
            "capture.window" {
                $r = Capture-Window-By-Handle $p.handle
                if ($r) { Send-Result $id $r } else { Send-Error $id "capture failed" }
                break
            }
            "capture.display" {
                # 同时接受 display_id（macOS / 规范） 和 displayId（兼容旧 JS 适配器）
                $did = if ($p.display_id) { $p.display_id } else { $p.displayId }
                $r = Capture-Display $did
                if ($r) { Send-Result $id $r } else { Send-Error $id "display not found" "CAPSULE_DISPLAY_MISSING" }
                break
            }
            "input.click" {
                $button = if ($p.button) { $p.button } else { "left" }
                $count  = if ($p.click_count) { [int]$p.click_count } else { 1 }
                Post-Click $p.point $button $count
                Send-Result $id @{ ok = $true; via = "send_input" }
                break
            }
            "input.type" {
                if ($p.clear_first) {
                    # Cmd+A 等价 Ctrl+A → 选中全部 → backspace 清掉
                    [System.Windows.Forms.SendKeys]::SendWait("^a")
                    Start-Sleep -Milliseconds 30
                    [System.Windows.Forms.SendKeys]::SendWait("{BACKSPACE}")
                    Start-Sleep -Milliseconds 30
                }
                Post-Type $p.text
                Send-Result $id @{ ok = $true }
                break
            }
            "input.key" {
                Post-Key $p.combo
                Send-Result $id @{ ok = $true; combo = $p.combo }
                break
            }
            "input.scroll" {
                # dy_px：正值 = 向下滚（屏幕内容上移），与 macOS 一致。
                # mouse_event 的 dwData 期望的是有符号 short（一格 = 120）；
                # 但 DllImport 把它声明成 uint，PowerShell 不能直接传负数 ——
                # 把负值做 32-bit 位级强转成 uint 再传。
                $dy = if ($p.dy_px) { [int]$p.dy_px } else { 0 }
                $dx = if ($p.dx_px) { [int]$p.dx_px } else { 0 }
                [Win32]::SetCursorPos([int]$p.point.x, [int]$p.point.y) | Out-Null
                if ($dy -ne 0) {
                    $wheel = -$dy  # 负 dy = 向上 = wheel forward = positive WHEEL_DELTA
                    if ($wheel -lt 0) { $wheelU = [uint32]([int64]4294967296 + $wheel) } else { $wheelU = [uint32]$wheel }
                    [Win32]::mouse_event(0x0800, 0, 0, $wheelU, [IntPtr]::Zero)
                }
                if ($dx -ne 0) {
                    $wheel = $dx
                    if ($wheel -lt 0) { $wheelU = [uint32]([int64]4294967296 + $wheel) } else { $wheelU = [uint32]$wheel }
                    [Win32]::mouse_event(0x01000, 0, 0, $wheelU, [IntPtr]::Zero)  # MOUSEEVENTF_HWHEEL
                }
                Send-Result $id @{ ok = $true }
                break
            }
            "input.drag" {
                $steps = if ($p.steps) { [int]$p.steps } else { 20 }
                $dur   = if ($p.duration_ms) { [int]$p.duration_ms } else { 200 }
                Post-Drag $p.from $p.to_point_px $steps $dur
                Send-Result $id @{ ok = $true }
                break
            }
            "input.ax_press" {
                $norm = $p.norm
                if (-not $norm -or $norm.Length -ne 2) { Send-Error $id "norm [x,y] required"; break }
                $r = UIA-Invoke-At-Norm $p.handle $norm[0] $norm[1]
                Send-Result $id $r
                break
            }
            "input.subscribe" {
                # 暂不支持全局事件订阅；与 macOS helper 一致返回 no-op
                Send-Result $id @{ ok = $true }
                break
            }
            default { Send-Error $id "unknown method: $method"; break }
        }
    } catch {
        Send-Error $id $_.Exception.Message
    }
}
