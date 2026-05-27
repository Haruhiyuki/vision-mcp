// vision-mcp-helper (macOS)
//
// 长寿命 JSON-RPC sidecar：从 stdin 按行读 {"id","method","params"}，
// 到 stdout 按行写 {"id","result"} 或 {"id","error"}。
//
// 把所有 OS 调用从 osascript 子进程改为进程内直接调用：
//   - AXUIElement (ApplicationServices) 拿 AX 树（单 attribute query 微秒级）
//   - CGEvent (CoreGraphics) 发送 鼠标/键盘
//   - CGWindowList + CGDisplayCreateImage 截图
//   - NSWorkspace 激活 app
//   - NSPasteboard 中文/Unicode 粘贴
//
// 设计目标：每个 RPC 调用 < 50ms（osascript adapter 大约 500ms-5s）。

import Foundation
import AppKit
import ApplicationServices
import CoreGraphics
import IOKit.graphics
import Vision
import CoreImage
import ScreenCaptureKit
import Darwin.Mach

// ---------- 启动期：health.snapshot 状态 ----------
let helperStartTime = Date()
var rpcCount: UInt64 = 0

/// macOS 等价 Windows GetGuiResources：用 mach_task_basic_info 拿 resident
/// memory；handle count 用 NSProcessInfo / open fd 数；线程数走 task_threads。
/// agent doctor --watch 长 session 跑下来看这几条是否单调增长，判断 leak。
func healthSnapshot() -> [String: Any] {
    let proc = ProcessInfo.processInfo
    var info = mach_task_basic_info()
    var count = mach_msg_type_number_t(MemoryLayout<mach_task_basic_info_data_t>.size / MemoryLayout<integer_t>.size)
    let r = withUnsafeMutablePointer(to: &info) { infoPtr -> kern_return_t in
        infoPtr.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { intPtr in
            task_info(mach_task_self_, task_flavor_t(MACH_TASK_BASIC_INFO), intPtr, &count)
        }
    }
    var threadCount: mach_msg_type_number_t = 0
    var threadList: thread_act_array_t? = nil
    let tr = task_threads(mach_task_self_, &threadList, &threadCount)
    if tr == KERN_SUCCESS, let tl = threadList {
        vm_deallocate(mach_task_self_, vm_address_t(bitPattern: tl), vm_size_t(threadCount) * vm_size_t(MemoryLayout<thread_t>.size))
    }
    return [
        "uptime_sec": Int(Date().timeIntervalSince(helperStartTime)),
        "rpc_count": rpcCount,
        "pid": proc.processIdentifier,
        "elevated": getuid() == 0,
        "handle_count": NSNull(),       // macOS 没有等价 GDI handle 概念
        "gdi_handle_count": NSNull(),
        "user_handle_count": NSNull(),
        "working_set_bytes": r == KERN_SUCCESS ? info.resident_size : 0,
        "private_bytes": r == KERN_SUCCESS ? info.virtual_size : 0,
        "gc_heap_bytes": NSNull(),       // Swift 无 GC；只有 ARC + Mach VM
        "gc_gen_collected": NSNull(),
        "threads": Int(threadCount),
        "ps_version": "swift",
    ]
}

// ---------- JSON helpers ----------

func jsonObject(_ obj: Any) -> String {
    do {
        let data = try JSONSerialization.data(withJSONObject: obj, options: [])
        return String(data: data, encoding: .utf8) ?? "{}"
    } catch {
        return "{}"
    }
}

func emit(_ obj: [String: Any]) {
    let line = jsonObject(obj)
    FileHandle.standardOutput.write(Data((line + "\n").utf8))
}

func emitResult(id: Any?, result: Any) {
    var msg: [String: Any] = ["result": result]
    if let id = id { msg["id"] = id }
    emit(msg)
}

func emitError(id: Any?, message: String, code: String = "UNKNOWN") {
    var msg: [String: Any] = ["error": message, "code": code]
    if let id = id { msg["id"] = id }
    emit(msg)
}

func toDict(_ any: Any?) -> [String: Any] {
    return (any as? [String: Any]) ?? [:]
}

// ---------- Displays ----------

/// 用 CGDisplay 拿真实的 CGDirectDisplayID 并判断 primary / mirror。
func displayMetaForScreen(_ s: NSScreen) -> (cgID: CGDirectDisplayID, isMirror: Bool) {
    let key = NSDeviceDescriptionKey("NSScreenNumber")
    let cgID = (s.deviceDescription[key] as? NSNumber)?.uint32Value ?? 0
    let mirror = CGDisplayMirrorsDisplay(cgID) != 0
    return (cgID, mirror)
}

func listDisplays() -> [[String: Any]] {
    let screens = NSScreen.screens
    var out: [[String: Any]] = []
    let mainID: CGDirectDisplayID = CGMainDisplayID()
    for (i, s) in screens.enumerated() {
        let f = s.frame
        let v = s.visibleFrame
        let meta = displayMetaForScreen(s)
        let isPrimary = meta.cgID == mainID
        let kind: String = meta.isMirror ? "mirror" : (isPrimary ? "primary" : "extended")
        out.append([
            "id": "display-\(i)",
            "bounds": ["x": Int(f.origin.x), "y": Int(f.origin.y), "width": Int(f.size.width), "height": Int(f.size.height)],
            "work_area": ["x": Int(v.origin.x), "y": Int(v.origin.y), "width": Int(v.size.width), "height": Int(v.size.height)],
            "scale": s.backingScaleFactor,
            "dpi_x": Int(72 * s.backingScaleFactor),
            "dpi_y": Int(72 * s.backingScaleFactor),
            "refresh_rate_hz": 60,
            "is_primary": isPrimary,
            "is_virtual": false,
            "kind": kind,
            "name": s.localizedName,
            "native_handle": "\(meta.cgID)"
        ])
    }
    return out
}

// ---------- Windows via AX + CGWindowList ----------

struct WindowDesc {
    let pid: pid_t
    let index: Int
    let title: String
    let processName: String
    let bundleId: String?
    let bounds: CGRect
    let isMinimized: Bool
    let isFullscreen: Bool
    let isForeground: Bool
}

