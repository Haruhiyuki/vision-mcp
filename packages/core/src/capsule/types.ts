// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Vision-MCP Authors
import type {
  ContractRules,
  GeometryContract,
  Platform,
  TargetWindow,
  VisualBox,
} from "../schema/index.js";

/** 屏幕像素坐标（不归一化），用于 native 层。 */
export interface RectPx {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Display 的形态分类。仅用于 UI 展示和诊断；vision-mcp **不**根据 kind 自动选 workspace ——
 * capsule 总是把窗口放在用户能看到的稳定 display 上（默认 primary）。
 */
export type DisplayKind =
  | "primary"
  | "extended"
  | "mirror"
  | "unknown";

export interface DisplayInfo {
  id: string;
  bounds: RectPx;
  work_area: RectPx;
  scale: number;
  dpi_x: number;
  dpi_y: number;
  refresh_rate_hz: number;
  is_primary: boolean;
  is_virtual: boolean;
  /** Display 形态分类（仅 UI 展示用，不影响 workspace 选择）。 */
  kind?: DisplayKind;
  /** 显示器友好名称（NSScreen.localizedName / Windows monitor friendly name）。 */
  name?: string;
  /** 平台原始 handle（HMONITOR / CGDirectDisplayID 序列化字符串）。 */
  native_handle?: string;
}

export interface WindowInfo {
  id: string;
  title: string;
  process_name: string;
  process_id: number;
  bundle_id?: string;
  class_name?: string;
  bounds: RectPx;
  client_bounds: RectPx;
  display_id?: string;
  is_minimized: boolean;
  is_maximized: boolean;
  is_fullscreen: boolean;
  is_foreground: boolean;
  /** 平台原始 handle（HWND / AXUIElementRef 序列化）。 */
  native_handle: string;
}

export interface Frame {
  width_px: number;
  height_px: number;
  /** RGBA buffer，长度 = width_px * height_px * 4。 */
  pixels: Uint8Array;
  captured_at: string;
  source: "display" | "window";
  /** 缩放后的客户区在该帧中的偏移与尺寸。 */
  client_rect_in_frame: RectPx;
  /**
   * 捕获走的实际路径（macOS: sckit / screencapture；Windows: print_window /
   * screen_bitblt）。区域截屏类路径拍不到被遮挡/屏外的窗口——透传给调用方，
   * 拿到黑图时能立刻判断是不是静默降级了。
   */
  via?: string;
}

export interface InputClickOptions {
  button?: "left" | "right" | "middle";
  modifiers?: ReadonlyArray<"ctrl" | "shift" | "alt" | "meta">;
  click_count?: number;
}

export interface InputTypeOptions {
  text: string;
  /** 输入间隔毫秒，模拟真实键入；默认 0 = 直接 paste/inject。 */
  per_char_delay_ms?: number;
  clear_first?: boolean;
}

export interface InputKeyOptions {
  /** 单个键或组合 "Ctrl+Shift+P"。 */
  combo: string;
  hold_ms?: number;
}

export interface InputScrollOptions {
  /** 垂直滚动像素，正为向下滚。 */
  dy_px?: number;
  dx_px?: number;
}

export interface InputDragOptions {
  to_point_px: { x: number; y: number };
  steps?: number;
  duration_ms?: number;
}

/**
 * 几何契约的当前快照。runtime 在每个动作前都会拿到此对象。
 */
export interface GeometryState {
  display: DisplayInfo;
  window: WindowInfo;
  /** 当前 client rect 在 capsule 中的占比；用于把 bbox_norm 解到屏幕坐标。 */
  client_rect_px: RectPx;
  scale_match: boolean;
  size_match: boolean;
  dpi_match: boolean;
  foreground_match: boolean;
  /** 综合判定：geometry contract 是否满足。 */
  ok: boolean;
  /** 若 !ok，记录所有违反项，供 repair engine 使用。 */
  violations: string[];
}

export interface CapsuleStatus {
  visual_box_id: string;
  mode: VisualBox["mode"];
  platform: Platform;
  attached_window?: WindowInfo;
  display?: DisplayInfo;
  geometry: GeometryState | null;
  lease_owner?: "agent" | "user" | "none";
  lease_expires_at?: string;
}

/** Capsule 生命周期事件。 */
export type CapsuleEvent =
  | { type: "attached"; window: WindowInfo }
  | { type: "migrated"; window: WindowInfo; display: DisplayInfo }
  | { type: "released"; previous_window?: WindowInfo }
  | { type: "geometry_violation"; violations: string[] }
  | { type: "lease_broken"; reason: string }
  | { type: "user_takeover" };

export type CapsuleListener = (event: CapsuleEvent) => void;

export interface AttachOptions {
  target: TargetWindow;
  /** 找到多个匹配窗口时的选择策略。 */
  pick?: "first" | "most_recent" | "largest";
}

export interface EnsureDisplayOptions {
  geometry: GeometryContract;
  mode: VisualBox["mode"];
  fallbacks?: VisualBox["fallbacks"];
}

export interface ICapsule {
  readonly id: string;
  status(): Promise<CapsuleStatus>;
  ensureDisplay(opts: EnsureDisplayOptions): Promise<DisplayInfo>;
  attach(opts: AttachOptions): Promise<WindowInfo>;
  migrate(displayId: string): Promise<WindowInfo>;
  restore(): Promise<void>;
  capture(opts?: { source?: "display" | "window" }): Promise<Frame>;
  validateGeometry(rules?: ContractRules): Promise<GeometryState>;
  acquireLease(durationMs?: number): Promise<InputLeaseHandle>;
  on(listener: CapsuleListener): () => void;
}

export interface InputLeaseHandle {
  readonly id: string;
  readonly owner: "agent" | "user";
  readonly acquired_at: string;
  readonly expires_at: string;
  /** 释放前进行的最后一次几何校验结果。 */
  geometry: GeometryState;
  release(): Promise<void>;
  isValid(): boolean;
}
