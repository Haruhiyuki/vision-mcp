# vision-mcp-helper (Windows)
#
# 长寿命 JSON-RPC sidecar：从 stdin 按行读 JSON 命令，到 stdout 写响应。
#
# 协议同 macOS swift helper（packages/core/src/platform/native-bridge.ts 调用）。
# 用 .NET / System.Windows.Forms / UI Automation 实现。
#
# 启动：
#   powershell -ExecutionPolicy Bypass -File vision-mcp-helper.ps1
#
# 或者编译为 exe（推荐生产用）：
#   ps2exe -inputFile vision-mcp-helper.ps1 -outputFile vision-mcp-helper.exe
#
# 这是 P3 阶段的骨架：核心方法都实现了，但生产部署应该考虑：
#   - 用 C# 编译为 native exe（启动更快、依赖更少）
#   - IDD 虚拟显示器支持（需要驱动签名）
#   - DXGI / Windows.Graphics.Capture 替代 BitBlt（更快、支持 GPU 加速）

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

# Win32 互操作：移动窗口 / 取窗口列表 / 发输入
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
    [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr hWnd, int X, int Y, int nWidth, int nHeight, bool bRepaint);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr hWnd, out int lpdwProcessId);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, int dx, int dy, uint dwData, IntPtr dwExtraInfo);
    [DllImport("user32.dll")] public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int left, top, right, bottom; }

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

function Send-Result($id, $result) {
    $obj = @{ id = $id; result = $result }
    [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 8))
    [Console]::Out.Flush()
}

function Send-Error($id, $message, $code = "UNKNOWN") {
    $obj = @{ id = $id; error = $message; code = $code }
    [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress))
    [Console]::Out.Flush()
}

function List-Displays {
    $screens = [System.Windows.Forms.Screen]::AllScreens
    $out = @()
    for ($i = 0; $i -lt $screens.Length; $i++) {
        $s = $screens[$i]
        $out += @{
            id              = "display-$i"
            bounds          = @{ x = $s.Bounds.X; y = $s.Bounds.Y; width = $s.Bounds.Width; height = $s.Bounds.Height }
            work_area       = @{ x = $s.WorkingArea.X; y = $s.WorkingArea.Y; width = $s.WorkingArea.Width; height = $s.WorkingArea.Height }
            scale           = 1.0
            dpi_x           = 96
            dpi_y           = 96
            refresh_rate_hz = 60
            is_primary      = $s.Primary
            is_virtual      = $false
            native_handle   = "$i"
        }
    }
    return @(,$out)
}

function List-Windows($filter) {
    $list = @()
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
        $pid = 0
        [Win32]::GetWindowThreadProcessId($hWnd, [ref]$pid) | Out-Null
        $procName = try { (Get-Process -Id $pid -ErrorAction Stop).ProcessName } catch { "?" }
        $script:tmpList += @{
            id            = "$pid:0"
            title         = $title
            process_name  = $procName
            process_id    = $pid
            bounds        = @{ x = $rect.left; y = $rect.top; width = $rect.right - $rect.left; height = $rect.bottom - $rect.top }
            client_bounds = @{ x = $rect.left; y = $rect.top; width = $rect.right - $rect.left; height = $rect.bottom - $rect.top }
            is_minimized  = [bool][Win32]::IsIconic($hWnd)
            is_maximized  = $false
            is_fullscreen = $false
            is_foreground = $false
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
    }
    return @(,$list)
}

function Move-Window-By-Handle($handle, $rect) {
    $hwnd = [IntPtr]::new([int64]$handle)
    [Win32]::ShowWindow($hwnd, 9) | Out-Null  # SW_RESTORE
    [Win32]::MoveWindow($hwnd, $rect.x, $rect.y, $rect.width, $rect.height, $true) | Out-Null
    [Win32]::SetForegroundWindow($hwnd) | Out-Null
    Start-Sleep -Milliseconds 120
    # 返回更新后的窗口信息
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

function Post-Type($text) {
    # 用剪贴板 + Ctrl+V 支持任意 Unicode
    [System.Windows.Forms.Clipboard]::SetText($text)
    Start-Sleep -Milliseconds 60
    [System.Windows.Forms.SendKeys]::SendWait("^v")
}

function Post-Key($combo) {
    # 简单映射：cmd → ^（ctrl），return → {ENTER}
    $s = $combo.ToLower().Replace("cmd+", "^").Replace("ctrl+", "^").Replace("shift+", "+").Replace("alt+", "%")
    $s = $s -replace "\breturn\b", "{ENTER}" `
            -replace "\benter\b", "{ENTER}" `
            -replace "\bescape\b|\besc\b", "{ESC}" `
            -replace "\btab\b", "{TAB}" `
            -replace "\bspace\b", " " `
            -replace "\bup\b", "{UP}" `
            -replace "\bdown\b", "{DOWN}" `
            -replace "\bleft\b", "{LEFT}" `
            -replace "\bright\b", "{RIGHT}" `
            -replace "\bdelete\b|\bbackspace\b", "{BACKSPACE}"
    [System.Windows.Forms.SendKeys]::SendWait($s)
}

# 主循环：从 stdin 读 JSON
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
            "version"                       { Send-Result $id @{ version = "0.1"; platform = "windows" }; break }
            "capsule.list_displays"         { Send-Result $id (List-Displays); break }
            "capsule.ensure_virtual_display"{ Send-Result $id ((List-Displays)[0]); break }
            "capsule.ensure_workspace_display"{ Send-Result $id ((List-Displays)[0]); break }
            "window.list"                   { Send-Result $id (List-Windows $p.filter); break }
            "window.get" {
                $list = List-Windows $null
                $found = $list | Where-Object { $_.native_handle -eq $p.handle -or $_.id -eq $p.handle } | Select-Object -First 1
                if ($found) { Send-Result $id $found } else { Send-Error $id "window not found" }
                break
            }
            "window.move" {
                $r = Move-Window-By-Handle $p.handle $p.rect
                Send-Result $id $r
                break
            }
            "window.restore" {
                $r = Move-Window-By-Handle $p.handle $p.snapshot.placement.bounds
                Send-Result $id $r
                break
            }
            "window.activate" {
                $hwnd = [IntPtr]::new([int64]$p.handle)
                [Win32]::SetForegroundWindow($hwnd) | Out-Null
                Send-Result $id @{ ok = $true }
                break
            }
            "capture.rect" {
                Send-Result $id (Capture-Rect $p.rect)
                break
            }
            "input.click" {
                Post-Click $p.point ($p.button ?? "left") ($p.click_count ?? 1)
                Send-Result $id @{ ok = $true }
                break
            }
            "input.type" {
                Post-Type $p.text
                Send-Result $id @{ ok = $true }
                break
            }
            "input.key" {
                Post-Key $p.combo
                Send-Result $id @{ ok = $true }
                break
            }
            "input.scroll" {
                $dy = if ($p.dy_px) { [int]$p.dy_px } else { 0 }
                [Win32]::SetCursorPos([int]$p.point.x, [int]$p.point.y) | Out-Null
                # mouse wheel: dwFlags=0x0800, dwData = delta（120 = 一格）
                [Win32]::mouse_event(0x0800, 0, 0, -$dy, [IntPtr]::Zero)
                Send-Result $id @{ ok = $true }
                break
            }
            default { Send-Error $id "unknown method: $method"; break }
        }
    } catch {
        Send-Error $id $_.Exception.Message
    }
}