/// 用 NSWorkspace 拿所有运行 app（前台可见的），按 pid 用 AX 取窗口。
func listWindowsCore(filter: [String: Any]?) -> [WindowDesc] {
    var out: [WindowDesc] = []
    let workspace = NSWorkspace.shared
    let apps = workspace.runningApplications.filter {
        $0.activationPolicy == .regular
    }
    let filterProc = filter?["process_name"] as? String
    let filterBundle = filter?["bundle_id"] as? String
    let filterTitle = filter?["title_regex"] as? String
    let titleRegex: NSRegularExpression? = filterTitle.flatMap {
        try? NSRegularExpression(pattern: $0)
    }

    for app in apps {
        let name = app.localizedName ?? ""
        let bundle = app.bundleIdentifier
        if let f = filterProc, name != f { continue }
        if let f = filterBundle, bundle != f { continue }
        let pid = app.processIdentifier
        let axApp = AXUIElementCreateApplication(pid)
        var windowsValue: CFTypeRef?
        let err = AXUIElementCopyAttributeValue(axApp, kAXWindowsAttribute as CFString, &windowsValue)
        if err != .success { continue }
        guard let windows = windowsValue as? [AXUIElement] else { continue }
        for (i, w) in windows.enumerated() {
            let title = (axStringAttr(w, kAXTitleAttribute) ?? "") as String
            if let re = titleRegex {
                let range = NSRange(location: 0, length: title.utf16.count)
                if re.firstMatch(in: title, options: [], range: range) == nil { continue }
            }
            let pos = axPointAttr(w, kAXPositionAttribute) ?? .zero
            let size = axSizeAttr(w, kAXSizeAttribute) ?? .zero
            let bounds = CGRect(origin: pos, size: size)
            let minimized = axBoolAttr(w, kAXMinimizedAttribute) ?? false
            let fullscreen = axBoolAttr(w, "AXFullScreen") ?? false
            let foreground = app.isActive
            out.append(WindowDesc(
                pid: pid, index: i, title: title, processName: name,
                bundleId: bundle, bounds: bounds,
                isMinimized: minimized, isFullscreen: fullscreen, isForeground: foreground))
        }
    }
    return out
}

func toWindowInfo(_ w: WindowDesc) -> [String: Any] {
    let b: [String: Any] = [
        "x": Int(w.bounds.origin.x),
        "y": Int(w.bounds.origin.y),
        "width": Int(w.bounds.size.width),
        "height": Int(w.bounds.size.height),
    ]
    var out: [String: Any] = [
        "id": "\(w.pid):\(w.index)",
        "title": w.title,
        "process_name": w.processName,
        "process_id": Int(w.pid),
        "bounds": b,
        "client_bounds": b,
        "is_minimized": w.isMinimized,
        "is_maximized": false,
        "is_fullscreen": w.isFullscreen,
        "is_foreground": w.isForeground,
        "native_handle": "\(w.pid):\(w.index)",
    ]
    if let bid = w.bundleId { out["bundle_id"] = bid }
    return out
}

// ---------- AX helpers ----------

func axStringAttr(_ el: AXUIElement, _ attr: String) -> String? {
    var v: CFTypeRef?
    let err = AXUIElementCopyAttributeValue(el, attr as CFString, &v)
    if err != .success { return nil }
    return v as? String
}

func axBoolAttr(_ el: AXUIElement, _ attr: String) -> Bool? {
    var v: CFTypeRef?
    let err = AXUIElementCopyAttributeValue(el, attr as CFString, &v)
    if err != .success { return nil }
    return v as? Bool
}

func axPointAttr(_ el: AXUIElement, _ attr: String) -> CGPoint? {
    var v: CFTypeRef?
    let err = AXUIElementCopyAttributeValue(el, attr as CFString, &v)
    if err != .success { return nil }
    let axVal = v as! AXValue
    var p = CGPoint.zero
    if AXValueGetValue(axVal, .cgPoint, &p) { return p }
    return nil
}

func axSizeAttr(_ el: AXUIElement, _ attr: String) -> CGSize? {
    var v: CFTypeRef?
    let err = AXUIElementCopyAttributeValue(el, attr as CFString, &v)
    if err != .success { return nil }
    let axVal = v as! AXValue
    var s = CGSize.zero
    if AXValueGetValue(axVal, .cgSize, &s) { return s }
    return nil
}

func axChildren(_ el: AXUIElement) -> [AXUIElement] {
    var v: CFTypeRef?
    let err = AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &v)
    if err != .success { return [] }
    return (v as? [AXUIElement]) ?? []
}

func findWindow(handle: String) -> (app: NSRunningApplication, win: AXUIElement, desc: WindowDesc)? {
    let parts = handle.split(separator: ":")
    guard parts.count == 2, let pid = pid_t(parts[0]), let idx = Int(parts[1]) else { return nil }
    guard let app = NSWorkspace.shared.runningApplications.first(where: { $0.processIdentifier == pid }) else { return nil }
    let axApp = AXUIElementCreateApplication(pid)
    var windowsValue: CFTypeRef?
    let err = AXUIElementCopyAttributeValue(axApp, kAXWindowsAttribute as CFString, &windowsValue)
    if err != .success { return nil }
    guard let windows = windowsValue as? [AXUIElement] else { return nil }

    // 与 darwin-osascript 一致：优先 pid 内面积最大窗口，避免 popup 顶替 index 0。
    var sorted = windows.enumerated().map { (i, w) -> (Int, AXUIElement, CGFloat) in
        let s = axSizeAttr(w, kAXSizeAttribute) ?? .zero
        return (i, w, s.width * s.height)
    }
    sorted.sort { $0.2 > $1.2 }
    let chosen: AXUIElement
    let chosenIdx: Int
    if let pref = sorted.first(where: { $0.0 == idx }), pref.2 > 0 {
        // 如果 idx 对应的窗口仍存在且非 popup（最大或 >50% 最大）
        if pref.2 >= sorted.first!.2 * 0.5 {
            chosenIdx = idx
            chosen = pref.1
        } else {
            chosenIdx = sorted.first!.0
            chosen = sorted.first!.1
        }
    } else if let first = sorted.first {
        chosenIdx = first.0
        chosen = first.1
    } else {
        return nil
    }
    let title = axStringAttr(chosen, kAXTitleAttribute) ?? ""
    let pos = axPointAttr(chosen, kAXPositionAttribute) ?? .zero
    let size = axSizeAttr(chosen, kAXSizeAttribute) ?? .zero
    let bounds = CGRect(origin: pos, size: size)
    let minimized = axBoolAttr(chosen, kAXMinimizedAttribute) ?? false
    let fullscreen = axBoolAttr(chosen, "AXFullScreen") ?? false
    let desc = WindowDesc(
        pid: pid, index: chosenIdx, title: title,
        processName: app.localizedName ?? "",
        bundleId: app.bundleIdentifier,
        bounds: bounds,
        isMinimized: minimized,
        isFullscreen: fullscreen,
        isForeground: app.isActive
    )
    return (app, chosen, desc)
}

