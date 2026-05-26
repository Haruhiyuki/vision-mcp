import type {
  Control,
  State,
  VisionMap,
  Workflow,
} from "../schema/index.js";

/**
 * action_id 约定：
 *   - "<state_id>.<control_id>"：在 state 上执行 control 默认动作。
 *   - "<state_id>.<control_id>:<action_type>"：指定动作类型（click/type/...）。
 */
export interface ParsedActionId {
  stateId: string;
  controlId: string;
  actionType?: string;
}

export function parseActionId(actionId: string): ParsedActionId {
  const [head, actionType] = actionId.split(":", 2);
  const lastDot = head.lastIndexOf(".");
  if (lastDot <= 0) {
    throw new Error(
      `Invalid action_id "${actionId}"，应形如 "state_id.control_id" 或 "state_id.control_id:click"`,
    );
  }
  return {
    stateId: head.slice(0, lastDot),
    controlId: head.slice(lastDot + 1),
    actionType,
  };
}

export function formatActionId(
  stateId: string,
  controlId: string,
  actionType?: string,
): string {
  const base = `${stateId}.${controlId}`;
  return actionType ? `${base}:${actionType}` : base;
}

export function findState(
  map: VisionMap,
  stateId: string,
): State | undefined {
  return map.states.find((s) => s.id === stateId);
}

export function findControl(
  map: VisionMap,
  stateId: string,
  controlId: string,
): { state: State; control: Control } | undefined {
  const state = findState(map, stateId);
  if (!state) return undefined;
  const control = state.controls.find((c) => c.id === controlId);
  if (!control) return undefined;
  return { state, control };
}

export function findAction(
  map: VisionMap,
  actionId: string,
): { state: State; control: Control; actionType: string } {
  const { stateId, controlId, actionType } = parseActionId(actionId);
  const hit = findControl(map, stateId, controlId);
  if (!hit) {
    throw new Error(
      `action_id "${actionId}" 未找到对应的 state.control（${stateId}.${controlId}）`,
    );
  }
  const resolved = actionType ?? hit.control.action_types[0];
  if (!hit.control.action_types.includes(resolved as never)) {
    throw new Error(
      `控件 ${controlId} 不支持动作 ${resolved}（支持：${hit.control.action_types.join(", ")}）`,
    );
  }
  return { state: hit.state, control: hit.control, actionType: resolved };
}

export function findWorkflow(
  map: VisionMap,
  workflowId: string,
): Workflow | undefined {
  return map.workflows.find((w) => w.id === workflowId);
}

export function listActions(
  map: VisionMap,
  stateId: string,
): string[] {
  const state = findState(map, stateId);
  if (!state) return [];
  const out: string[] = [];
  for (const c of state.controls) {
    out.push(formatActionId(stateId, c.id));
    for (const at of c.action_types) {
      out.push(formatActionId(stateId, c.id, at));
    }
  }
  return [...new Set(out)];
}
