import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
import type { PlatformAdapter, WindowSnapshot } from "../capsule/manager.js";
import type { TargetWindow } from "../schema/index.js";
import {
  inferDisplayKind,
  isRecommendedWorkspace,
  pickWorkspaceDisplay,
  synthesizeOffScreenWorkspace,
} from "../capsule/workspace.js";
import { NativeBridge } from "./native-bridge.js";

/**
 * macOS 平台适配器：基于编译好的 Swift sidecar (`native/macos/vision-mcp-helper`)。
 *
 * - 每个 RPC 一次性内存调用（AXUIElement / CGEvent / NSWorkspace），单调用 < 50ms。
 * - 同一 helper 进程长寿命，没有 osascript 的 ~150ms 启动开销。
 * - 截图仍用 screencapture 子进程兜底（macOS 15+ 弃用了 CGWindowListCreateImage）。
 *
 * 与 osascript adapter 比，AX dump 从 ~30s 降到 ~50ms（500x）。
 */
export class DarwinHelperAdapter implements PlatformAdapter {
  readonly platform = "macos" as const;
  private constructor(private readonly bridge: NativeBridge) {}

  static async create(opts: { helperPath?: string } = {}): Promise<DarwinHelperAdapter> {
    const helperPath = opts.helperPath ?? (await resolveBundledHelper());
    if (!helperPath) {
      throw new VisionMcpError(
        "CAPSULE_PLATFORM_UNAVAILABLE",
        "未找到 vision-mcp-helper（macOS）。请运行 `(cd native/macos && swiftc -O -o vision-mcp-helper src/main.swift -framework AppKit -framework ApplicationServices -framework CoreGraphics)` 编译。",
      );
    }
    const bridge = await NativeBridge.tryCreate({
      helperPath,
      defaultTimeoutMs: 15_000,
    });
    if (!bridge) {
      throw new VisionMcpError("CAPSULE_PLATFORM_UNAVAILABLE", `helper 启动失败：${helperPath}`);
    }
    return new DarwinHelperAdapter(bridge);
  }

  async listDisplays(): Promise<DisplayInfo[]> {
    const raw = await this.bridge.request<RawDisplay[]>("capsule.list_displays");
    return raw.map((d) => {
      const base: DisplayInfo = {
        id: d.id,
        bounds: d.bounds,
        work_area: d.work_area,
        scale: d.scale,
        dpi_x: d.dpi_x,
        dpi_y: d.dpi_y,
        refresh_rate_hz: d.refresh_rate_hz,
        is_primary: d.is_primary,
        is_virtual: d.is_virtual,
        native_handle: d.native_handle,
        kind: d.kind as DisplayInfo["kind"],
        name: d.name,
        vendor: d.vendor,
        product: d.product,
        recommended_for_workspace: d.recommended_for_workspace,
      };
      // 老 helper 不传 kind / recommended_for_workspace：用本地推断兜底。
      if (!base.kind) base.kind = inferDisplayKind(base);
      if (base.recommended_for_workspace === undefined) {
        base.recommended_for_workspace = isRecommendedWorkspace(base);
      }
      return base;
    });
  }

