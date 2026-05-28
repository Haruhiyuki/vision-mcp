// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Vision-MCP Authors
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
  WindowInfo,
} from "../capsule/types.js";
import type {
  PlatformAdapter,
  WindowSnapshot,
} from "../capsule/manager.js";
import { NativeBridge, resolveDefaultHelper } from "./native-bridge.js";

/**
 * Windows 平台适配器。
 *
 * 真正的窗口/输入/捕获能力来自 native helper（PowerShell + Win32 / Rust + windows-rs）。
 * 在 JavaScript 层做 JSON-RPC 转换、参数校验和错误归一化。
 *
 * 不创建虚拟显示器（设计文档 §8.4）：直接迁移窗口到主屏稳定位置。
 *
 * helper 期望支持以下方法：
 *   - capsule.list_displays
 *   - window.list / window.get / window.move / window.restore / window.placement
 *   - capture.window / capture.display
 *   - input.click / input.type / input.key / input.scroll / input.drag / input.subscribe
 */
export class WindowsPlatformAdapter implements PlatformAdapter {
  readonly platform = "windows" as const;
  private constructor(private readonly bridge: NativeBridge) {}

  static async create(opts: { helperPath?: string } = {}): Promise<WindowsPlatformAdapter> {
    const helperPath = opts.helperPath ?? (await resolveDefaultHelper("windows"));
    // 15s default: PS5.1 cold start 要编 Add-Type C# 类（Win32 P/Invoke + WindowsBase +
    // MsaaDumper），头一次能花 2-5s；CI headless / 冷盘 + 5s 默认就会 timeout。对齐 macOS
    // swift helper（darwin-helper.ts 也是 15_000）。后续可加首次预热让冷启动一次性摊销。
    const bridge = await NativeBridge.tryCreate({
      helperPath: helperPath ?? undefined,
      defaultTimeoutMs: 15_000,
    });
    if (!bridge) {
      throw new VisionMcpError(
        "CAPSULE_PLATFORM_UNAVAILABLE",
        "未找到 Windows native helper。请安装 vision-mcp-helper.exe（参见 docs/deployment.md）",
        {
          details: { searched_env: "VISION_MCP_NATIVE_HELPER" },
        },
      );
    }
    return new WindowsPlatformAdapter(bridge);
  }

  async listDisplays(): Promise<DisplayInfo[]> {
    // 防御：旧 helper 在 result 是 1-element 时被 ConvertTo-Json 展平成单对象，
    // 而非数组。新 helper 用 ArrayList + -AsArray 修复了这点；这层兜底仍保留以兼容
    // 老 helper 用户。
    const raw = await this.bridge.request<DisplayInfo[] | DisplayInfo>("capsule.list_displays");
    return Array.isArray(raw) ? raw : raw ? [raw] : [];
  }

  /** 不创建虚拟显示器。挑稳定 display（优先窗口当前 display，其次 primary）。 */
  async ensureVirtualDisplay(opts: EnsureDisplayOptions): Promise<DisplayInfo> {
    const { pickStableDisplay } = await import("../capsule/workspace.js");
    const { VisionMcpError } = await import("../errors.js");
    const all = await this.listDisplays();
    if (all.length === 0) {
      throw new VisionMcpError("CAPSULE_DISPLAY_MISSING", "Windows helper 未报告任何 display");
    }
    const pick = pickStableDisplay(all, {
      minClient: { width: opts.geometry.width_px, height: opts.geometry.height_px },
    });
    return pick.display ?? all[0];
  }

