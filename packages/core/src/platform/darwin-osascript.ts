// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Vision-MCP Authors
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { TargetWindow } from "../schema/index.js";
import { VisionMcpError } from "../errors.js";
import type {
  DisplayInfo,
  EnsureDisplayOptions,
  Frame,
  InputClickOptions,
  InputDragOptions,
  InputKeyOptions,
  InputScrollOptions,
  InputTypeOptions,
  RectPx,
  WindowInfo,
} from "../capsule/types.js";
import type {
  PlatformAdapter,
  WindowSnapshot,
} from "../capsule/manager.js";

const execFileP = promisify(execFile);

interface JxaScreen {
  id: number;
  frame: { x: number; y: number; w: number; h: number };
  visible: { x: number; y: number; w: number; h: number };
  scale: number;
}

interface JxaWindow {
  handle: string;        // proc.pid + ":" + window index
  pid: number;
  proc: string;
  bundle_id: string | null;
  title: string;
  position: [number, number];
  size: [number, number];
  frontmost: boolean;
  visible: boolean;
  minimized: boolean;
  fullscreen: boolean;
}

/**
 * 直接基于 osascript / screencapture / CGEvent 的 darwin 适配器。
 *
 * 选择不走 sidecar JSON-RPC 的原因：
 *   - osascript 已是 macOS 自带可执行文件，无须额外编译/安装。
 *   - JXA 直接调用 NSScreen / System Events / CoreGraphics，能力覆盖度足够。
 *   - 把适配器嵌进 core，可在测试与 CI 中通过 mock 替换。
 *
 * 性能：每次调用 osascript ≈ 100-200ms。对于交互式构建/单步执行可接受；
 * 后续如需更高 FPS 的 Live View，可再切到长寿命 helper。
 */
export class DarwinOsascriptAdapter implements PlatformAdapter {
  readonly platform = "macos" as const;
  /**
   * Windows 平台适配器把 handle 当作真正的 native handle；
   * 但 macOS 没有进程间稳定的窗口 handle，所以我们用 "pid:title" 作为持久 key，
   * 每次操作时按 pid+title 重新解析。
   */
  private windowCache = new Map<string, JxaWindow>();

  async listDisplays(): Promise<DisplayInfo[]> {
    const screens = await runJxa<JxaScreen[]>(JXA_SCRIPTS.listScreens);
    return screens.map((s, i) => ({
      id: `display-${i}`,
      bounds: {
        x: Math.round(s.frame.x),
        y: Math.round(s.frame.y),
        width: Math.round(s.frame.w),
        height: Math.round(s.frame.h),
      },
      work_area: {
        x: Math.round(s.visible.x),
        y: Math.round(s.visible.y),
        width: Math.round(s.visible.w),
        height: Math.round(s.visible.h),
      },
      scale: s.scale,
      dpi_x: Math.round(72 * s.scale),
      dpi_y: Math.round(72 * s.scale),
      refresh_rate_hz: 60,
      is_primary: i === 0,
      is_virtual: false,
      native_handle: String(i),
    }));
  }

  async ensureVirtualDisplay(opts: EnsureDisplayOptions): Promise<DisplayInfo> {
    // macOS 不能创建系统虚拟显示器；按 fallback 顺序返回可用的现有 display。
    const displays = await this.listDisplays();
    // 优先匹配尺寸最接近的现有 display；real_window 模式时返回主屏即可。
    const primary = displays.find((d) => d.is_primary) ?? displays[0];
    if (!primary) {
      throw new VisionMcpError(
        "CAPSULE_DISPLAY_MISSING",
        "macOS 系统未报告任何 NSScreen，无法建立 capsule",
      );
    }
    return primary;
  }

  async listWindows(filter?: TargetWindow): Promise<WindowInfo[]> {
    const wins = await this.listWindowsRaw();
    return wins
      .filter((w) => matchWindow(w, filter))
      .map((w) => toWindowInfo(w));
  }

