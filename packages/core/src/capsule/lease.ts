import { randomUUID } from "node:crypto";
import { VisionMcpError } from "../errors.js";
import type {
  CapsuleListener,
  GeometryState,
  InputLeaseHandle,
} from "./types.js";
import type { InputLeasePolicy } from "../schema/index.js";

export interface LeaseHostHooks {
  validate(): Promise<GeometryState>;
  onUserTakeover(cb: () => void): () => void;
  emit(event: { type: "lease_broken"; reason: string }): void;
}

/**
 * Input lease 状态机。设计目标（§7.6）：
 *   - 单个 capsule 同时只有一个有效 lease。
 *   - 用户输入 / 热键 / 高风险动作可在持有期间打断。
 *   - 打断后 require_revalidate_after_break 决定是否要重新校验 geometry。
 */
export class LeaseManager {
  private current: ActiveLease | null = null;

  constructor(private readonly policy: InputLeasePolicy) {}

  async acquire(
    host: LeaseHostHooks,
    durationMs: number = this.policy.default_lease_ms,
  ): Promise<InputLeaseHandle> {
    if (this.current && this.current.isValid()) {
      throw new VisionMcpError(
        "INPUT_LEASE_DENIED",
        `已有有效 lease（id=${this.current.id}），请等待释放或主动打断`,
        { details: { current_lease_id: this.current.id } },
      );
    }
    const geometry = await host.validate();
    if (!geometry.ok) {
      throw new VisionMcpError(
        "GEOMETRY_MISMATCH",
        "在 acquire lease 时几何契约失败",
        { details: { violations: geometry.violations }, recoverable: true },
      );
    }
    const lease = new ActiveLease(
      this,
      geometry,
      durationMs,
      this.policy,
      host,
    );
    this.current = lease;
    return lease;
  }

  break(reason: string): void {
    if (!this.current) return;
    this.current._invalidate(reason);
    this.current = null;
  }

  current_handle(): InputLeaseHandle | null {
    return this.current;
  }

  /** 仅供 ActiveLease 内部调用。 */
  _clear(lease: ActiveLease): void {
    if (this.current === lease) this.current = null;
  }
}

class ActiveLease implements InputLeaseHandle {
  readonly id: string;
  readonly owner: "agent" | "user" = "agent";
  readonly acquired_at: string;
  readonly expires_at: string;
  geometry: GeometryState;
  private valid = true;
  private timer: NodeJS.Timeout;
  private unsubscribe: () => void;
  private brokenReason?: string;

  constructor(
    private readonly mgr: LeaseManager,
    geometry: GeometryState,
    durationMs: number,
    policy: InputLeasePolicy,
    private readonly host: LeaseHostHooks,
  ) {
    this.id = randomUUID();
    this.acquired_at = new Date().toISOString();
    this.expires_at = new Date(Date.now() + durationMs).toISOString();
    this.geometry = geometry;
    this.timer = setTimeout(
      () => this._invalidate("lease_expired"),
      durationMs,
    );
    this.unsubscribe = policy.break_on_user_input
      ? host.onUserTakeover(() => this._invalidate("user_takeover"))
      : () => {};
  }

  isValid(): boolean {
    return this.valid && Date.now() < new Date(this.expires_at).getTime();
  }

  async release(): Promise<void> {
    this._cleanup();
    this.valid = false;
    this.mgr._clear(this);
  }

  /** @internal */
  _invalidate(reason: string): void {
    if (!this.valid) return;
    this.valid = false;
    this.brokenReason = reason;
    this._cleanup();
    this.host.emit({ type: "lease_broken", reason });
    this.mgr._clear(this);
  }

  private _cleanup() {
    clearTimeout(this.timer);
    this.unsubscribe();
  }
}

export function isLeaseValid(handle: InputLeaseHandle | null): boolean {
  return !!handle && handle.isValid();
}