  /**
   * macOS 选 workspace 显示器：
   *   1. 真实 displays 中按 virtual > sidecar > airplay > extended 评分（pickWorkspaceDisplay）
   *   2. mode == "off_screen" 或 allowOffScreen == true → 合成屏外工作区
   *   3. mode == "real_window" → 返回 primary（capsule 用窗口自身坐标系）
   *   4. 都不行 → 抛错让 capsule.ensureDisplay 走 fallbacks
   */
  async ensureVirtualDisplay(opts: EnsureDisplayOptions): Promise<DisplayInfo> {
    const all = await this.listDisplays();
    if (all.length === 0) {
      throw new VisionMcpError("CAPSULE_DISPLAY_MISSING", "macOS 未报告任何 NSScreen");
    }
    const minClient = {
      width: opts.geometry.width_px,
      height: opts.geometry.height_px,
    };
    if (opts.mode === "real_window") {
      return all.find((d) => d.is_primary) ?? all[0];
    }
    const allowOffScreen =
      opts.allowOffScreen === true ||
      (opts.fallbacks ?? []).includes("off_screen" as never) ||
      opts.mode === ("off_screen" as never);
    const pick = pickWorkspaceDisplay(all, { minClient });
    if (pick.display) return pick.display;
    if (allowOffScreen) {
      const primary = all.find((d) => d.is_primary) ?? all[0];
      return synthesizeOffScreenWorkspace({
        primary,
        width: opts.geometry.width_px,
        height: opts.geometry.height_px,
      });
    }
    throw new VisionMcpError(
      "CAPSULE_DISPLAY_MISSING",
      `未找到合适的 workspace 显示器：${pick.reason}。可用：${all
        .map((d) => `${d.id}(${d.kind ?? "?"})`)
        .join(", ")}。提示：连接副屏 / 启用 Sidecar / 安装 BetterDisplay 等虚拟显示驱动，或在 ensureDisplay 中传 allowOffScreen=true 启用屏外工作区。`,
      { details: { displays: all, scored: pick.scored } },
    );
  }

  async listWindows(filter?: TargetWindow): Promise<WindowInfo[]> {
    return this.bridge.request<WindowInfo[]>("window.list", { filter });
  }

  async getWindow(handle: string): Promise<WindowInfo> {
    return this.bridge.request<WindowInfo>("window.get", { handle });
  }

  async moveWindow(
    handle: string,
    rect: { x: number; y: number; width: number; height: number },
  ): Promise<WindowInfo> {
    return this.bridge.request<WindowInfo>("window.move", { handle, rect });
  }

  async restoreWindow(handle: string, snapshot: WindowSnapshot): Promise<WindowInfo> {
    return this.bridge.request<WindowInfo>("window.restore", { handle, snapshot });
  }

  async captureWindow(handle: string): Promise<Frame> {
    // 优先 capture.window（CGWindowList）：能抓到屏外或部分屏外的窗口。
    // 老 helper 没有此方法时降级 screencapture rect（屏外时会拿到黑图）。
    try {
      const r = await this.bridge.request<{ png_base64: string; width: number; height: number; via?: string }>(
        "capture.window",
        { handle },
        15_000,
      );
      const png = Buffer.from(r.png_base64, "base64");
      const { width, height, pixels } = await decodePng(png);
      return {
        width_px: width,
        height_px: height,
        pixels,
        captured_at: new Date().toISOString(),
        source: "window",
        client_rect_in_frame: { x: 0, y: 0, width, height },
      };
    } catch {
      // fallback
    }
    const w = await this.getWindow(handle);
    return this.captureRect(w.client_bounds, "window");
  }

  async captureDisplay(displayId: string): Promise<Frame> {
    const displays = await this.listDisplays();
    const d = displays.find((x) => x.id === displayId);
    if (!d) throw new VisionMcpError("CAPSULE_DISPLAY_MISSING", `display ${displayId} 不存在`);
    return this.captureRect(d.bounds, "display");
  }

  private async captureRect(rect: RectPx, source: "window" | "display"): Promise<Frame> {
    const r = await this.bridge.request<{ png_base64: string; width: number; height: number }>(
      "capture.rect",
      { rect },
      15_000,
    );
    const png = Buffer.from(r.png_base64, "base64");
    const { width, height, pixels } = await decodePng(png);
    return {
      width_px: width,
      height_px: height,
      pixels,
      captured_at: new Date().toISOString(),
      source,
      client_rect_in_frame: { x: 0, y: 0, width, height },
    };
  }

  async click(point: { x: number; y: number }, opts?: InputClickOptions): Promise<void> {
    await this.bridge.request("input.click", {
      point,
      button: opts?.button,
      click_count: opts?.click_count,
      cursor_mode: opts?.cursor_mode,
      try_ax_press: opts?.try_ax_press,
    });
  }

  /**
   * macOS 专用：用 AX 操作窗口内 norm 位置的元素，完全不动鼠标光标。
   * 适合 off-screen workspace 模式下点击屏外/半屏外的窗口元素。
   */
  async axPressInWindow(handle: string, norm: [number, number]): Promise<{ ok: boolean; via: string; matched_role?: string; matched_name?: string }> {
    return this.bridge.request("input.ax_press", { handle, norm });
  }