  /**
   * 枚举全部窗口并刷新 handle 缓存。
   * System Events 在没有辅助功能/自动化权限时不报错，而是每个进程的
   * windows() 都抛异常——旧实现逐进程 catch 后返回空数组，上层只能看到
   * 误导性的 WINDOW_NOT_FOUND。这里把「全部进程枚举失败」显式升级为
   * PERMISSION_DENIED，别再让权限问题伪装成"窗口不存在"。
   */
  private async listWindowsRaw(): Promise<JxaWindow[]> {
    const r = await runJxa<{ windows: JxaWindow[]; proc_count: number; win_errors: number }>(
      JXA_SCRIPTS.listWindows,
    );
    if (r.windows.length === 0 && r.win_errors > 0 && r.win_errors >= r.proc_count) {
      throw new VisionMcpError(
        "PERMISSION_DENIED",
        `System Events 枚举了 ${r.proc_count} 个进程但全部拿不到窗口（${r.win_errors} 个报错）——` +
          "多半是宿主进程缺少「辅助功能」或「自动化 → System Events」权限，" +
          "到系统设置 → 隐私与安全性授予后重试",
      );
    }
    this.windowCache.clear();
    for (const w of r.windows) this.windowCache.set(w.handle, w);
    return r.windows;
  }

  async getWindow(handle: string): Promise<WindowInfo> {
    // 重新枚举以拿到最新位置/尺寸
    const wins = await this.listWindowsRaw();
    const [pidStr] = handle.split(":");
    const pid = Number(pidStr);
    const inProc = wins.filter((w) => w.pid === pid);
    // 关键：macOS app 经常在主窗口外弹出 popup / sheet / tooltip。popup 在 z-order 上
    // 排前，会让 "pid:0" 指向 popup 而不是主窗口。统一用「pid 内面积最大的窗口」作为
    // 主窗口；这与人类对「目标窗口」的直觉一致。
    if (inProc.length > 0) {
      const primary = [...inProc].sort(
        (a, b) => b.size[0] * b.size[1] - a.size[0] * a.size[1],
      )[0];
      return toWindowInfo(primary);
    }
    // 完全找不到时再按全局 handle 精确匹配做一次兜底
    const exact = wins.find((w) => w.handle === handle);
    if (exact) return toWindowInfo(exact);
    const byPid = wins.find((w) => w.pid === pid);
    if (byPid) return toWindowInfo(byPid);
    throw new VisionMcpError(
      "WINDOW_NOT_FOUND",
      `osascript 未能再次定位窗口 ${handle}`,
    );
  }

  async moveWindow(
    handle: string,
    rect: { x: number; y: number; width: number; height: number },
  ): Promise<WindowInfo> {
    const [pidStr] = handle.split(":");
    const pid = Number(pidStr);
    const script = JXA_SCRIPTS.moveWindow
      .replace("__PID__", String(pid))
      .replace("__X__", String(Math.round(rect.x)))
      .replace("__Y__", String(Math.round(rect.y)))
      .replace("__W__", String(Math.round(rect.width)))
      .replace("__H__", String(Math.round(rect.height)));
    await runJxa<unknown>(script);
    // 等待 UI 刷新
    await sleep(150);
    return this.getWindow(handle);
  }

  async restoreWindow(handle: string, snapshot: WindowSnapshot): Promise<WindowInfo> {
    const p = snapshot.placement.bounds;
    return this.moveWindow(handle, {
      x: p.x,
      y: p.y,
      width: p.width,
      height: p.height,
    });
  }

  async captureWindow(handle: string): Promise<Frame> {
    // 先把窗口 raise 到前台再用屏幕 rect 截图，确保不被遮挡。
    const [pidStr] = handle.split(":");
    await runJxa(JXA_SCRIPTS.raiseWindow.replace("__PID__", String(pidStr))).catch(() => {});
    await sleep(120);
    const win = await this.getWindow(handle);
    return captureRect(win.client_bounds, "window");
  }

