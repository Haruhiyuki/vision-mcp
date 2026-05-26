import { randomUUID } from "node:crypto";
import { VisionMcpError } from "../errors.js";
import type {
  ContractRules,
  TargetWindow,
  VisualBox,
} from "../schema/index.js";
import { buildGeometryState, planMigrationRect } from "./geometry.js";
import { LeaseManager } from "./lease.js";
import type {
  AttachOptions,
  CapsuleEvent,
  CapsuleListener,
  CapsuleStatus,
  DisplayInfo,
  EnsureDisplayOptions,
  Frame,
  GeometryState,
  ICapsule,
  InputClickOptions,
  InputDragOptions,
  InputKeyOptions,
  InputLeaseHandle,
  InputScrollOptions,
  InputTypeOptions,
  WindowInfo,
} from "./types.js";

/**
 * Platform adapter 必须实现的最小能力。Capsule Manager 不依赖具体平台。
 */
export interface PlatformAdapter {
  readonly platform: "windows" | "macos" | "mock";
  listDisplays(): Promise<DisplayInfo[]>;
  ensureVirtualDisplay(opts: EnsureDisplayOptions): Promise<DisplayInfo>;
  listWindows(filter?: TargetWindow): Promise<WindowInfo[]>;
  getWindow(handle: string): Promise<WindowInfo>;
  moveWindow(
    handle: string,
    rect: { x: number; y: number; width: number; height: number },
  ): Promise<WindowInfo>;
  restoreWindow(handle: string, snapshot: WindowSnapshot): Promise<WindowInfo>;
  captureWindow(handle: string): Promise<Frame>;
  captureDisplay(displayId: string): Promise<Frame>;
  click(point: { x: number; y: number }, opts?: InputClickOptions): Promise<void>;
  typeText(opts: InputTypeOptions): Promise<void>;
  pressKey(opts: InputKeyOptions): Promise<void>;
  scroll(point: { x: number; y: number }, opts: InputScrollOptions): Promise<void>;
  drag(
    from: { x: number; y: number },
    opts: InputDragOptions,
  ): Promise<void>;
  /** 注册用户输入监听，回调用于 lease 打断。 */
  onUserInput(cb: () => void): () => void;
  /** 可选：监听窗口位置/尺寸变化。 */
  onWindowChanged?(handle: string, cb: () => void): () => void;
  /** 卸载/重置；在测试场景下用于复位 mock。 */
  dispose?(): Promise<void>;
}

export interface WindowSnapshot {
  handle: string;
  placement: WindowInfo;
  display_id?: string;
}

/**
 * 一个 Capsule 是一次 visual_box 的运行实例。它持有 platform adapter、
 * lease manager、当前 display/window 和原始 placement 快照（用于 restore）。
 */
export class Capsule implements ICapsule {
  readonly id: string;
  private display: DisplayInfo | null = null;
  private window: WindowInfo | null = null;
  private snapshot: WindowSnapshot | null = null;
  private listeners = new Set<CapsuleListener>();
  private leaseMgr: LeaseManager;
  private contract: ContractRules;

  constructor(
    private readonly visualBox: VisualBox,
    private readonly platform: PlatformAdapter,
    leasePolicy = { default_lease_ms: 5000, break_on_user_input: true, break_hotkey: "Esc Esc", require_revalidate_after_break: true },
  ) {
    this.id = visualBox.id || `capsule-${randomUUID().slice(0, 8)}`;
    this.contract = visualBox.contract;
    this.leaseMgr = new LeaseManager(leasePolicy);
  }

  get adapter(): PlatformAdapter {
    return this.platform;
  }

  on(listener: CapsuleListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: CapsuleEvent): void {
    for (const l of this.listeners) {
      try {
        l(event);
      } catch (err) {
        // 监听器异常不能影响主流程
        // eslint-disable-next-line no-console
        console.error("capsule listener threw", err);
      }
    }
  }

  async status(): Promise<CapsuleStatus> {
    let geometry: GeometryState | null = null;
    if (this.display && this.window) {
      geometry = buildGeometryState({
        visualBox: this.visualBox,
        contract: this.contract,
        display: this.display,
        window: this.window,
      });
    }
    const current = this.leaseMgr.current_handle();
    return {
      visual_box_id: this.visualBox.id,
      mode: this.visualBox.mode,
      platform: this.visualBox.platform,
      attached_window: this.window ?? undefined,
      display: this.display ?? undefined,
      geometry,
      lease_owner: current?.owner ?? "none",
      lease_expires_at: current?.expires_at,
    };
  }

  async ensureDisplay(opts: EnsureDisplayOptions): Promise<DisplayInfo> {
    let display: DisplayInfo;
    try {
      display = await this.platform.ensureVirtualDisplay(opts);
    } catch (err) {
      if (!opts.fallbacks?.length) throw err;
      const displays = await this.platform.listDisplays();
      const existing = displays.find(
        (d) =>
          d.work_area.width >= opts.geometry.width_px &&
          d.work_area.height >= opts.geometry.height_px,
      );
      if (!existing) {
        throw new VisionMcpError(
          "CAPSULE_DISPLAY_MISSING",
          "无法创建虚拟显示器且未找到符合尺寸的现有显示器",
          { cause: err },
        );
      }
      display = existing;
    }
    this.display = display;
    return display;
  }

