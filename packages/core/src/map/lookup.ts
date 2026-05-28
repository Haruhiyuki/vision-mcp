import type {
  Control,
  Region,
  State,
  VisionMap,
  Workflow,
} from "../schema/index.js";
import { VisionMcpError } from "../errors.js";

/**
 * action_id 三种形式：
 *   1. `<state_id>.<control_id>[:action_type]`
 *      在 state 自有 controls 中查；找不到再依次查 state.inherit_regions 引用的 regions。
 *   2. `<region_id>.<control_id>[:action_type]`
 *      在该 region.controls 中查（region_id 与 state_id 必须不重名）。
 *   3. `<owner>.<collection_id>[i][:action_type]`
 *      owner 可以是 state 或 region；collection.kind === "collection"，按 enumeration 解第 i 个 cell。
 */
export interface ParsedActionId {
  ownerId: string;
  controlId: string;
  actionType?: string;
  index?: number;
}

export function parseActionId(actionId: string): ParsedActionId {
  const [head, actionType] = actionId.split(":", 2);
  // 提取 [N] 索引
  const idxMatch = head.match(/^(.+)\[(\d+)\]$/);
  const stripped = idxMatch ? idxMatch[1] : head;
  const index = idxMatch ? Number(idxMatch[2]) : undefined;
  const lastDot = stripped.lastIndexOf(".");
  if (lastDot <= 0) {
    throw new Error(
      `Invalid action_id "${actionId}"，应形如 "state_id.control_id" / "region.id.control" / "state.collection[N]"`,
    );
  }
  return {
    ownerId: stripped.slice(0, lastDot),
    controlId: stripped.slice(lastDot + 1),
    actionType,
    index,
  };
}

export function formatActionId(
  ownerId: string,
  controlId: string,
  opts: { actionType?: string; index?: number } = {},
): string {
  const base = `${ownerId}.${controlId}${opts.index !== undefined ? `[${opts.index}]` : ""}`;
  return opts.actionType ? `${base}:${opts.actionType}` : base;
}

export function findState(map: VisionMap, stateId: string): State | undefined {
  return map.states.find((s) => s.id === stateId);
}

export function findRegion(map: VisionMap, regionId: string): Region | undefined {
  return (map.regions ?? []).find((r) => r.id === regionId);
}

/**
 * 在 owner（state 或 region）的 controls 中找 control_id。
 * - 若 owner 是 state，找不到时依次查 inherit_regions。
 * - collection 也算 control（kind=collection），返回模板控件。
 */
export function findControl(
  map: VisionMap,
  ownerId: string,
  controlId: string,
):
  | { kind: "state"; state: State; control: Control }
  | { kind: "region"; region: Region; control: Control }
  | undefined {
  const state = findState(map, ownerId);
  if (state) {
    const own = state.controls.find((c) => c.id === controlId);
    if (own) return { kind: "state", state, control: own };
    for (const rid of state.inherit_regions ?? []) {
      const region = findRegion(map, rid);
      if (!region) continue;
      const hit = region.controls.find((c) => c.id === controlId);
      if (hit) return { kind: "region", region, control: hit };
    }
    return undefined;
  }
  const region = findRegion(map, ownerId);
  if (region) {
    const hit = region.controls.find((c) => c.id === controlId);
    if (hit) return { kind: "region", region, control: hit };
  }
  return undefined;
}

export interface ResolvedAction {
  state?: State;
  region?: Region;
  control: Control;
  /** 对 collection 而言是动态构造的 cell control（bbox 已按 index 算好）。 */
  effectiveControl: Control;
  actionType: string;
  index?: number;
}