  async captureDisplay(displayId: string): Promise<Frame> {
    const displays = await this.listDisplays();
    const target = displays.find((d) => d.id === displayId) ?? displays[0];
    if (!target) {
      throw new VisionMcpError("CAPSULE_DISPLAY_MISSING", `未找到 display ${displayId}`);
    }
    return captureRect(target.bounds, "display");
  }

  async click(point: { x: number; y: number }, opts?: InputClickOptions): Promise<void> {
    const button = opts?.button ?? "left";
    const clickCount = opts?.click_count ?? 1;
    await runJxa(
      JXA_SCRIPTS.click
        .replace("__X__", String(Math.round(point.x)))
        .replace("__Y__", String(Math.round(point.y)))
        .replace("__BUTTON__", JSON.stringify(button))
        .replace("__COUNT__", String(clickCount)),
    );
  }

  async typeText(opts: InputTypeOptions): Promise<void> {
    // System Events 的 keystroke 不能直接输入 Unicode（包括所有 CJK 字符）。
    // 解决方案：把文本写入 NSPasteboard，再发 Cmd+V 粘贴。这是 macOS 上自动化
    // 输入中日韩文本的标准做法。当 per_char_delay_ms>0 且全 ASCII 时仍走 keystroke
    // 以模拟"逐字键入"。
    const isAscii = /^[\x00-\x7F]*$/.test(opts.text);
    if (isAscii && (opts.per_char_delay_ms ?? 0) > 0) {
      const script = JXA_SCRIPTS.typeTextKeystroke
        .replace("__DELAY__", String((opts.per_char_delay_ms ?? 0) / 1000))
        .replace("__CLEAR__", opts.clear_first ? "true" : "false");
      await runJxa(script, { TEXT_TO_TYPE: opts.text });
      return;
    }
    const script = JXA_SCRIPTS.typeTextPaste
      .replace("__CLEAR__", opts.clear_first ? "true" : "false");
    await runJxa(script, { TEXT_TO_TYPE: opts.text });
  }

  async pressKey(opts: InputKeyOptions): Promise<void> {
    const { modifiers, key } = parseCombo(opts.combo);
    await runJxa(JXA_SCRIPTS.pressKey, {
      KEY_NAME: key,
      KEY_MODIFIERS: JSON.stringify(modifiers),
    });
  }

  /**
   * 把指定 pid 的 app 切到前台。capsule.migrate 会先调用 raiseWindow；
   * 单独暴露此方法是为了让外部（runtime/CLI）在按键前刷新一次 frontmost。
   */
  async activateProcess(pid: number): Promise<void> {
    await runJxa(JXA_SCRIPTS.raiseWindow.replace("__PID__", String(pid))).catch(() => {});
  }

  /**
   * PlatformAdapter.raiseWindow 实现：根据 handle (pid:index) 激活 app。
   * Runtime 在 lease/动作前若发现窗口非 foreground 会自动调用。
   */
  async raiseWindow(handle: string): Promise<void> {
    const [pidStr] = handle.split(":");
    const pid = Number(pidStr);
    if (!Number.isFinite(pid)) return;
    await this.activateProcess(pid);
    // macOS activate 异步：osascript 退出后焦点切换仍在进行。
    // 实测 100-200ms 常常出现 "窗口未处于前台" 误报，500ms 比较稳定。
    await sleep(500);
  }

  async scroll(point: { x: number; y: number }, opts: InputScrollOptions): Promise<void> {
    await runJxa(
      JXA_SCRIPTS.scroll
        .replace("__X__", String(Math.round(point.x)))
        .replace("__Y__", String(Math.round(point.y)))
        .replace("__DX__", String(Math.round(opts.dx_px ?? 0)))
        .replace("__DY__", String(Math.round(opts.dy_px ?? 0))),
    );
  }