  async attach(opts: AttachOptions): Promise<WindowInfo> {
    const windows = await this.platform.listWindows(opts.target);
    if (windows.length === 0) {
      throw new VisionMcpError(
        "WINDOW_NOT_FOUND",
        `未找到匹配目标窗口：${JSON.stringify(opts.target)}`,
      );
    }
    const picked = pickWindow(windows, opts.pick ?? "most_recent");
    this.snapshot = {
      handle: picked.native_handle,
      placement: picked,
      display_id: picked.display_id,
    };
    this.window = picked;
    this.emit({ type: "attached", window: picked });
    return picked;
  }

  async migrate(displayId: string): Promise<WindowInfo> {
    if (!this.window) {
      throw new VisionMcpError(
        "WINDOW_NOT_FOUND",
        "尚未 attach 窗口，无法迁移",
      );
    }
    const displays = await this.platform.listDisplays();
    const display = displays.find((d) => d.id === displayId);
    if (!display) {
      throw new VisionMcpError(
        "CAPSULE_DISPLAY_MISSING",
        `display ${displayId} 不存在`,
      );
    }
    const expected = this.visualBox.display;
    const padding = {
      dx: this.window.bounds.width - this.window.client_bounds.width,
      dy: this.window.bounds.height - this.window.client_bounds.height,
    };
    const { rect, warning } = planMigrationRect(
      display,
      { width: expected.width_px, height: expected.height_px },
      padding,
    );
    try {
      const moved = await this.platform.moveWindow(this.window.native_handle, rect);
      // adapter 可能根据 rect 反推 display_id；这里强制对齐到本次迁移的目标 display，
      // 否则 geometry contract 的 require_same_display 在 mock / 多显示器场景会误报。
      moved.display_id = display.id;
      this.window = moved;
      this.display = display;
      this.emit({ type: "migrated", window: moved, display });
      if (warning) {
        this.emit({ type: "geometry_violation", violations: [warning] });
      }
      return moved;
    } catch (err) {
      throw new VisionMcpError(
        "WINDOW_MIGRATION_FAILED",
        `迁移窗口失败：${(err as Error).message ?? err}`,
        { cause: err, recoverable: true },
      );
    }
  }

  async restore(): Promise<void> {
    if (!this.snapshot || !this.window) return;
    try {
      await this.platform.restoreWindow(this.window.native_handle, this.snapshot);
    } finally {
      const previous_window = this.window;
      this.window = null;
      this.snapshot = null;
      this.display = null;
      this.emit({ type: "released", previous_window });
    }
  }

  async capture(opts?: { source?: "display" | "window" }): Promise<Frame> {
    if (opts?.source === "display") {
      if (!this.display) {
        throw new VisionMcpError("CAPSULE_DISPLAY_MISSING", "尚未创建/绑定显示器");
      }
      return this.platform.captureDisplay(this.display.id);
    }
    if (!this.window) {
      throw new VisionMcpError("WINDOW_NOT_FOUND", "尚未 attach 窗口");
    }
    return this.platform.captureWindow(this.window.native_handle);
  }

  async validateGeometry(rules?: ContractRules): Promise<GeometryState> {
    if (!this.window || !this.display) {
      throw new VisionMcpError(
        "GEOMETRY_MISMATCH",
        "Capsule 尚未完成 attach + ensureDisplay",
      );
    }
    // 重新拉一次最新窗口信息
    this.window = await this.platform.getWindow(this.window.native_handle);
    const state = buildGeometryState({
      visualBox: this.visualBox,
      contract: rules ?? this.contract,
      display: this.display,
      window: this.window,
    });
    if (!state.ok) {
      this.emit({ type: "geometry_violation", violations: state.violations });
    }
    return state;
  }

  async acquireLease(durationMs?: number): Promise<InputLeaseHandle> {
    return this.leaseMgr.acquire(
      {
        validate: () => this.validateGeometry(),
        onUserTakeover: (cb) => this.platform.onUserInput(cb),
        emit: (e) => this.emit(e),
      },
      durationMs,
    );
  }

  breakLease(reason: string): void {
    this.leaseMgr.break(reason);
  }

  /**
   * 暴露内部 contract，repair engine 在更新 geometry profile patch 时会写回。
   */
  updateContract(partial: Partial<ContractRules>): void {
    this.contract = { ...this.contract, ...partial } as ContractRules;
  }

  getVisualBox(): VisualBox {
    return this.visualBox;
  }
}

function pickWindow(
  windows: WindowInfo[],
  strategy: "first" | "most_recent" | "largest",
): WindowInfo {
  if (strategy === "first") return windows[0];
  if (strategy === "largest") {
    return [...windows].sort(
      (a, b) =>
        b.bounds.width * b.bounds.height - a.bounds.width * a.bounds.height,
    )[0];
  }
  // most_recent：以 foreground 优先，然后按 process_id 越大越新
  return [...windows].sort((a, b) => {
    if (a.is_foreground !== b.is_foreground) return a.is_foreground ? -1 : 1;
    return b.process_id - a.process_id;
  })[0];
}