// ---------- AX tree dump ----------

func dumpAXTree(handle: String, maxNodes: Int, maxDepth: Int) -> [[String: Any]] {
    guard let (_, rootWin, _) = findWindow(handle: handle) else { return [] }
    var out: [[String: Any]] = []
    func visit(_ el: AXUIElement, depth: Int, path: String) {
        if out.count >= maxNodes || depth > maxDepth { return }
        let role = axStringAttr(el, kAXRoleAttribute) ?? "?"
        var name = axStringAttr(el, kAXTitleAttribute)
        let desc = axStringAttr(el, kAXRoleDescriptionAttribute)
        let descAlt = axStringAttr(el, kAXDescriptionAttribute)
        let pos = axPointAttr(el, kAXPositionAttribute)
        let size = axSizeAttr(el, kAXSizeAttribute)

        // 对容器型节点（AXCell / AXRow / AXButton）如果自身 AXTitle 为空，
        // 用 children 中第一个 AXStaticText 的 AXValue 作为 name。这让 sidebar
        // "主页 / 搜索 / 新发现" 等条目对 agent 可见（否则 name=null desc="单元格"）。
        if (name == nil || name?.isEmpty == true) && (role == "AXCell" || role == "AXRow" || role == "AXButton") {
            let kids = axChildren(el)
            for k in kids.prefix(8) {
                let kRole = axStringAttr(k, kAXRoleAttribute) ?? ""
                if kRole == "AXStaticText" {
                    if let v = axStringAttr(k, kAXValueAttribute), !v.isEmpty {
                        name = v; break
                    }
                    if let t = axStringAttr(k, kAXTitleAttribute), !t.isEmpty {
                        name = t; break
                    }
                }
            }
        }
        var node: [String: Any] = [
            "role": role,
            "depth": depth,
            "path": path,
        ]
        if let n = name, !n.isEmpty { node["name"] = n }
        if let d = descAlt, !d.isEmpty {
            node["desc"] = d
        } else if let d = desc, !d.isEmpty {
            node["desc"] = d
        }
        if let p = pos {
            node["pos"] = [p.x, p.y]
        }
        if let s = size {
            node["size"] = [s.width, s.height]
        }
        out.append(node)
        let kids = axChildren(el)
        let limit = min(kids.count, 60)
        for i in 0..<limit {
            if out.count >= maxNodes { break }
            visit(kids[i], depth: depth + 1, path: "\(path)/\(role)[\(i)]")
        }
    }
    visit(rootWin, depth: 0, path: "win[0]")
    return out
}

// ---------- Input ----------

/// 标准 click：mouseMoved → down/up。鼠标光标飞到目标位置。
func postClick(point: CGPoint, button: String, count: Int) {
    let buttonNum: CGMouseButton
    let downType: CGEventType
    let upType: CGEventType
    switch button {
    case "right":
        buttonNum = .right; downType = .rightMouseDown; upType = .rightMouseUp
    case "middle":
        buttonNum = .center; downType = .otherMouseDown; upType = .otherMouseUp
    default:
        buttonNum = .left; downType = .leftMouseDown; upType = .leftMouseUp
    }
    let src = CGEventSource(stateID: .hidSystemState)
    if let move = CGEvent(mouseEventSource: src, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left) {
        move.post(tap: .cghidEventTap)
    }
    for i in 0..<max(1, count) {
        if let down = CGEvent(mouseEventSource: src, mouseType: downType, mouseCursorPosition: point, mouseButton: buttonNum) {
            if i > 0 { down.setIntegerValueField(.mouseEventClickState, value: Int64(i + 1)) }
            down.post(tap: .cghidEventTap)
        }
        if let up = CGEvent(mouseEventSource: src, mouseType: upType, mouseCursorPosition: point, mouseButton: buttonNum) {
            if i > 0 { up.setIntegerValueField(.mouseEventClickState, value: Int64(i + 1)) }
            up.post(tap: .cghidEventTap)
        }
        if i < count - 1 {
            Thread.sleep(forTimeInterval: 0.05)
        }
    }
}

/// 在 window 的 AX tree 中找包含 (winRelX, winRelY) 的最小可点击 element 并 AXPress。
/// 关键能力：完全不依赖鼠标坐标，可对有 AXPress action 的元素直接操作（菜单 / 工具栏 / 普通按钮）。
/// 对 NSTableView cell / SwiftUI 自绘元素无效（它们不响应 AXPress）。
@discardableResult
func axPressInWindowAtNorm(handle: String, normX: Double, normY: Double) -> (ok: Bool, role: String?, name: String?) {
    guard let (_, axWin, desc) = findWindow(handle: handle) else { return (false, nil, nil) }
    // 把 norm 转成窗口内 screen 坐标
    let targetX = desc.bounds.origin.x + normX * desc.bounds.width
    let targetY = desc.bounds.origin.y + normY * desc.bounds.height
    // BFS 遍历 AX tree 找包含 (targetX, targetY) 的最小 leaf
    var best: (el: AXUIElement, area: CGFloat, role: String, name: String?) = (axWin, .greatestFiniteMagnitude, "AXWindow", nil)
    var queue: [AXUIElement] = [axWin]
    var visited = 0
    let maxVisit = 800
    while !queue.isEmpty, visited < maxVisit {
        let el = queue.removeFirst()
        visited += 1
        let pos = axPointAttr(el, kAXPositionAttribute) ?? .zero
        let size = axSizeAttr(el, kAXSizeAttribute) ?? .zero
        let rect = CGRect(origin: pos, size: size)
        if !rect.contains(CGPoint(x: targetX, y: targetY)) { continue }
        let area = size.width * size.height
        if area > 0 && area < best.area {
            let role = axStringAttr(el, kAXRoleAttribute) ?? "?"
            let name = axStringAttr(el, kAXTitleAttribute) ?? axStringAttr(el, kAXValueAttribute)
            best = (el, area, role, name)
        }
        for k in axChildren(el).prefix(80) {
            queue.append(k)
        }
    }
    // 尝试一系列 action：AXPress / AXOpen / AXShowMenu / AXIncrement
    let actions = ["AXPress", "AXOpen", "AXShowMenu"]
    for a in actions {
        if AXUIElementPerformAction(best.el, a as CFString) == .success {
            return (true, best.role, best.name)
        }
    }
    // 如果是 AXCell 之类没有自身 action，可以试父级或第一个 child
    for k in axChildren(best.el).prefix(3) {
        if AXUIElementPerformAction(k, "AXPress" as CFString) == .success {
            return (true, best.role, best.name)
        }
    }
    return (false, best.role, best.name)
}