export function findAction(map: VisionMap, actionId: string): ResolvedAction {
  const { ownerId, controlId, actionType, index } = parseActionId(actionId);
  const hit = findControl(map, ownerId, controlId);
  if (!hit) {
    // 抛 VisionMcpError 而非裸 Error → server 错误处理会自动加 ERROR_HINTS 提示
    throw new VisionMcpError(
      "ACTION_NOT_FOUND",
      `action_id "${actionId}" 未找到对应 control（owner=${ownerId}, control=${controlId}）`,
    );
  }
  const { control } = hit;
  const resolvedType = actionType ?? control.action_types[0];
  if (!control.action_types.includes(resolvedType as never)) {
    throw new VisionMcpError(
      "ACTION_NOT_FOUND",
      `控件 ${controlId} 不支持动作 ${resolvedType}（支持：${control.action_types.join(", ")}）`,
    );
  }
  let effective = control;
  if (control.kind === "collection") {
    if (index === undefined) {
      throw new Error(
        `collection "${controlId}" 必须用 ${controlId}[N] 形式 action_id 指定索引`,
      );
    }
    effective = materializeCollectionCell(control, index);
  }
  if (hit.kind === "state") {
    return { state: hit.state, control, effectiveControl: effective, actionType: resolvedType, index };
  }
  return { region: hit.region, control, effectiveControl: effective, actionType: resolvedType, index };
}

function materializeCollectionCell(template: Control, index: number): Control {
  const e = template.enumeration;
  if (!e) {
    throw new Error(`collection ${template.id} 缺少 enumeration 配置`);
  }
  let row = 0;
  let col = index;
  if (e.layout === "grid") {
    const cols = e.cols ?? 1;
    row = Math.floor(index / cols);
    col = index % cols;
  } else if (e.layout === "column") {
    row = index;
    col = 0;
  }
  const [bx, by, bw, bh] = e.cell_bbox_norm;
  const x = bx + col * (e.spacing_x ?? 0);
  const y = by + row * (e.spacing_y ?? 0);
  const cellBbox: [number, number, number, number] = [x, y, bw, bh];
  const cellId = `${template.id}[${index}]`;
  return {
    ...template,
    kind: "control",
    id: cellId,
    enumeration: undefined,
    visual: {
      bbox_norm: cellBbox,
      center_norm: [x + bw / 2, y + bh / 2],
    },
    locator_priority: [
      { type: "bbox_norm", value: cellBbox },
      ...template.locator_priority.filter((l) => l.type !== "bbox_norm"),
    ],
  } as Control;
}

export function findWorkflow(map: VisionMap, workflowId: string): Workflow | undefined {
  return map.workflows.find((w) => w.id === workflowId);
}

export function listActions(map: VisionMap, ownerId: string): string[] {
  const out: string[] = [];
  const state = findState(map, ownerId);
  if (state) {
    for (const c of state.controls) {
      addControlActions(out, ownerId, c);
    }
    for (const rid of state.inherit_regions ?? []) {
      const r = findRegion(map, rid);
      if (!r) continue;
      for (const c of r.controls) {
        addControlActions(out, rid, c);
      }
    }
    return [...new Set(out)];
  }
  const region = findRegion(map, ownerId);
  if (region) {
    for (const c of region.controls) {
      addControlActions(out, ownerId, c);
    }
  }
  return [...new Set(out)];
}

function addControlActions(out: string[], ownerId: string, control: Control): void {
  if (control.kind === "collection") {
    const e = control.enumeration;
    if (!e) return;
    const total = e.layout === "grid" ? (e.rows ?? 1) * (e.cols ?? 1) : (e.count ?? 1);
    // 只列出 [0] 作为代表，避免 listActions 爆炸
    out.push(formatActionId(ownerId, control.id, { index: 0 }));
    for (const at of control.action_types) {
      out.push(formatActionId(ownerId, control.id, { index: 0, actionType: at }));
    }
    out.push(`# ${ownerId}.${control.id}[0..${total - 1}]`);
    return;
  }
  out.push(formatActionId(ownerId, control.id));
  for (const at of control.action_types) {
    out.push(formatActionId(ownerId, control.id, { actionType: at }));
  }
}
