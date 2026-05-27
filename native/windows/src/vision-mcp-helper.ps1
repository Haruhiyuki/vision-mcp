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

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

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

# ---------- JSON 输出 ----------

function Send-Result($id, $result) {
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
    $out = @()
    for ($i = 0; $i -lt $screens.Length; $i++) {
        $s = $screens[$i]
        # 试着拿 per-monitor DPI（Win10+）；老 Windows 失败时回退 96
        $dpi = 96
        try {
            $hwnd = [System.Windows.Forms.Form]::ActiveForm.Handle
            if ($hwnd) { $dpi = [Win32]::GetDpiForWindow($hwnd) }
        } catch { }
        $kind = if ($s.Primary) { "primary" } else { "extended" }
        $out += @{
            id                       = "display-$i"
            bounds                   = @{ x = $s.Bounds.X; y = $s.Bounds.Y; width = $s.Bounds.Width; height = $s.Bounds.Height }
            work_area                = @{ x = $s.WorkingArea.X; y = $s.WorkingArea.Y; width = $s.WorkingArea.Width; height = $s.WorkingArea.Height }
            scale                    = [Math]::Round($dpi / 96.0, 2)
            dpi_x                    = $dpi
            dpi_y                    = $dpi
            refresh_rate_hz          = 60
            is_primary               = $s.Primary
            is_virtual               = $false
            kind                     = $kind
            name                     = $s.DeviceName
            native_handle            = "$i"
        }
    }
    return @(,$out)
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
        $pid = 0
        [Win32]::GetWindowThreadProcessId($hWnd, [ref]$pid) | Out-Null
        $procName = try { (Get-Process -Id $pid -ErrorAction Stop).ProcessName } catch { "?" }
        $isFg = ([Win32]::GetForegroundWindow() -eq $hWnd)
        $script:tmpList += @{
            id            = "$hWnd"
            title         = $title
            process_name  = $procName
            process_id    = $pid
            bounds        = @{ x = $rect.left; y = $rect.top; width = $rect.right - $rect.left; height = $rect.bottom - $rect.top }
            client_bounds = @{ x = $rect.left; y = $rect.top; width = $client.right - $client.left; height = $client.bottom - $client.top }
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
    $list = $script:tmpList
    if ($filter) {
        if ($filter.process_name) { $list = $list | Where-Object { $_.process_name -eq $filter.process_name } }
        if ($filter.title_regex)  { $list = $list | Where-Object { $_.title -match $filter.title_regex } }
        if ($filter.class_name)   { $list = $list | Where-Object { $_.class_name -eq $filter.class_name } }
    }
    return @(,$list)
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

# 强力 raise：直接 SetForegroundWindow 不一定成功（前台锁定保护）；
# 用 AttachThreadInput 把当前线程"附加"到目标窗口的输入队列再 raise。
function Raise-Window-Strong($hwnd) {
    [Win32]::SetForegroundWindow($hwnd) | Out-Null
    if ([Win32]::GetForegroundWindow() -ne $hwnd) {
        $fgPid = 0
        $fgThread = [Win32]::GetWindowThreadProcessId([Win32]::GetForegroundWindow(), [ref]$fgPid)
        $curThread = [Win32]::GetCurrentThreadId()
        [Win32]::AttachThreadInput($curThread, $fgThread, $true) | Out-Null
        [Win32]::BringWindowToTop($hwnd) | Out-Null
        [Win32]::SetForegroundWindow($hwnd) | Out-Null
        [Win32]::AttachThreadInput($curThread, $fgThread, $false) | Out-Null
    }
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
    $idx = [int]($displayId -replace "display-", "")
    $screens = [System.Windows.Forms.Screen]::AllScreens
    if ($idx -lt 0 -or $idx -ge $screens.Length) { return $null }
    $s = $screens[$idx]
    $rect = @{ x = $s.Bounds.X; y = $s.Bounds.Y; width = $s.Bounds.Width; height = $s.Bounds.Height }
    $r = Capture-Rect $rect
    $r.display_id = $displayId
    $r.scale = [Math]::Round((try { [Win32]::GetDpiForWindow([Win32]::GetForegroundWindow()) } catch { 96 }) / 96.0, 2)
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
    # 用剪贴板 + Ctrl+V 支持任意 Unicode（SendKeys 不支持非 ASCII）
    [System.Windows.Forms.Clipboard]::SetText($text)
    Start-Sleep -Milliseconds 60
    [System.Windows.Forms.SendKeys]::SendWait("^v")
}

function Post-Key($combo) {
    $s = $combo.ToLower().Replace("cmd+", "^").Replace("ctrl+", "^").Replace("shift+", "+").Replace("alt+", "%").Replace("option+", "%")
    $s = $s -replace "\breturn\b", "{ENTER}" `
            -replace "\benter\b", "{ENTER}" `
            -replace "\bescape\b|\besc\b", "{ESC}" `
            -replace "\btab\b", "{TAB}" `
            -replace "\bspace\b", " " `
            -replace "\bup\b", "{UP}" `
            -replace "\bdown\b", "{DOWN}" `
            -replace "\bleft\b", "{LEFT}" `
            -replace "\bright\b", "{RIGHT}" `
            -replace "\bdelete\b|\bbackspace\b", "{BACKSPACE}" `
            -replace "\bhome\b", "{HOME}" `
            -replace "\bend\b", "{END}" `
            -replace "\bpageup\b", "{PGUP}" `
            -replace "\bpagedown\b", "{PGDN}"
    [System.Windows.Forms.SendKeys]::SendWait($s)
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
            $node = @{
                role  = $role
                name  = $name
                desc  = $autoId
                class = $cls
                pos   = @($bb.X, $bb.Y)
                size  = @($bb.Width, $bb.Height)
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
            "capsule.list_displays"           { Send-Result $id (List-Displays); break }
            "capsule.ensure_virtual_display"  { Send-Result $id ((List-Displays)[0]); break }
            "capsule.ensure_workspace_display"{ Send-Result $id ((List-Displays)[0]); break }
            "window.list"                     { Send-Result $id (List-Windows $p.filter); break }
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
                Send-Result $id (Dump-UIA-Tree $p.handle $maxNodes $maxDepth)
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
                $r = Capture-Display $p.display_id
                if ($r) { Send-Result $id $r } else { Send-Error $id "display not found" }
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
                $dy = if ($p.dy_px) { [int]$p.dy_px } else { 0 }
                [Win32]::SetCursorPos([int]$p.point.x, [int]$p.point.y) | Out-Null
                [Win32]::mouse_event(0x0800, 0, 0, -$dy, [IntPtr]::Zero)
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
