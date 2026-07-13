// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Vision-MCP Authors
import { randomUUID } from "node:crypto";
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
import type { TargetWindow } from "../schema/index.js";
import type {
  PlatformAdapter,
  WindowSnapshot,
} from "../capsule/manager.js";

export interface MockWindowSpec {
  title: string;
  process_name: string;
  bundle_id?: string;
  class_name?: string;
  bounds: RectPx;
  client_inset?: { left: number; top: number; right: number; bottom: number };
  is_minimized?: boolean;
  is_maximized?: boolean;
  is_fullscreen?: boolean;
  is_foreground?: boolean;
  display_id?: string;
  pixels?: Uint8Array;
}

export interface MockDisplaySpec {
  id?: string;
  bounds: RectPx;
  work_area?: RectPx;
  scale?: number;
  dpi_x?: number;
  dpi_y?: number;
  refresh_rate_hz?: number;
  is_primary?: boolean;
  is_virtual?: boolean;
}

/**
 * 内存模拟的平台适配器。用途：
 *   1. 单元测试与集成测试。
 *   2. CI 中无窗口环境下演示 vision-mcp 完整流程（builder/runtime/repair）。
 *   3. 真实平台 native 模块加载失败时的回退（带明确警告）。
 */
export class MockPlatformAdapter implements PlatformAdapter {
  readonly platform = "mock" as const;
  private displays = new Map<string, DisplayInfo>();
  private windows = new Map<string, MockWindow>();
  private userInputListeners = new Set<() => void>();
  private windowListeners = new Map<string, Set<() => void>>();
  /**
   * 注入的伪 OCR / 状态映射：根据 window handle + client rect 返回特定像素，
   * 让 builder 与 runtime 能跑通端到端流程。
   */
  private frameProvider:
    | ((win: WindowInfo) => Frame | undefined)
    | null = null;
  /** 自动 ensureVirtualDisplay 调用产出的尺寸。 */
  private nextVirtualDisplay?: MockDisplaySpec;

  constructor(initial?: {
    displays?: MockDisplaySpec[];
    windows?: MockWindowSpec[];
  }) {
    if (initial?.displays) {
      for (const d of initial.displays) this.addDisplay(d);
    } else {
      this.addDisplay({
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        is_primary: true,
      });
    }
    if (initial?.windows) {
      for (const w of initial.windows) this.addWindow(w);
    }
  }

  addDisplay(spec: MockDisplaySpec): DisplayInfo {
    const id = spec.id ?? `display-${randomUUID().slice(0, 6)}`;
    // 虚拟显示器默认没有 task bar，work_area = bounds；普通显示器留 28 px。
    const isVirtual = spec.is_virtual ?? false;
    const work_area =
      spec.work_area ??
      (isVirtual
        ? { ...spec.bounds }
        : ({
            ...spec.bounds,
            y: spec.bounds.y + 28,
            height: Math.max(0, spec.bounds.height - 28),
          } as RectPx));
    const info: DisplayInfo = {
      id,
      bounds: spec.bounds,
      work_area,
      scale: spec.scale ?? 1.0,
      dpi_x: spec.dpi_x ?? 96,
      dpi_y: spec.dpi_y ?? 96,
      refresh_rate_hz: spec.refresh_rate_hz ?? 60,
      is_primary: spec.is_primary ?? false,
      is_virtual: spec.is_virtual ?? false,
      native_handle: id,
    };
    this.displays.set(id, info);
    return info;
  }

  addWindow(spec: MockWindowSpec): WindowInfo {
    const id = `window-${randomUUID().slice(0, 6)}`;
    const win = new MockWindow(id, spec, () => this.notifyWindow(id));
    this.windows.set(id, win);
    return win.toInfo();
  }

  setFrameProvider(p: ((win: WindowInfo) => Frame | undefined) | null) {
    this.frameProvider = p;
  }