func postScroll(point: CGPoint, dx: Int, dy: Int) {
    let src = CGEventSource(stateID: .hidSystemState)
    if let move = CGEvent(mouseEventSource: src, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left) {
        move.post(tap: .cghidEventTap)
    }
    // CGEventCreateScrollWheelEvent (line-based)：负值为向下滚
    if let ev = CGEvent(scrollWheelEvent2Source: src, units: .pixel, wheelCount: 2, wheel1: Int32(-dy), wheel2: Int32(-dx), wheel3: 0) {
        ev.post(tap: .cghidEventTap)
    }
}

func postDrag(from: CGPoint, to: CGPoint, steps: Int, durationMs: Int) {
    let src = CGEventSource(stateID: .hidSystemState)
    if let down = CGEvent(mouseEventSource: src, mouseType: .leftMouseDown, mouseCursorPosition: from, mouseButton: .left) {
        down.post(tap: .cghidEventTap)
    }
    let sleepMs = max(1, durationMs / max(1, steps))
    for i in 1...steps {
        let t = CGFloat(i) / CGFloat(steps)
        let p = CGPoint(x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t)
        if let drag = CGEvent(mouseEventSource: src, mouseType: .leftMouseDragged, mouseCursorPosition: p, mouseButton: .left) {
            drag.post(tap: .cghidEventTap)
        }
        Thread.sleep(forTimeInterval: Double(sleepMs) / 1000.0)
    }
    if let up = CGEvent(mouseEventSource: src, mouseType: .leftMouseUp, mouseCursorPosition: to, mouseButton: .left) {
        up.post(tap: .cghidEventTap)
    }
}

// Key code map（macOS virtual key codes）
let keyCodeMap: [String: CGKeyCode] = [
    "return": 36, "enter": 36, "tab": 48, "space": 49, "escape": 53, "esc": 53,
    "delete": 51, "backspace": 51, "forwarddelete": 117,
    "up": 126, "down": 125, "left": 123, "right": 124,
    "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
    "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97,
    "f7": 98, "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111,
    "a": 0, "b": 11, "c": 8, "d": 2, "e": 14, "f": 3, "g": 5, "h": 4,
    "i": 34, "j": 38, "k": 40, "l": 37, "m": 46, "n": 45, "o": 31,
    "p": 35, "q": 12, "r": 15, "s": 1, "t": 17, "u": 32, "v": 9,
    "w": 13, "x": 7, "y": 16, "z": 6,
    "0": 29, "1": 18, "2": 19, "3": 20, "4": 21, "5": 23, "6": 22,
    "7": 26, "8": 28, "9": 25,
    "[": 33, "]": 30,
]

struct ModifierFlags {
    var cmd = false; var shift = false; var alt = false; var ctrl = false
    var mask: CGEventFlags {
        var f: CGEventFlags = []
        if cmd { f.insert(.maskCommand) }
        if shift { f.insert(.maskShift) }
        if alt { f.insert(.maskAlternate) }
        if ctrl { f.insert(.maskControl) }
        return f
    }
}

func parseCombo(_ combo: String) -> (ModifierFlags, String) {
    var mods = ModifierFlags()
    let parts = combo.split(separator: "+").map { $0.trimmingCharacters(in: .whitespaces) }
    guard let key = parts.last else { return (mods, "") }
    for p in parts.dropLast() {
        switch p.lowercased() {
        case "cmd", "command", "meta": mods.cmd = true
        case "shift": mods.shift = true
        case "alt", "option": mods.alt = true
        case "ctrl", "control": mods.ctrl = true
        default: break
        }
    }
    return (mods, key)
}

func postKey(combo: String) {
    let (mods, key) = parseCombo(combo)
    guard let code = keyCodeMap[key.lowercased()] else {
        // 不在表里时 fallback：把 key 当字符串通过 keystroke 输入（用 paste 更稳但 single char 走 keystroke）
        postPaste(text: key)
        return
    }
    let src = CGEventSource(stateID: .hidSystemState)
    if let down = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: true) {
        down.flags = mods.mask
        down.post(tap: .cghidEventTap)
    }
    if let up = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: false) {
        up.flags = mods.mask
        up.post(tap: .cghidEventTap)
    }
}

/// 通过 NSPasteboard + Cmd+V 输入文本（支持中文 / Unicode）。
func postPaste(text: String) {
    let pb = NSPasteboard.general
    let oldString = pb.string(forType: .string)
    pb.clearContents()
    pb.setString(text, forType: .string)
    usleep(50_000)
    // Cmd+V
    let src = CGEventSource(stateID: .hidSystemState)
    let v: CGKeyCode = 9
    if let down = CGEvent(keyboardEventSource: src, virtualKey: v, keyDown: true) {
        down.flags = .maskCommand
        down.post(tap: .cghidEventTap)
    }
    if let up = CGEvent(keyboardEventSource: src, virtualKey: v, keyDown: false) {
        up.flags = .maskCommand
        up.post(tap: .cghidEventTap)
    }
    usleep(150_000)
    pb.clearContents()
    if let oldString = oldString {
        pb.setString(oldString, forType: .string)
    }
}

func clearInput() {
    // Cmd+A → Delete
    let src = CGEventSource(stateID: .hidSystemState)
    let a: CGKeyCode = 0
    if let down = CGEvent(keyboardEventSource: src, virtualKey: a, keyDown: true) {
        down.flags = .maskCommand
        down.post(tap: .cghidEventTap)
    }
    if let up = CGEvent(keyboardEventSource: src, virtualKey: a, keyDown: false) {
        up.flags = .maskCommand
        up.post(tap: .cghidEventTap)
    }
    usleep(40_000)
    let del: CGKeyCode = 51
    if let d = CGEvent(keyboardEventSource: src, virtualKey: del, keyDown: true) { d.post(tap: .cghidEventTap) }
    if let u = CGEvent(keyboardEventSource: src, virtualKey: del, keyDown: false) { u.post(tap: .cghidEventTap) }
    usleep(40_000)
}

