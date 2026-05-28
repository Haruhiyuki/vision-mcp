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
import {
  inferDisplayKind,
  pickStableDisplay,
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
    return raw.map((d) => ({
      ...d,
      kind: d.kind ?? inferDisplayKind(d),
    }));
  }

  /**
   * 不创建虚拟显示器（设计文档 §9.5 / §8.4）。直接挑稳定 display：
   * 优先窗口当前 display，其次 primary。窗口将被迁到这个 display 的工作区中心，**完整可见**。
   */
  async ensureVirtualDisplay(opts: EnsureDisplayOptions): Promise<DisplayInfo> {
    const all = await this.listDisplays();
    if (all.length === 0) {
      throw new VisionMcpError(
        "CAPSULE_DISPLAY_MISSING",
        "macOS helper 未报告任何 display",
      );
    }
    const pick = pickStableDisplay(all, {
      minClient: {
        width: opts.geometry.width_px,
        height: opts.geometry.height_px,
      },
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
