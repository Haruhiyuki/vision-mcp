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
 * Display 的"形态"——决定它能否作为 agent workspace：
 *   - primary：主显示器，agent 操作会抢用户屏幕；不推荐做 workspace
 *   - extended：物理副屏；agent 操作不抢主屏，推荐
 *   - mirror：镜像主屏；与 primary 同内容，不推荐
 *   - sidecar：macOS Sidecar（iPad 当副屏）；推荐
 *   - airplay：AirPlay 到外部接收端；推荐
 *   - virtual：第三方虚拟显示驱动（BetterDisplay/Deskreen/DummyDisplay 等）或 Windows IDD；强推荐
 *   - unknown：检测不出来
 */
export type DisplayKind =
  | "primary"
  | "extended"
  | "mirror"
  | "sidecar"
  | "airplay"
  | "virtual"
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
  /**
   * Display 的形态分类。capsule 选 workspace 时按 virtual > sidecar/airplay > extended > primary 排序。
   * 老的 native helper 可能不返回此字段，runtime 会按 is_virtual / is_primary 兜底推断。
   */
  kind?: DisplayKind;
  /** 显示器友好名称（NSScreen.localizedName / Windows monitor friendly name）。 */
  name?: string;
  /** EDID vendor ID 或字符串（"VID"）；用于识别第三方虚拟驱动白名单。 */
  vendor?: string;
  /** EDID product ID 或字符串。 */
  product?: string;
  /**
   * runtime 判定：该 display 适合作为 agent workspace（即不会抢用户主屏）。
   * = kind ∈ {virtual, sidecar, airplay, extended} && work_area 足够大。
   */
  recommended_for_workspace?: boolean;
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
}

export interface InputClickOptions {
  button?: "left" | "right" | "middle";
  modifiers?: ReadonlyArray<"ctrl" | "shift" | "alt" | "meta">;
  click_count?: number;
  /**
   * macOS：鼠标光标策略。
   *   - "physical"（默认）：先 mouseMoved 让 cursor 飞到目标，再 down/up。用户主屏光标会跳过去。
   *   - "virtual"：down/up 完成后立即 warp 回原位，看起来"鼠标没动"。适合 off-screen workspace。
   *   - "virtual_no_warp"：完全不动 cursor（cursor 在哪里就在哪里）。配合 try_ax_press 用。
   *   - "ax_press"：完全不用鼠标，直接 AX 操作（需窗口元素有 AXPress action）；不行 fallback physical。
   */
  cursor_mode?: "physical" | "virtual" | "virtual_no_warp" | "ax_press";
  /** macOS：在 CG event 之前先尝试 AX-press 该位置元素；如果元素支持 AXPress 则完全不动鼠标。 */
  try_ax_press?: boolean;
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
  /**
   * macOS 专用：若没有真实的副屏 / virtual / sidecar / airplay，是否合成一个屏外工作区。
   * 默认 false——抛 CAPSULE_DISPLAY_MISSING 让 caller 显式决定。
   */
  allowOffScreen?: boolean;
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