// ---------- Activate / move / restore ----------

func activate(pid: pid_t) {
    if let app = NSWorkspace.shared.runningApplications.first(where: { $0.processIdentifier == pid }) {
        app.activate(options: [.activateAllWindows])
    }
}

func moveWindow(handle: String, rect: CGRect) -> [String: Any]? {
    guard let (_, axWin, _) = findWindow(handle: handle) else { return nil }
    if axBoolAttr(axWin, kAXMinimizedAttribute) == true {
        AXUIElementSetAttributeValue(axWin, kAXMinimizedAttribute as CFString, false as CFTypeRef)
    }
    var pos = CGPoint(x: rect.origin.x, y: rect.origin.y)
    var size = CGSize(width: rect.size.width, height: rect.size.height)
    let posVal = AXValueCreate(.cgPoint, &pos)!
    let sizeVal = AXValueCreate(.cgSize, &size)!
    AXUIElementSetAttributeValue(axWin, kAXPositionAttribute as CFString, posVal)
    AXUIElementSetAttributeValue(axWin, kAXSizeAttribute as CFString, sizeVal)
    let pid = pid_t(handle.split(separator: ":").first!)!
    activate(pid: pid)
    usleep(120_000)
    if let (_, _, desc) = findWindow(handle: handle) {
        return toWindowInfo(desc)
    }
    return nil
}

// ---------- Annotated snapshot ----------

struct AnnotationBox {
    let xNorm: Double
    let yNorm: Double
    let wNorm: Double
    let hNorm: Double
    let label: String?
    let color: NSColor
}

/// 在原始截图上叠加：网格 + 彩色 bbox + 序号 label。
/// Agent 拿到带网格的图后能说"click #7"或"区域 [0.3, 0.5]"，比凭空估坐标准得多。
func captureAnnotated(rect: CGRect, boxes: [AnnotationBox], gridStep: Double) -> Data? {
    guard let pngData = capture(rect: rect),
          let image = NSImage(data: pngData) else { return nil }
    let size = image.size
    guard let rep = NSBitmapImageRep(
        bitmapDataPlanes: nil,
        pixelsWide: Int(size.width),
        pixelsHigh: Int(size.height),
        bitsPerSample: 8,
        samplesPerPixel: 4,
        hasAlpha: true,
        isPlanar: false,
        colorSpaceName: .deviceRGB,
        bytesPerRow: 0,
        bitsPerPixel: 32
    ) else { return nil }
    NSGraphicsContext.saveGraphicsState()
    defer { NSGraphicsContext.restoreGraphicsState() }
    guard let gc = NSGraphicsContext(bitmapImageRep: rep) else { return nil }
    NSGraphicsContext.current = gc
    image.draw(at: .zero, from: NSRect(origin: .zero, size: size), operation: .copy, fraction: 1.0)

    if gridStep > 0 {
        NSColor.systemGray.withAlphaComponent(0.35).setStroke()
        let gridPath = NSBezierPath()
        gridPath.lineWidth = 1
        var t = gridStep
        while t < 1.0 {
            let xPx = t * size.width
            let yPx = t * size.height
            gridPath.move(to: NSPoint(x: xPx, y: 0))
            gridPath.line(to: NSPoint(x: xPx, y: size.height))
            gridPath.move(to: NSPoint(x: 0, y: yPx))
            gridPath.line(to: NSPoint(x: size.width, y: yPx))
            t += gridStep
        }
        gridPath.stroke()
        let labelAttrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 11, weight: .medium),
            .foregroundColor: NSColor.systemBlue.withAlphaComponent(0.9),
        ]
        var tl = 0.0
        while tl <= 1.0 {
            let xPx = tl * size.width
            let yPx = tl * size.height
            let str = String(format: "%.2f", tl)
            // PNG/NSBitmap 原点左下；用户视角原点左上 → 顶部 label = y = size.height - 12
            str.draw(at: NSPoint(x: xPx + 2, y: size.height - 14), withAttributes: labelAttrs)
            str.draw(at: NSPoint(x: 2, y: size.height - yPx - 12), withAttributes: labelAttrs)
            tl += gridStep * 2
        }
    }

    for (i, box) in boxes.enumerated() {
        let xPx = box.xNorm * size.width
        let yPxTop = box.yNorm * size.height
        let wPx = box.wNorm * size.width
        let hPx = box.hNorm * size.height
        // Bitmap 原点左下 → 矩形 y 要翻转
        let yPx = size.height - yPxTop - hPx
        let r = NSRect(x: xPx, y: yPx, width: wPx, height: hPx)
        box.color.setStroke()
        let p = NSBezierPath(rect: r)
        p.lineWidth = 2
        p.stroke()
        let tag = box.label.map { "#\(i + 1) \($0)" } ?? "#\(i + 1)"
        let attrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.boldSystemFont(ofSize: 12),
            .foregroundColor: NSColor.white,
            .backgroundColor: box.color.withAlphaComponent(0.85),
        ]
        tag.draw(at: NSPoint(x: xPx + 2, y: yPx + hPx - 16), withAttributes: attrs)
    }
    return rep.representation(using: .png, properties: [:])
}

// ---------- Capture ----------

// ---------- OCR (Vision framework) ----------

/// 对指定屏幕矩形做 OCR。返回每个文本块的 `{text, confidence, bbox}`，bbox 已归一化到该矩形内。
/// 用 VNRecognizeTextRequest（accurate 路径），自动识别中英文。
/// 性能：1280×800 区域 ~150-300ms（CPU），首次冷启动多 200ms。
func ocrRect(_ rect: CGRect, languages: [String]) -> [[String: Any]] {
    guard let pngData = capture(rect: rect),
          let image = NSImage(data: pngData),
          let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
        return []
    }
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    if !languages.isEmpty {
        request.recognitionLanguages = languages
    } else {
        request.recognitionLanguages = ["zh-Hans", "en-US"]
    }
    let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
    do {
        try handler.perform([request])
    } catch {
        return []
    }
    let observations = request.results ?? []
    var out: [[String: Any]] = []
    for obs in observations {
        guard let candidate = obs.topCandidates(1).first else { continue }
        // Vision 的 boundingBox 原点在左下、归一化到 [0,1]。转成 vision-mcp 的 [x,y,w,h]，
        // 原点左上（屏幕坐标系）。
        let bb = obs.boundingBox
        let x = bb.minX
        let y = 1.0 - bb.maxY
        let w = bb.width
        let h = bb.height
        out.append([
            "text": candidate.string,
            "confidence": Double(candidate.confidence),
            "bbox_norm": [x, y, w, h],  // 归一化到调用方传入的 rect 内
        ])
    }
    return out
}

