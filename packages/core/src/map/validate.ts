import { findAction, parseActionId } from "./lookup.js";
import type { VisionMap } from "../schema/index.js";

export interface ValidationIssue {
  severity: "error" | "warning";
  path: string;
  message: string;
}

/**
 * 结构性校验（zod 已经保证字段类型），这里做语义校验：
 *   - state/region/control id 唯一性
 *   - state.inherit_regions 引用合法 region
 *   - region/state 之间 id 不冲突（避免 action_id 解析歧义）
 *   - collection 必须有 enumeration
 *   - transition 引用合法 state
 *   - workflow.steps 中的 action_id 能解析到真实 control
 *   - 高风险控件必须设置 approval_required
 */
export function lintMap(map: VisionMap): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const stateIds = new Set<string>();
  const regionIds = new Set<string>();

  // 1. regions
  for (let i = 0; i < (map.regions ?? []).length; i++) {
    const r = map.regions[i];
    if (regionIds.has(r.id)) {
      issues.push({ severity: "error", path: `regions[${i}]`, message: `重复 region id: ${r.id}` });
    }
    regionIds.add(r.id);
    const ctrlIds = new Set<string>();
    for (let j = 0; j < r.controls.length; j++) {
      const c = r.controls[j];
      if (ctrlIds.has(c.id)) {
        issues.push({
          severity: "error",
          path: `regions[${i}].controls[${j}]`,
          message: `region ${r.id} 中重复 control id: ${c.id}`,
        });
      }
      ctrlIds.add(c.id);
      checkControl(issues, `regions[${i}].controls[${j}]`, c, r.id, map);
    }
  }

  // 2. states
  for (let i = 0; i < map.states.length; i++) {
    const s = map.states[i];
    if (stateIds.has(s.id)) {
      issues.push({ severity: "error", path: `states[${i}]`, message: `重复 state id: ${s.id}` });
    }
    if (regionIds.has(s.id)) {
      issues.push({
        severity: "error",
        path: `states[${i}]`,
        message: `state id "${s.id}" 与 region 同名；会导致 action_id 解析歧义`,
      });
    }
    stateIds.add(s.id);
    for (const rid of s.inherit_regions ?? []) {
      if (!regionIds.has(rid)) {
        issues.push({
          severity: "error",
          path: `states[${i}].inherit_regions`,
          message: `state ${s.id} 引用了不存在的 region: ${rid}`,
        });
      }
    }
    const ctrlIds = new Set<string>();
    for (let j = 0; j < s.controls.length; j++) {
      const c = s.controls[j];
      if (ctrlIds.has(c.id)) {
        issues.push({
          severity: "error",
          path: `states[${i}].controls[${j}]`,
          message: `state ${s.id} 中重复 control id: ${c.id}`,
        });
      }
      ctrlIds.add(c.id);
      checkControl(issues, `states[${i}].controls[${j}]`, c, s.id, map);
    }
  }

  // 3. transitions
  for (let i = 0; i < map.transitions.length; i++) {
    const t = map.transitions[i];
    if (!stateIds.has(t.from)) {
      issues.push({
        severity: "error",
        path: `transitions[${i}].from`,
        message: `transition ${i}: from state "${t.from}" 不存在`,
      });
    }
    if (!stateIds.has(t.to)) {
      issues.push({
        severity: "warning",
        path: `transitions[${i}].to`,
        message: `transition ${i}: to state "${t.to}" 不存在`,
      });
    }
  }

  // 4. workflows
  for (let i = 0; i < map.workflows.length; i++) {
    const w = map.workflows[i];
    for (let j = 0; j < w.steps.length; j++) {
      const step = w.steps[j];
      try {
        // 直接试解析 + 找 control；不存在的话 findAction 会 throw
        parseActionId(step.action_id);
        findAction(map, step.action_id);
      } catch (err) {
        issues.push({
          severity: "error",
          path: `workflows[${i}].steps[${j}].action_id`,
          message: `workflow "${w.id}" 步骤 ${j}: ${(err as Error).message}`,
        });
      }
    }
  }
  return issues;
}

function checkControl(
  issues: ValidationIssue[],
  path: string,
  c: import("../schema/index.js").Control,
  ownerId: string,
  map: VisionMap,
): void {
  const needsApproval = map.safety_policy.require_approval_for_risk_levels.includes(
    c.risk_level as "requires_confirmation" | "destructive",
  );
  if (needsApproval && !c.approval_required) {
    issues.push({
      severity: "warning",
      path,
      message: `控件 ${ownerId}.${c.id} risk_level=${c.risk_level} 但未设置 approval_required=true`,
    });
  }
  if (c.locator_priority.length === 0) {
    issues.push({
      severity: "error",
      path: `${path}.locator_priority`,
      message: `控件 ${ownerId}.${c.id} 缺少 locator`,
    });
  }
  if (c.kind === "collection" && !c.enumeration) {
    issues.push({
      severity: "error",
      path,
      message: `控件 ${ownerId}.${c.id} kind=collection 但缺少 enumeration 配置`,
    });
  }
  if (c.kind !== "collection" && c.enumeration) {
    issues.push({
      severity: "warning",
      path,
      message: `控件 ${ownerId}.${c.id} 有 enumeration 但 kind=${c.kind}（应改为 collection 才生效）`,
    });
  }
}

export function hasErrors(issues: ValidationIssue[]): boolean {
  return issues.some((i) => i.severity === "error");
}

export function formatIssues(issues: ValidationIssue[]): string {
  return issues
    .map((i) => `[${i.severity.toUpperCase()}] ${i.path}: ${i.message}`)
    .join("\n");
}