  async drag(
    from: { x: number; y: number },
    opts: InputDragOptions,
  ): Promise<void> {
    const steps = opts.steps ?? 20;
    const duration = opts.duration_ms ?? 200;
    await runJxa(
      JXA_SCRIPTS.drag
        .replace("__FX__", String(Math.round(from.x)))
        .replace("__FY__", String(Math.round(from.y)))
        .replace("__TX__", String(Math.round(opts.to_point_px.x)))
        .replace("__TY__", String(Math.round(opts.to_point_px.y)))
        .replace("__STEPS__", String(steps))
        .replace("__DUR__", String(Math.round(duration))),
    );
  }

  onUserInput(_cb: () => void): () => void {
    // 简化实现：暂不监听全局事件，依赖 lease 超时与 break_hotkey。
    return () => {};
  }

  async dispose(): Promise<void> {
    this.windowCache.clear();
  }
}

function matchWindow(w: JxaWindow, filter?: TargetWindow): boolean {
  if (!filter) return true;
  if (filter.process_name && w.proc !== filter.process_name) return false;
  if (filter.bundle_id && w.bundle_id !== filter.bundle_id) return false;
  if (filter.title_regex) {
    const re = new RegExp(filter.title_regex);
    if (!re.test(w.title ?? "")) return false;
  }
  return true;
}

function toWindowInfo(w: JxaWindow): WindowInfo {
  const [x, y] = w.position;
  const [width, height] = w.size;
  // System Events 给的 position / size 已经是 client rect（不含 title bar）；
  // bounds 视为相同。AppKit 的 frame 包含 title bar，但 AX 接口是 client。
  const bounds = {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
  };
  return {
    id: w.handle,
    title: w.title ?? "",
    process_name: w.proc,
    process_id: w.pid,
    bundle_id: w.bundle_id ?? undefined,
    bounds,
    client_bounds: bounds,
    display_id: undefined,
    is_minimized: w.minimized,
    is_maximized: false,
    is_fullscreen: w.fullscreen,
    is_foreground: w.frontmost,
    native_handle: w.handle,
  };
}

async function captureRect(rect: RectPx, source: "window" | "display"): Promise<Frame> {
  const file = path.join(os.tmpdir(), `vision-mcp-${randomUUID()}.png`);
  const args = [
    "-x", // no sound
    "-t",
    "png",
    "-R",
    `${rect.x},${rect.y},${rect.width},${rect.height}`,
    file,
  ];
  try {
    await execFileP("/usr/sbin/screencapture", args, { timeout: 10_000 });
    const png = await fs.readFile(file);
    const { width, height, pixels } = await decodePng(png);
    const captured_at = new Date().toISOString();
    return {
      width_px: width,
      height_px: height,
      pixels,
      captured_at,
      source,
      client_rect_in_frame: { x: 0, y: 0, width, height },
    };
  } catch (err) {
    throw new VisionMcpError(
      "PERMISSION_DENIED",
      `screencapture 失败：${(err as Error).message}。请确认已授予 Screen Recording 权限。`,
      { cause: err },
    );
  } finally {
    fs.unlink(file).catch(() => {});
  }
}

/**
 * 极简 PNG 解码：只处理 8-bit RGB / RGBA，足以处理 screencapture 输出。
 * 为了避免额外依赖，本实现用 Node 自带 zlib 解压 IDAT。
 */