  async typeText(opts: InputTypeOptions): Promise<void> {
    await this.bridge.request("input.type", {
      text: opts.text,
      clear_first: opts.clear_first ?? false,
    });
  }

  async pressKey(opts: InputKeyOptions): Promise<void> {
    await this.bridge.request("input.key", { combo: opts.combo });
  }

  async scroll(
    point: { x: number; y: number },
    opts: InputScrollOptions,
  ): Promise<void> {
    await this.bridge.request("input.scroll", {
      point,
      dx_px: opts.dx_px,
      dy_px: opts.dy_px,
    });
  }

  async drag(from: { x: number; y: number }, opts: InputDragOptions): Promise<void> {
    await this.bridge.request("input.drag", {
      from,
      to_point_px: opts.to_point_px,
      steps: opts.steps,
      duration_ms: opts.duration_ms,
    });
  }

  onUserInput(_cb: () => void): () => void {
    // helper 暂未实现全局事件订阅；与 osascript adapter 一致先返回 no-op。
    return () => {};
  }

  async raiseWindow(handle: string): Promise<void> {
    // 优先 window.raise：AXRaise + 必要时 activate + 保位置。
    // off-screen workspace 模式必须用这个：window.activate 会让 macOS 把屏外窗口拉回主屏。
    try {
      const r = await this.bridge.request<{ ok: boolean }>("window.raise", {
        handle,
        keep_position: true,
      });
      if (r?.ok) {
        await sleep(120);
        return;
      }
    } catch {
      // 老 helper 不支持 window.raise，降级到 window.activate
    }
    await this.bridge.request("window.activate", { handle });
    await sleep(180);
  }

  /**
   * 直接 dump AX 树。供 DarwinAccessibilityProvider 使用。
   */
  async dumpAxTree(handle: string, maxNodes = 500, maxDepth = 6): Promise<RawAxNode[]> {
    return this.bridge.request<RawAxNode[]>("ax.dump", {
      handle,
      max_nodes: maxNodes,
      max_depth: maxDepth,
    });
  }

  /**
   * 通用 RPC：让其他 provider（如 OCR）直接走 helper bridge 调任意方法。
   * 这是个相对低层的开口；公开它而非 bridge 本身，避免外部直接干预 bridge 生命周期。
   */
  async helperRequest<T = unknown>(
    method: string,
    params: unknown = {},
    timeoutMs = 15_000,
  ): Promise<T> {
    return this.bridge.request<T>(method, params, timeoutMs);
  }

  async dispose(): Promise<void> {
    await this.bridge.dispose();
  }
}

interface RawDisplay {
  id: string;
  bounds: RectPx;
  work_area: RectPx;
  scale: number;
  dpi_x: number;
  dpi_y: number;
  refresh_rate_hz: number;
  is_primary: boolean;
  is_virtual: boolean;
  native_handle: string;
  // 新字段（Swift helper v0.2+）：可能不存在
  kind?: string;
  name?: string;
  vendor?: string;
  product?: string;
  recommended_for_workspace?: boolean;
}

export interface RawAxNode {
  role: string;
  name?: string;
  desc?: string;
  pos?: [number, number];
  size?: [number, number];
  depth: number;
  path: string;
}

async function resolveBundledHelper(): Promise<string | null> {
  const env = process.env.VISION_MCP_NATIVE_HELPER;
  if (env) {
    try {
      const st = await fs.stat(env);
      if (st.isFile()) return env;
    } catch {}
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // 编译产物默认位置：repo/native/macos/vision-mcp-helper
    path.resolve(here, "../../../../native/macos/vision-mcp-helper"),
    path.resolve(here, "../../../../../native/macos/vision-mcp-helper"),
    path.resolve(process.cwd(), "native/macos/vision-mcp-helper"),
  ];
  for (const p of candidates) {
    try {
      const st = await fs.stat(p);
      if (st.isFile()) return p;
    } catch {}
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// 复制自 darwin-osascript.ts 的 PNG 解码器（避免循环依赖）。
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
