import type { BBoxNorm } from "../schema/index.js";
import type { GeometryState } from "../capsule/types.js";

export type TraceEventKind =
  | "session_started"
  | "session_ended"
  | "capsule_attached"
  | "capsule_migrated"
  | "capsule_released"
  | "state_detected"
  | "action_started"
  | "action_succeeded"
  | "action_failed"
  | "postcondition_failed"
  | "repair_attempted"
  | "repair_succeeded"
  | "repair_skipped"
  | "approval_requested"
  | "approval_granted"
  | "approval_denied"
  | "lease_acquired"
  | "lease_broken"
  | "user_takeover"
  | "warning"
  | "error";

export interface TraceEventBase {
  id: string;
  session_id: string;
  kind: TraceEventKind;
  ts: string;
  message: string;
  detail?: Record<string, unknown>;
  /** 屏幕截图 / patch 资产引用，用于 trace viewer。 */
  asset_refs?: string[];
  state_id?: string;
  action_id?: string;
  workflow_id?: string;
  control_id?: string;
  geometry?: Pick<GeometryState, "ok" | "violations">;
  /** 给定动作命中的归一化区域，便于 trace 中回放。 */
  bbox_norm?: BBoxNorm;
}

export interface TraceSession {
  id: string;
  started_at: string;
  ended_at?: string;
  app_id: string;
  visual_box_id: string;
  mode: string;
  status: "running" | "succeeded" | "failed" | "aborted";
  events_count: number;
}

export interface TraceQuery {
  sessionId?: string;
  kinds?: TraceEventKind[];
  limit?: number;
  since?: string;
}

export interface ApprovalRequest {
  id: string;
  session_id: string;
  state_id: string;
  control_id: string;
  action_id: string;
  risk_level: string;
  message: string;
  created_at: string;
  expires_at: string;
  context?: Record<string, unknown>;
}

export type ApprovalDecision = "granted" | "denied" | "expired";

export interface ApprovalResolver {
  request(req: ApprovalRequest): Promise<ApprovalDecision>;
}