async function decodePng(buf: Buffer): Promise<{ width: number; height: number; pixels: Uint8Array }> {
  const zlib = await import("node:zlib");
  if (
    buf.length < 8 ||
    buf[0] !== 0x89 ||
    buf[1] !== 0x50 ||
    buf[2] !== 0x4e ||
    buf[3] !== 0x47
  ) {
    throw new Error("not a PNG file");
  }
  let off = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idatChunks: Buffer[] = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === "IDAT") {
      idatChunks.push(data);
    } else if (type === "IEND") {
      break;
    }
    off += 12 + len;
  }
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
    // 不支持的格式：回退到 1x1 透明 frame，调用方能感知尺寸但不会崩溃。
    return { width: width || 1, height: height || 1, pixels: new Uint8Array(4) };
  }
  const channels = colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idatChunks));
  const stride = width * channels;
  const pixels = new Uint8Array(width * height * 4);
  let src = 0;
  let prevLine = new Uint8Array(stride);
  const currLine = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[src++];
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? currLine[i - channels] : 0;
      const b = prevLine[i];
      const c = i >= channels ? prevLine[i - channels] : 0;
      let value = raw[src + i];
      switch (filter) {
        case 0:
          break;
        case 1:
          value = (value + a) & 0xff;
          break;
        case 2:
          value = (value + b) & 0xff;
          break;
        case 3:
          value = (value + Math.floor((a + b) / 2)) & 0xff;
          break;
        case 4: {
          // Paeth
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          value = (value + pr) & 0xff;
          break;
        }
      }
      currLine[i] = value;
    }
    src += stride;
    // 写入 RGBA
    for (let x = 0; x < width; x++) {
      const di = (y * width + x) * 4;
      const si = x * channels;
      pixels[di] = currLine[si];
      pixels[di + 1] = currLine[si + 1];
      pixels[di + 2] = currLine[si + 2];
      pixels[di + 3] = channels === 4 ? currLine[si + 3] : 255;
    }
    prevLine.set(currLine);
  }
  return { width, height, pixels };
}

/**
 * 执行 JXA 脚本并返回 JSON 反序列化结果。
 * - extraEnv：通过环境变量传入字符串参数，避免在脚本里拼接转义。
 */
async function runJxa<T = unknown>(
  script: string,
  extraEnv: Record<string, string> = {},
): Promise<T> {
  try {
    const { stdout } = await execFileP(
      "/usr/bin/osascript",
      ["-l", "JavaScript", "-e", script],
      {
        timeout: 15_000,
        maxBuffer: 32 * 1024 * 1024,
        env: { ...process.env, ...extraEnv },
      },
    );
    const text = stdout.trim();
    if (!text) return undefined as never;
    if (text.startsWith("{") || text.startsWith("[") || text.startsWith('"') || /^-?\d/.test(text)) {
      return JSON.parse(text) as T;
    }
    return text as unknown as T;
  } catch (err) {
    const e = err as Error & { stderr?: string };
    throw new VisionMcpError(
      "UNKNOWN",
      `osascript 调用失败：${e.message}${e.stderr ? `\n${e.stderr}` : ""}`,
      { cause: err },
    );
  }
}