  /** 模拟窗口被关闭/进程退出：句柄失效，后续 getWindow/capture 抛错。 */
  removeWindow(handle: string): void {
    this.windows.delete(handle);
    this.windowListeners.delete(handle);
  }

  scheduleVirtualDisplay(spec: MockDisplaySpec): void {
    this.nextVirtualDisplay = spec;
  }

  /** 模拟用户在 capsule 内的输入；触发已注册的 lease 打断。 */
  simulateUserInput(): void {
    for (const cb of this.userInputListeners) cb();
  }

  async listDisplays(): Promise<DisplayInfo[]> {
    return [...this.displays.values()];
  }

  async ensureVirtualDisplay(opts: EnsureDisplayOptions): Promise<DisplayInfo> {
    const existing = this.nextVirtualDisplay;
    this.nextVirtualDisplay = undefined;
    return this.addDisplay({
      ...existing,
      bounds: {
        x: 100,
        y: 100,
        width: existing?.bounds.width ?? opts.geometry.width_px,
        height: existing?.bounds.height ?? opts.geometry.height_px,
      },
      is_virtual: true,
      scale: opts.geometry.scale,
      dpi_x: opts.geometry.dpi_x,
      dpi_y: opts.geometry.dpi_y,
      refresh_rate_hz: opts.geometry.refresh_rate_hz,
    });
  }

  async listWindows(filter?: TargetWindow): Promise<WindowInfo[]> {
    const list = [...this.windows.values()].map((w) => w.toInfo());
    return list.filter((w) => matchWindow(w, filter));
  }

  async getWindow(handle: string): Promise<WindowInfo> {
    const win = this.windows.get(handle);
    if (!win) throw new Error(`mock window ${handle} not found`);
    return win.toInfo();
  }

  async moveWindow(
    handle: string,
    rect: { x: number; y: number; width: number; height: number },
  ): Promise<WindowInfo> {
    const win = this.windows.get(handle);
    if (!win) throw new Error(`mock window ${handle} not found`);
    win.move(rect);
    win.spec.is_minimized = false;
    win.spec.is_maximized = false;
    win.spec.is_fullscreen = false;
    const display = this.findDisplayContaining(rect);
    if (display) win.spec.display_id = display.id;
    return win.toInfo();
  }

  async restoreWindow(handle: string, snapshot: WindowSnapshot): Promise<WindowInfo> {
    const win = this.windows.get(handle);
    if (!win) throw new Error(`mock window ${handle} not found`);
    win.spec.bounds = snapshot.placement.bounds;
    win.spec.is_minimized = snapshot.placement.is_minimized;
    win.spec.is_maximized = snapshot.placement.is_maximized;
    win.spec.is_fullscreen = snapshot.placement.is_fullscreen;
    win.spec.display_id = snapshot.placement.display_id;
    return win.toInfo();
  }

  async captureWindow(handle: string): Promise<Frame> {
    const win = await this.getWindow(handle);
    if (this.frameProvider) {
      const provided = this.frameProvider(win);
      if (provided) return provided;
    }
    return synthesizeFrame(win);
  }

  async captureDisplay(displayId: string): Promise<Frame> {
    const display = this.displays.get(displayId);
    if (!display) throw new Error(`mock display ${displayId} not found`);
    return synthesizeDisplayFrame(display);
  }

  async click(_p: { x: number; y: number }, _opts?: InputClickOptions): Promise<void> {
    // mock 无实际效果，仅供 lease/audit 走通
  }

  async typeText(_opts: InputTypeOptions): Promise<void> {}

  async pressKey(_opts: InputKeyOptions): Promise<void> {}

  async scroll(
    _p: { x: number; y: number },
    _opts: InputScrollOptions,
  ): Promise<void> {}

  async drag(
    _from: { x: number; y: number },
    _opts: InputDragOptions,
  ): Promise<void> {}