/// 通过 pid + 标题找到对应 SCWindow 的 windowID（用于 capture.window）。
/// 优先 SCKit（更准确，包含半屏外的窗口）；失败 fallback 到 CGWindowList。
func findWindowID(pid: pid_t, title: String) -> CGWindowID? {
    // 先尝试 SCKit
    let sem = DispatchSemaphore(value: 0)
    let result = SyncBox<CGWindowID?>(nil)
    Task.detached(priority: .userInitiated) {
        defer { sem.signal() }
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
            var best: (id: CGWindowID, area: CGFloat) = (0, 0)
            for w in content.windows where w.owningApplication?.processID == pid {
                let area = w.frame.width * w.frame.height
                if area > best.area { best = (w.windowID, area) }
            }
            if best.id != 0 { result.set(best.id) }
        } catch {
            // ignore
        }
    }
    if sem.wait(timeout: .now() + 2.0) == .success, let id = result.get() {
        return id
    }
    // fallback: CGWindowList
    let opts: CGWindowListOption = [.optionAll, .excludeDesktopElements]
    guard let info = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] else { return nil }
    var candidates: [(id: CGWindowID, layer: Int, area: Int)] = []
    for w in info {
        guard let p = (w[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value, p == pid else { continue }
        let layer = (w[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0
        let name = (w[kCGWindowName as String] as? String) ?? ""
        if !title.isEmpty && !name.isEmpty && name != title { continue }
        guard let bounds = w[kCGWindowBounds as String] as? [String: Any] else { continue }
        let width = (bounds["Width"] as? NSNumber)?.intValue ?? 0
        let height = (bounds["Height"] as? NSNumber)?.intValue ?? 0
        let id = (w[kCGWindowNumber as String] as? NSNumber)?.uint32Value ?? 0
        if id == 0 { continue }
        candidates.append((id, layer, width * height))
    }
    candidates.sort { (a, b) in
        if a.layer != b.layer { return a.layer < b.layer }
        return a.area > b.area
    }
    return candidates.first?.id
}

/// 用 ScreenCaptureKit 直接抓某个窗口（按 windowID）。
/// 关键能力：能抓到完全或部分屏外的窗口（screencapture -R 做不到）。
/// SCScreenshotManager.captureImage 是 macOS 14+ async API；用 semaphore + Task.detached 同步等待。
@available(macOS 14.0, *)
func captureWindowByID(_ windowID: CGWindowID) -> Data? {
    let sem = DispatchSemaphore(value: 0)
    let result = SyncBox<Data?>(nil)
    let errBox = SyncBox<String?>(nil)
    Task.detached(priority: .userInitiated) {
        defer { sem.signal() }
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
            guard let window = content.windows.first(where: { $0.windowID == windowID }) else {
                errBox.set("window \(windowID) not in SCShareableContent (\(content.windows.count) windows visible)")
                return
            }
            FileHandle.standardError.write(Data("[sckit] win \(windowID) frame=\(window.frame)\n".utf8))
            let filter = SCContentFilter(desktopIndependentWindow: window)
            let config = SCStreamConfiguration()
            let scale = NSScreen.main?.backingScaleFactor ?? 2.0
            let w = window.frame.width > 0 ? window.frame.width : 1280
            let h = window.frame.height > 0 ? window.frame.height : 800
            config.width = max(1, Int(w * scale))
            config.height = max(1, Int(h * scale))
            config.pixelFormat = kCVPixelFormatType_32BGRA
            config.scalesToFit = false
            config.showsCursor = false
            config.capturesAudio = false
            // 关键：sourceRect 用 window 的 frame 直接定位，相对 SCContentFilter 的 contentRect
            // 不指定 sourceRect 时 SCKit 会用 filter 的整个 contentRect（=window frame）
            let img = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
            FileHandle.standardError.write(Data("[sckit] captured \(img.width)x\(img.height)\n".utf8))
            let rep = NSBitmapImageRep(cgImage: img)
            result.set(rep.representation(using: .png, properties: [:]))
        } catch {
            errBox.set("SCScreenshotManager error: \(error)")
        }
    }
    // 5 秒超时
    let r = sem.wait(timeout: .now() + 5.0)
    if r == .timedOut {
        FileHandle.standardError.write(Data("[helper] SCKit capture timed out for windowID \(windowID)\n".utf8))
        return nil
    }
    if let e = errBox.get() {
        FileHandle.standardError.write(Data("[helper] \(e)\n".utf8))
    }
    return result.get()
}

/// 跨线程 thread-safe 单值容器（Swift Task / RunLoop 间传值）。
final class SyncBox<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var value: T
    init(_ initial: T) { self.value = initial }
    func get() -> T { lock.lock(); defer { lock.unlock() }; return value }
    func set(_ v: T) { lock.lock(); value = v; lock.unlock() }
}

/// 截图：macOS 15+ 弃用了 CGWindowListCreateImage，统一用 /usr/sbin/screencapture
/// 子进程。子进程 fork 约 ~300ms。后续可切到 ScreenCaptureKit（需要 async/Stream API）。
func capture(rect: CGRect) -> Data? {
    let tmp = NSTemporaryDirectory() + "vision-mcp-\(UUID().uuidString).png"
    let task = Process()
    task.launchPath = "/usr/sbin/screencapture"
    task.arguments = [
        "-x",
        "-t", "png",
        "-R", "\(Int(rect.origin.x)),\(Int(rect.origin.y)),\(Int(rect.size.width)),\(Int(rect.size.height))",
        tmp,
    ]
    do {
        try task.run()
        task.waitUntilExit()
    } catch {
        return nil
    }
    defer { try? FileManager.default.removeItem(atPath: tmp) }
    return try? Data(contentsOf: URL(fileURLWithPath: tmp))
}

// ---------- RPC dispatch ----------

func handle(method: String, params: [String: Any]) -> Any {
    rpcCount += 1
    switch method {
    case "version":
        return ["version": "0.1", "platform": "macos"]
    case "health.snapshot":
        return healthSnapshot()
    case "capsule.list_displays":
        return listDisplays()
    case "capsule.ensure_workspace_display":
        return listDisplays().first ?? [:]
    case "capsule.ensure_virtual_display":
        return listDisplays().first ?? [:]
    case "window.list":
        let filter = params["filter"] as? [String: Any]
        return listWindowsCore(filter: filter).map(toWindowInfo)
    case "window.get":
        guard let handle = params["handle"] as? String else { return ["error": "handle required"] }
        if let (_, _, desc) = findWindow(handle: handle) {
            return toWindowInfo(desc)
        }
        return ["error": "window not found"]
    case "window.move":
        guard let handle = params["handle"] as? String,
              let rectDict = params["rect"] as? [String: Any],
              let x = (rectDict["x"] as? NSNumber)?.doubleValue,
              let y = (rectDict["y"] as? NSNumber)?.doubleValue,
              let w = (rectDict["width"] as? NSNumber)?.doubleValue,
              let h = (rectDict["height"] as? NSNumber)?.doubleValue else { return ["error": "bad params"] }
        let r = CGRect(x: x, y: y, width: w, height: h)
        return moveWindow(handle: handle, rect: r) ?? ["error": "move failed"]
    case "window.restore":
        guard let handle = params["handle"] as? String,
              let snapshot = params["snapshot"] as? [String: Any],
              let placement = snapshot["placement"] as? [String: Any],
              let bounds = placement["bounds"] as? [String: Any],
              let x = (bounds["x"] as? NSNumber)?.doubleValue,
              let y = (bounds["y"] as? NSNumber)?.doubleValue,
              let w = (bounds["width"] as? NSNumber)?.doubleValue,
              let h = (bounds["height"] as? NSNumber)?.doubleValue else { return ["error": "bad params"] }
        return moveWindow(handle: handle, rect: CGRect(x: x, y: y, width: w, height: h)) ?? ["error": "restore failed"]
    case "window.activate":
        guard let handle = params["handle"] as? String,
              let pid = pid_t(handle.split(separator: ":").first.map(String.init) ?? "") else { return ["error": "bad handle"] }
        activate(pid: pid)
        return ["ok": true]
    case "window.raise":
        // window.raise 等价于 window.activate（保留向后兼容）
        guard let handle = params["handle"] as? String,
              let pid = pid_t(handle.split(separator: ":").first.map(String.init) ?? "") else { return ["error": "bad handle"] }
        activate(pid: pid)
        return ["ok": true]
    case "ax.dump":
        guard let handle = params["handle"] as? String else { return ["error": "handle required"] }
        let maxNodes = (params["max_nodes"] as? NSNumber)?.intValue ?? 500
        let maxDepth = (params["max_depth"] as? NSNumber)?.intValue ?? 6
        return dumpAXTree(handle: handle, maxNodes: maxNodes, maxDepth: maxDepth)
    case "capture.rect":
        guard let r = params["rect"] as? [String: Any],
              let x = (r["x"] as? NSNumber)?.doubleValue,
              let y = (r["y"] as? NSNumber)?.doubleValue,
              let w = (r["width"] as? NSNumber)?.doubleValue,
              let h = (r["height"] as? NSNumber)?.doubleValue else { return ["error": "bad params"] }
        guard let png = capture(rect: CGRect(x: x, y: y, width: w, height: h)) else { return ["error": "capture failed"] }
        return [
            "png_base64": png.base64EncodedString(),
            "width": Int(w),
            "height": Int(h),
        ]
    case "capture.rect_annotated":
        guard let r = params["rect"] as? [String: Any],
              let x = (r["x"] as? NSNumber)?.doubleValue,
              let y = (r["y"] as? NSNumber)?.doubleValue,
              let w = (r["width"] as? NSNumber)?.doubleValue,
              let h = (r["height"] as? NSNumber)?.doubleValue else { return ["error": "bad params"] }
        let gridStep = (params["grid_step"] as? NSNumber)?.doubleValue ?? 0.1
        let boxesRaw = (params["boxes"] as? [[String: Any]]) ?? []
        let palette: [NSColor] = [
            .systemRed, .systemBlue, .systemGreen, .systemOrange,
            .systemPurple, .systemTeal, .systemPink, .systemBrown,
        ]
        var boxes: [AnnotationBox] = []
        for (i, b) in boxesRaw.enumerated() {
            guard let bbox = b["bbox_norm"] as? [Double], bbox.count == 4 else { continue }
            let label = b["label"] as? String
            let colorHex = b["color"] as? String
            let color: NSColor
            if let h = colorHex, h.hasPrefix("#"), h.count == 7,
               let rv = Int(h.dropFirst().prefix(2), radix: 16),
               let gv = Int(h.dropFirst(3).prefix(2), radix: 16),
               let bv = Int(h.dropFirst(5).prefix(2), radix: 16) {
                color = NSColor(srgbRed: CGFloat(rv)/255, green: CGFloat(gv)/255, blue: CGFloat(bv)/255, alpha: 1)
            } else {
                color = palette[i % palette.count]
            }
            boxes.append(AnnotationBox(
                xNorm: bbox[0], yNorm: bbox[1], wNorm: bbox[2], hNorm: bbox[3],
                label: label, color: color
            ))
        }
        guard let png = captureAnnotated(rect: CGRect(x: x, y: y, width: w, height: h), boxes: boxes, gridStep: gridStep) else {
            return ["error": "annotate failed"]
        }
        return [
            "png_base64": png.base64EncodedString(),
            "width": Int(w),
            "height": Int(h),
            "box_count": boxes.count,
        ]
    case "ocr.recognize_rect":
        guard let r = params["rect"] as? [String: Any],
              let x = (r["x"] as? NSNumber)?.doubleValue,
              let y = (r["y"] as? NSNumber)?.doubleValue,
              let w = (r["width"] as? NSNumber)?.doubleValue,
              let h = (r["height"] as? NSNumber)?.doubleValue else { return ["error": "bad params"] }
        let langs = (params["languages"] as? [String]) ?? []
        let tokens = ocrRect(CGRect(x: x, y: y, width: w, height: h), languages: langs)
        return ["tokens": tokens]
    case "input.click":
        guard let p = params["point"] as? [String: Any],
              let x = (p["x"] as? NSNumber)?.doubleValue,
              let y = (p["y"] as? NSNumber)?.doubleValue else { return ["error": "bad params"] }
        let btn = (params["button"] as? String) ?? "left"
        let cnt = (params["click_count"] as? NSNumber)?.intValue ?? 1
        postClick(point: CGPoint(x: x, y: y), button: btn, count: cnt)
        return ["ok": true]
    case "input.type":
        guard let text = params["text"] as? String else { return ["error": "text required"] }
        let clearFirst = (params["clear_first"] as? Bool) ?? false
        if clearFirst { clearInput() }
        postPaste(text: text)
        return ["ok": true]
    case "input.key":
        guard let combo = params["combo"] as? String else { return ["error": "combo required"] }
        postKey(combo: combo)
        return ["ok": true]
    case "input.scroll":
        guard let p = params["point"] as? [String: Any],
              let x = (p["x"] as? NSNumber)?.doubleValue,
              let y = (p["y"] as? NSNumber)?.doubleValue else { return ["error": "bad params"] }
        let dx = (params["dx_px"] as? NSNumber)?.intValue ?? 0
        let dy = (params["dy_px"] as? NSNumber)?.intValue ?? 0
        postScroll(point: CGPoint(x: x, y: y), dx: dx, dy: dy)
        return ["ok": true]
    case "input.drag":
        guard let from = params["from"] as? [String: Any],
              let fx = (from["x"] as? NSNumber)?.doubleValue,
              let fy = (from["y"] as? NSNumber)?.doubleValue,
              let to = params["to_point_px"] as? [String: Any],
              let tx = (to["x"] as? NSNumber)?.doubleValue,
              let ty = (to["y"] as? NSNumber)?.doubleValue else { return ["error": "bad params"] }
        let steps = (params["steps"] as? NSNumber)?.intValue ?? 20
        let dur = (params["duration_ms"] as? NSNumber)?.intValue ?? 200
        postDrag(from: CGPoint(x: fx, y: fy), to: CGPoint(x: tx, y: ty), steps: steps, durationMs: dur)
        return ["ok": true]
    case "input.subscribe":
        // 暂不支持
        return ["ok": true]
    case "capture.window":
        // 通过 window handle (pid:idx) 截图——优先 SCKit（能抓屏外），失败 fallback screencapture rect
        guard let handle = params["handle"] as? String else { return ["error": "handle required"] }
        guard let (_, _, desc) = findWindow(handle: handle) else { return ["error": "window not found"] }
        let pid = pid_t(handle.split(separator: ":").first.map(String.init) ?? "") ?? 0
        if let wid = findWindowID(pid: pid, title: desc.title),
           let png = captureWindowByID(wid) {
            // 用 NSBitmapImageRep 解析真实像素尺寸
            if let rep = NSBitmapImageRep(data: png) {
                return [
                    "png_base64": png.base64EncodedString(),
                    "width": rep.pixelsWide,
                    "height": rep.pixelsHigh,
                    "via": "sckit"
                ]
            }
        }
        // fallback
        guard let png = capture(rect: desc.bounds) else { return ["error": "capture failed"] }
        return [
            "png_base64": png.base64EncodedString(),
            "width": Int(desc.bounds.size.width),
            "height": Int(desc.bounds.size.height),
            "via": "screencapture"
        ]
    case "capture.display":
        // 截某个 display 的整屏。screencapture -D <n+1>（screencapture 用 1-based display index）。
        guard let displayId = params["display_id"] as? String else { return ["error": "display_id required"] }
        guard let idx = Int(displayId.replacingOccurrences(of: "display-", with: "")) else { return ["error": "bad display_id"] }
        let screens = NSScreen.screens
        guard idx >= 0 && idx < screens.count else { return ["error": "display index out of range"] }
        let s = screens[idx]
        let f = s.frame
        guard let png = capture(rect: f) else { return ["error": "capture failed"] }
        return [
            "png_base64": png.base64EncodedString(),
            "width": Int(f.width),
            "height": Int(f.height),
            "display_id": displayId,
            "scale": s.backingScaleFactor,
        ]
    case "input.ax_press":
        // 用 AX 直接对窗口内 norm 位置的元素发 AXPress（不依赖鼠标坐标）。
        // 入参：handle + norm: [x, y]
        guard let handle = params["handle"] as? String,
              let norm = params["norm"] as? [Double], norm.count == 2 else { return ["error": "handle + norm required"] }
        let r = axPressInWindowAtNorm(handle: handle, normX: norm[0], normY: norm[1])
        return [
            "ok": r.ok,
            "via": "ax_press",
            "matched_role": (r.role as Any?) ?? NSNull(),
            "matched_name": (r.name as Any?) ?? NSNull(),
        ]
    default:
        return ["error": "unknown method: \(method)"]
    }
}

// ---------- main loop: line-by-line stdin ----------

// 初始化 NSApplication：SCKit / 某些 CG API 需要 CGS 初始化（CGSetSessionState 等），
// 否则会触发 "CGS_REQUIRE_INIT" assertion。
// .accessory = 不在 Dock 显示，不抢前台焦点；适合 sidecar tool。
let _nsApp = NSApplication.shared
_nsApp.setActivationPolicy(.accessory)

let stdin = FileHandle.standardInput
var buffer = Data()
while true {
    let chunk = stdin.availableData
    if chunk.isEmpty {
        // 上游关闭
        exit(0)
    }
    buffer.append(chunk)
    while let nl = buffer.firstIndex(of: 0x0a) {
        let line = buffer.subdata(in: 0..<nl)
        buffer.removeSubrange(0..<(nl + 1))
        if line.isEmpty { continue }
        guard let obj = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
              let method = obj["method"] as? String else {
            emitError(id: nil, message: "bad request", code: "BAD_REQUEST")
            continue
        }
        let id = obj["id"]
        let params = toDict(obj["params"])
        let result = handle(method: method, params: params)
        if let dict = result as? [String: Any], let err = dict["error"] as? String {
            emitError(id: id, message: err)
        } else {
            emitResult(id: id, result: result)
        }
    }
}
