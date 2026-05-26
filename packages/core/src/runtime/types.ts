import type {
  ActionType,
  Control,
  RiskLevel,
  State,
  VisionMap,
} from "../schema/index.js";
import type { Capsule } from "../capsule/manager.js";
import type { Patch } from "../schema/patch.js";
import type {
  LocatorMatch,
  LocatorProviders,
  StateMatch,
} from "../locator/types.js";
import type { FileTraceStore, ApprovalResolver, TraceEventBase } from "../trace/index.js";

export interface RuntimeOptions {
  map: VisionMap;
  mapBaseDir: string;
  capsule: Capsule;
  providers: LocatorProviders;
  trace?: FileTraceStore;
  approval?: ApprovalResolver;
  sessionId?: string;
  /** 当 runtime 自动写入修复 patch 时回调。 */
  onPatch?: (patch: Patch) => Promise<void> | void;
  /** 允许调用方修改 perform_action 之前的 params。 */
  onBeforeAction?: (ctx: ActionContext) => Promise<ActionContext> | ActionContext;
}

export interface ActionParams {
  text?: string;
  combo?: string;
  /** 滚动距离（像素），正为向下。 */
  dy_px?: number;
  dx_px?: number;
  /** drag 目标点（归一化）。 */
  to_norm?: [number, number];
  /** wait 动作的毫秒数。 */
  wait_ms?: number;
  /** 强制使用某个 locator type（调试用）。 */
  force_locator?: string;
  /** 覆盖默认 click 选项。 */
  modifiers?: ReadonlyArray<"ctrl" | "shift" | "alt" | "meta">;
  click_count?: number;
  /** type 动作时是否先 Cmd+A → Delete 清空当前输入。 */
  clear_first?: boolean;
  /** type 动作的逐字延迟（毫秒）；0 或未设走粘贴。 */
  per_char_delay_ms?: number;
}

export interface ActionContext {
  action_id: string;
  state: State;
  control: Control;
  actionType: ActionType;
  params: ActionParams;
  risk_level: RiskLevel;
  approval_required: boolean;
}

export interface ActionResult {
  action_id: string;
  succeeded: boolean;
  locator: LocatorMatch | null;
  state_before?: StateMatch | null;
  state_after?: StateMatch | null;
  postcondition_ok: boolean;
  repaired: boolean;
  patches: Patch[];
  events: TraceEventBase[];
  message?: string;
}

export interface WorkflowResult {
  workflow_id: string;
  succeeded: boolean;
  steps: Array<{
    action_id: string;
    succeeded: boolean;
    message?: string;
  }>;
}