  async listWindows(filter?: TargetWindow): Promise<WindowInfo[]> {
    const raw = await this.bridge.request<WindowInfo[] | WindowInfo>("window.list", { filter });
    return Array.isArray(raw) ? raw : raw ? [raw] : [];
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

  async restoreWindow(
    handle: string,
    snapshot: WindowSnapshot,
  ): Promise<WindowInfo> {
    return this.bridge.request<WindowInfo>("window.restore", { handle, snapshot });
  }

  async captureWindow(handle: string): Promise<Frame> {
    // helper 返回 {png_base64, width, height, via?}；adapter 负责解 PNG → RGBA Frame
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
  }

  async captureDisplay(displayId: string): Promise<Frame> {
    // 协议字段名 display_id（与 macOS swift helper 一致；老 ps1 同时兼容 displayId）。
    const r = await this.bridge.request<{ png_base64: string; width: number; height: number; display_id?: string; scale?: number }>(
      "capture.display",
      { display_id: displayId },
      15_000,
    );
    const png = Buffer.from(r.png_base64, "base64");
    const { width, height, pixels } = await decodePng(png);
    return {
      width_px: width,
      height_px: height,
      pixels,
      captured_at: new Date().toISOString(),
      source: "display",
      client_rect_in_frame: { x: 0, y: 0, width, height },
    };
  }

  /** 给 OCR / annotated 等 provider 用的通用 bridge 调用（不破坏 bridge 生命周期封装）。 */
  async helperRequest<T = unknown>(
    method: string,
    params: unknown = {},
    timeoutMs = 15_000,
  ): Promise<T> {
    return this.bridge.request<T>(method, params, timeoutMs);
  }

  async click(point: { x: number; y: number }, opts?: InputClickOptions): Promise<void> {
    await this.bridge.request("input.click", { point, ...opts });
  }

  async typeText(opts: InputTypeOptions): Promise<void> {
    await this.bridge.request("input.type", opts);
  }

  async pressKey(opts: InputKeyOptions): Promise<void> {
    await this.bridge.request("input.key", opts);
  }

  async scroll(
    point: { x: number; y: number },
    opts: InputScrollOptions,
  ): Promise<void> {
    await this.bridge.request("input.scroll", { point, ...opts });
  }

  async drag(
    from: { x: number; y: number },
    opts: InputDragOptions,
  ): Promise<void> {
    await this.bridge.request("input.drag", { from, ...opts });
  }

  onUserInput(cb: () => void): () => void {
    const handler = () => cb();
    this.bridge.on("user_input", handler);
    this.bridge
      .request("input.subscribe", { enabled: true })
      .catch(() => {});
    return () => {
      this.bridge.off("user_input", handler);
      this.bridge
        .request("input.subscribe", { enabled: false })
        .catch(() => {});
    };
  }

  /**
   * 等价 macOS raiseWindow：把窗口拉到前台。
   * Win32 SetForegroundWindow 在 Win10+ 有前台锁定保护（其他 app 偶尔会拒绝），
   * helper 内部用 AttachThreadInput hack 兜底。
   */
  async raiseWindow(handle: string): Promise<void> {
    try {
      const r = await this.bridge.request<{ ok: boolean }>("window.raise", { handle });
      if (r?.ok) return;
    } catch {
      // fallback
    }
    await this.bridge.request("window.activate", { handle });
  }

  /**
   * 等价 macOS axPressInWindow：用 UIAutomation InvokePattern 直接对 norm 位置的元素
   * 执行 Invoke / Select / Toggle / Expand，不依赖鼠标。
   * 适用：所有暴露 UIA 模式的标准控件（WinForms / WPF / UWP / WinUI 都支持）。
   * 不适用：自绘 UI（DirectX 游戏、自定义 control 不实现 UIA pattern）。
   */
  async axPressInWindow(
    handle: string,
    norm: [number, number],
  ): Promise<{ ok: boolean; via: string; matched_role?: string; matched_name?: string }> {
    return this.bridge.request("input.ax_press", { handle, norm });
  }

  onWindowChanged(handle: string, cb: () => void): () => void {
    const handler = (data: { handle: string }) => {
      if (data?.handle === handle) cb();
    };
    this.bridge.on("window_changed", handler);
    return () => this.bridge.off("window_changed", handler);
  }

  async dispose(): Promise<void> {
    await this.bridge.dispose();
  }
}

// 复制自 darwin-helper.ts 的 PNG 解码（避免跨平台模块互引）。
// 输入：标准 PNG bytes（IHDR/IDAT/IEND，RGB 或 RGBA 8-bit/channel）
// 输出：RGBA Uint8Array（长度 = width * height * 4），不支持隔行 / 调色板。
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
  const prevLine = new Uint8Array(stride);
  const currLine = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[src++];
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? currLine[i - channels] : 0;
      const b = prevLine[i];
      const c = i >= channels ? prevLine[i - channels] : 0;
      let value = raw[src + i];
      switch (filter) {
        case 0: break;
        case 1: value = (value + a) & 0xff; break;
        case 2: value = (value + b) & 0xff; break;
        case 3: value = (value + Math.floor((a + b) / 2)) & 0xff; break;
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