  onUserInput(cb: () => void): () => void {
    this.userInputListeners.add(cb);
    return () => this.userInputListeners.delete(cb);
  }

  onWindowChanged(handle: string, cb: () => void): () => void {
    let set = this.windowListeners.get(handle);
    if (!set) {
      set = new Set();
      this.windowListeners.set(handle, set);
    }
    set.add(cb);
    return () => set!.delete(cb);
  }

  async dispose(): Promise<void> {
    this.displays.clear();
    this.windows.clear();
    this.userInputListeners.clear();
    this.windowListeners.clear();
  }

  private notifyWindow(handle: string) {
    const set = this.windowListeners.get(handle);
    if (!set) return;
    for (const cb of set) cb();
  }

  private findDisplayContaining(rect: RectPx): DisplayInfo | undefined {
    // 优先匹配虚拟显示器；同尺寸时一个 rect 可能被多个 display 包含。
    const all = [...this.displays.values()];
    const fits = (d: DisplayInfo) =>
      rect.x >= d.bounds.x &&
      rect.y >= d.bounds.y &&
      rect.x + rect.width <= d.bounds.x + d.bounds.width &&
      rect.y + rect.height <= d.bounds.y + d.bounds.height;
    return all.find((d) => d.is_virtual && fits(d)) ?? all.find(fits);
  }
}

class MockWindow {
  constructor(
    readonly id: string,
    public spec: MockWindowSpec,
    private readonly notify: () => void,
  ) {}

  toInfo(): WindowInfo {
    const inset = this.spec.client_inset ?? {
      left: 0,
      top: 0,
      right: 0,
      bottom: 0,
    };
    const b = this.spec.bounds;
    return {
      id: this.id,
      title: this.spec.title,
      process_name: this.spec.process_name,
      process_id: 10000 + Math.abs(hashStr(this.id)) % 1000,
      bundle_id: this.spec.bundle_id,
      class_name: this.spec.class_name,
      bounds: b,
      client_bounds: {
        x: b.x + inset.left,
        y: b.y + inset.top,
        width: b.width - inset.left - inset.right,
        height: b.height - inset.top - inset.bottom,
      },
      display_id: this.spec.display_id,
      is_minimized: this.spec.is_minimized ?? false,
      is_maximized: this.spec.is_maximized ?? false,
      is_fullscreen: this.spec.is_fullscreen ?? false,
      is_foreground: this.spec.is_foreground ?? true,
      native_handle: this.id,
    };
  }

  move(rect: RectPx) {
    this.spec.bounds = rect;
    this.notify();
  }
}

function matchWindow(w: WindowInfo, filter?: TargetWindow): boolean {
  if (!filter) return true;
  if (filter.process_name && w.process_name !== filter.process_name) return false;
  if (filter.bundle_id && w.bundle_id !== filter.bundle_id) return false;
  if (filter.class_name && w.class_name !== filter.class_name) return false;
  if (filter.title_regex) {
    const re = new RegExp(filter.title_regex);
    if (!re.test(w.title)) return false;
  }
  return true;
}

function synthesizeFrame(win: WindowInfo): Frame {
  const w = win.client_bounds.width;
  const h = win.client_bounds.height;
  const pixels = new Uint8Array(w * h * 4);
  pixels.fill(255);
  return {
    width_px: w,
    height_px: h,
    pixels,
    captured_at: new Date().toISOString(),
    source: "window",
    client_rect_in_frame: { x: 0, y: 0, width: w, height: h },
  };
}

function synthesizeDisplayFrame(display: DisplayInfo): Frame {
  const w = display.bounds.width;
  const h = display.bounds.height;
  const pixels = new Uint8Array(w * h * 4);
  pixels.fill(240);
  return {
    width_px: w,
    height_px: h,
    pixels,
    captured_at: new Date().toISOString(),
    source: "display",
    client_rect_in_frame: { x: 0, y: 0, width: w, height: h },
  };
}

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}
