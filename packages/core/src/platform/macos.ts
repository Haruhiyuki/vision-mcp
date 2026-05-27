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
import {
  inferDisplayKind,
  isRecommendedWorkspace,
  pickWorkspaceDisplay,
  synthesizeOffScreenWorkspace,
} from "../capsule/workspace.js";
import { NativeBridge, resolveDefaultHelper } from "./native-bridge.js";

/**
 * macOS 平台适配器。
 *
 * 实际窗口/捕获/输入由 native helper（Swift + ScreenCaptureKit + Accessibility + CGEvent）提供。
 * 不支持创建系统级虚拟显示器；ensureVirtualDisplay 会按设计文档 §9.2 走 fallback：
 * 优先 real_window，其次 existing_display（要求用户已连接第二显示器）。
 */
export class MacosPlatformAdapter implements PlatformAdapter {
  readonly platform = "macos" as const;
  private constructor(private readonly bridge: NativeBridge) {}

  static async create(opts: { helperPath?: string } = {}): Promise<MacosPlatformAdapter> {
    const helperPath = opts.helperPath ?? (await resolveDefaultHelper("macos"));
    const bridge = await NativeBridge.tryCreate({ helperPath: helperPath ?? undefined });
    if (!bridge) {
      throw new VisionMcpError(
        "CAPSULE_PLATFORM_UNAVAILABLE",
        "未找到 macOS native helper。请安装并授予 Screen Recording / Accessibility 权限。",
        { details: { searched_env: "VISION_MCP_NATIVE_HELPER" } },
      );
    }
    return new MacosPlatformAdapter(bridge);
  }

  async listDisplays(): Promise<DisplayInfo[]> {
    const raw = await this.bridge.request<DisplayInfo[]>("capsule.list_displays");
    // 老 helper 不返回 kind / recommended_for_workspace；这里统一补齐。
    return raw.map((d) => ({
      ...d,
      kind: d.kind ?? inferDisplayKind(d),
      recommended_for_workspace:
        d.recommended_for_workspace ?? isRecommendedWorkspace(d),
    }));
  }

  /**
   * macOS 不"创建"系统级虚拟显示器（设计文档 §9.5）。
   * 这里按以下优先级选 workspace：
   *   1. 真实 displays 中找 virtual > sidecar > airplay > extended（pickWorkspaceDisplay）
   *   2. mode == "off_screen" 或 allow_off_screen 时合成 off-screen workspace（窗口放主屏外）
   *   3. mode == "real_window" 直接返回 primary（不切 workspace，capsule 用窗口自身坐标）
   *   4. 都不行 → 抛错让 capsule.ensureDisplay 走 fallbacks
   *
   * 不再调 helper 的 capsule.ensure_workspace_display——helper 端没有实现真"创建"，
   * 之前直接返回 displays[0] 会让 runtime 误以为得到了"虚拟"显示器实际只是 primary。
   */
  async ensureVirtualDisplay(opts: EnsureDisplayOptions): Promise<DisplayInfo> {
    const all = await this.listDisplays();
    if (all.length === 0) {
      throw new VisionMcpError(
        "CAPSULE_DISPLAY_MISSING",
        "macOS helper 未报告任何 display",
      );
    }
    const minClient = {
      width: opts.geometry.width_px,
      height: opts.geometry.height_px,
    };
    if (opts.mode === "real_window") {
      return all.find((d) => d.is_primary) ?? all[0];
    }
    const allowOffScreen = (opts as { allowOffScreen?: boolean }).allowOffScreen === true;
    const pick = pickWorkspaceDisplay(all, { minClient });
    if (pick.display) return pick.display;

    // 没有合适的真实 workspace
    if (allowOffScreen || opts.fallbacks?.includes("off_screen" as never)) {
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
        .join(", ")}。提示：连接副屏 / 启用 Sidecar / 安装 BetterDisplay 等虚拟显示驱动，或通过 ensureDisplay({ allowOffScreen: true }) 启用屏外工作区。`,
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

  async drag(from: { x: number; y: number }, opts: InputDragOptions): Promise<void> {
    await this.bridge.request("input.drag", { from, ...opts });
  }

  onUserInput(cb: () => void): () => void {
    const handler = () => cb();
    this.bridge.on("user_input", handler);
    this.bridge.request("input.subscribe", { enabled: true }).catch(() => {});
    return () => {
      this.bridge.off("user_input", handler);
      this.bridge.request("input.subscribe", { enabled: false }).catch(() => {});
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
