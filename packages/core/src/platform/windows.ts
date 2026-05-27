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
    const bridge = await NativeBridge.tryCreate({ helperPath: helperPath ?? undefined });
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
    return this.bridge.request<DisplayInfo[]>("capsule.list_displays");
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

  async restoreWindow(
    handle: string,
    snapshot: WindowSnapshot,
  ): Promise<WindowInfo> {
    return this.bridge.request<WindowInfo>("window.restore", { handle, snapshot });
  }

  async captureWindow(handle: string): Promise<Frame> {
    return this.bridge.request<Frame>("capture.window", { handle }, 15_000);
  }

  async captureDisplay(displayId: string): Promise<Frame> {
    return this.bridge.request<Frame>("capture.display", { displayId }, 15_000);
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