function parseCombo(combo: string): { modifiers: string[]; key: string } {
  const parts = combo.split("+").map((p) => p.trim());
  const key = parts.pop() ?? "";
  const mods: string[] = [];
  for (const p of parts) {
    const lower = p.toLowerCase();
    if (lower === "ctrl" || lower === "control") mods.push("control");
    else if (lower === "shift") mods.push("shift");
    else if (lower === "alt" || lower === "option") mods.push("option");
    else if (lower === "cmd" || lower === "command" || lower === "meta") mods.push("command");
  }
  return { modifiers: mods, key };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const JXA_SCRIPTS = {
  listScreens: `
ObjC.import("AppKit");
const screens = $.NSScreen.screens;
const out = [];
for (let i = 0; i < screens.js.length; i++) {
  const s = screens.js[i];
  const f = s.frame;
  const v = s.visibleFrame;
  out.push({
    id: i,
    frame: { x: f.origin.x, y: f.origin.y, w: f.size.width, h: f.size.height },
    visible: { x: v.origin.x, y: v.origin.y, w: v.size.width, h: v.size.height },
    scale: s.backingScaleFactor,
  });
}
JSON.stringify(out);
`,
  listWindows: `
const se = Application("System Events");
const procs = se.processes.whose({ visible: true })();
const out = [];
let winErrors = 0;
for (let i = 0; i < procs.length; i++) {
  const p = procs[i];
  let pid = -1;
  let bid = null;
  let name = "";
  try { name = p.name(); } catch (e) {}
  try { pid = p.unixId(); } catch (e) {}
  try { bid = p.bundleIdentifier(); } catch (e) {}
  let frontmost = false;
  try { frontmost = !!p.frontmost(); } catch (e) {}
  let wins = [];
  try { wins = p.windows(); } catch (e) { winErrors++; continue; }
  for (let j = 0; j < wins.length; j++) {
    const w = wins[j];
    let title = "";
    let pos = [0, 0];
    let size = [0, 0];
    let minimized = false;
    try { title = w.name(); } catch (e) {}
    try { pos = w.position(); } catch (e) {}
    try { size = w.size(); } catch (e) {}
    try { minimized = !!w.value({ of: w.attributes.byName("AXMinimized") }); } catch (e) {}
    out.push({
      handle: pid + ":" + j,
      pid: pid,
      proc: name,
      bundle_id: bid,
      title: title,
      position: pos,
      size: size,
      frontmost: frontmost,
      visible: true,
      minimized: minimized,
      fullscreen: false,
    });
  }
}
JSON.stringify({ windows: out, proc_count: procs.length, win_errors: winErrors });
`,
  moveWindow: `
const se = Application("System Events");
const procs = se.processes();
let target = null;
for (let i = 0; i < procs.length; i++) {
  let pid = -1;
  try { pid = procs[i].unixId(); } catch (e) {}
  if (pid === __PID__) { target = procs[i]; break; }
}
if (!target) throw new Error("pid __PID__ not found");
const wins = target.windows();
if (wins.length === 0) throw new Error("no windows for pid __PID__");
const w = wins[0];
try { w.value({ of: w.attributes.byName("AXMinimized") }) ; } catch(e) {}
try { Application(target.name()).activate(); } catch (e) {}
try { w.position = [__X__, __Y__]; } catch (e) { throw new Error("set position failed: " + e.message); }
try { w.size = [__W__, __H__]; } catch (e) { throw new Error("set size failed: " + e.message); }
JSON.stringify({ ok: true });
`,
  raiseWindow: `
const se = Application("System Events");
const procs = se.processes();
for (let i = 0; i < procs.length; i++) {
  let pid = -1;
  try { pid = procs[i].unixId(); } catch (e) {}
  if (pid === __PID__) {
    try { Application(procs[i].name()).activate(); } catch (e) {}
    try { procs[i].frontmost = true; } catch (e) {}
    break;
  }
}
JSON.stringify({ ok: true });
`,
  click: `
ObjC.import("CoreGraphics");
const button = __BUTTON__;
const buttonNum = button === "right" ? 1 : (button === "middle" ? 2 : 0);
const pt = $.CGPointMake(__X__, __Y__);
function postClick() {
  const downType = button === "right" ? 3 : (button === "middle" ? 25 : 1);
  const upType = button === "right" ? 4 : (button === "middle" ? 26 : 2);
  const downEv = $.CGEventCreateMouseEvent($(), downType, pt, buttonNum);
  const upEv = $.CGEventCreateMouseEvent($(), upType, pt, buttonNum);
  $.CGEventPost(0, downEv);
  $.CGEventPost(0, upEv);
}
for (let i = 0; i < __COUNT__; i++) {
  postClick();
  delay(0.05);
}
JSON.stringify({ ok: true });
`,
  typeTextKeystroke: `
const se = Application("System Events");
const text = $.NSProcessInfo.processInfo.environment.objectForKey("TEXT_TO_TYPE").js;
const delaySec = __DELAY__;
if (__CLEAR__) {
  se.keystroke("a", { using: ["command down"] });
  delay(0.05);
  se.keyCode(51);
  delay(0.05);
}
if (delaySec > 0) {
  for (let i = 0; i < text.length; i++) {
    se.keystroke(text.charAt(i));
    delay(delaySec);
  }
} else {
  se.keystroke(text);
}
JSON.stringify({ ok: true });
`,
  typeTextPaste: `
ObjC.import("AppKit");
const se = Application("System Events");
const text = $.NSProcessInfo.processInfo.environment.objectForKey("TEXT_TO_TYPE").js;
// 把当前剪贴板内容备份，结束后恢复，避免污染用户剪贴板。
const pb = $.NSPasteboard.generalPasteboard;
const oldString = ObjC.unwrap(pb.stringForType($.NSPasteboardTypeString)) || "";
pb.clearContents;
pb.setStringForType($(text), $.NSPasteboardTypeString);
delay(0.05);
if (__CLEAR__) {
  se.keystroke("a", { using: ["command down"] });
  delay(0.05);
  se.keyCode(51);
  delay(0.05);
}
se.keystroke("v", { using: ["command down"] });
delay(0.15);
// 恢复剪贴板
pb.clearContents;
if (oldString.length > 0) pb.setStringForType($(oldString), $.NSPasteboardTypeString);
JSON.stringify({ ok: true });
`,
  pressKey: `
const se = Application("System Events");
const key = $.NSProcessInfo.processInfo.environment.objectForKey("KEY_NAME").js;
const mods = JSON.parse($.NSProcessInfo.processInfo.environment.objectForKey("KEY_MODIFIERS").js);
const using = mods.map(m => m + " down");
const keyMap = {
  "return": 36, "enter": 36, "tab": 48, "space": 49, "escape": 53, "esc": 53,
  "delete": 51, "backspace": 51, "forwarddelete": 117,
  "up": 126, "down": 125, "left": 123, "right": 124,
  "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
  "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97,
  "f7": 98, "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111,
};
const lower = key.toLowerCase();
if (keyMap[lower] !== undefined) {
  if (using.length > 0) se.keyCode(keyMap[lower], { using: using });
  else se.keyCode(keyMap[lower]);
} else {
  if (using.length > 0) se.keystroke(key, { using: using });
  else se.keystroke(key);
}
JSON.stringify({ ok: true });
`,
  scroll: `
ObjC.import("CoreGraphics");
const dx = __DX__;
const dy = __DY__;
// 把鼠标先移到目标点（部分应用要求 hover 在 scroll target 上）
const move = $.CGEventCreateMouseEvent($(), 5, $.CGPointMake(__X__, __Y__), 0);
$.CGEventPost(0, move);
const ev = $.CGEventCreateScrollWheelEvent($(), 0, 2, -Math.round(dy / 8), -Math.round(dx / 8));
$.CGEventPost(0, ev);
JSON.stringify({ ok: true });
`,
  drag: `
ObjC.import("CoreGraphics");
const steps = __STEPS__;
const durMs = __DUR__;
const fx = __FX__, fy = __FY__, tx = __TX__, ty = __TY__;
const sleepMs = Math.max(1, Math.round(durMs / Math.max(1, steps)));
const down = $.CGEventCreateMouseEvent($(), 1, $.CGPointMake(fx, fy), 0);
$.CGEventPost(0, down);
for (let i = 1; i <= steps; i++) {
  const x = fx + ((tx - fx) * i) / steps;
  const y = fy + ((ty - fy) * i) / steps;
  const dragEv = $.CGEventCreateMouseEvent($(), 6, $.CGPointMake(x, y), 0);
  $.CGEventPost(0, dragEv);
  delay(sleepMs / 1000);
}
const up = $.CGEventCreateMouseEvent($(), 2, $.CGPointMake(tx, ty), 0);
$.CGEventPost(0, up);
JSON.stringify({ ok: true });
`,
};
