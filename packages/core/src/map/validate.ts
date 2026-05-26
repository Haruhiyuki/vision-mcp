import type { VisionMap } from "../schema/index.js";

export interface ValidationIssue {
  severity: "error" | "warning";
  path: string;
  message: string;
}

/**
 * 结构性校验（zod 已经保证字段类型），这里做语义校验：
 *   - state/control id 唯一性
 *   - transition 引用合法 state
 *   - workflow.steps 中的 action_id 对应到真实 control 或被 transition 覆盖
 *   - 高风险控件必须设置 approval_required（除非 safety_policy 显式豁免）
 */
export function lintMap(map: VisionMap): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const stateIds = new Set<string>();
  for (let i = 0; i < map.states.length; i++) {
    const s = map.states[i];
    if (stateIds.has(s.id)) {
      issues.push({
        severity: "error",
        path: `states[${i}]`,
        message: `重复 state id: ${s.id}`,
      });
    }
    stateIds.add(s.id);
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
      const needsApproval = map.safety_policy.require_approval_for_risk_levels.includes(
        c.risk_level as "requires_confirmation" | "destructive",
      );
      if (needsApproval && !c.approval_required) {
        issues.push({
          severity: "warning",
          path: `states[${i}].controls[${j}]`,
          message: `控件 ${s.id}.${c.id} risk_level=${c.risk_level} 但未设置 approval_required=true`,
        });
      }
      if (c.locator_priority.length === 0) {
        issues.push({
          severity: "error",
          path: `states[${i}].controls[${j}].locator_priority`,
          message: `控件 ${s.id}.${c.id} 缺少 locator`,
        });
      }
    }
  }
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
        message: `transition ${i}: to state "${t.to}" 不存在（动作执行后将进入未知 state）`,
      });
    }
  }
  for (let i = 0; i < map.workflows.length; i++) {
    const w = map.workflows[i];
    for (let j = 0; j < w.steps.length; j++) {
      const step = w.steps[j];
      const [head] = step.action_id.split(":", 1);
      const lastDot = head.lastIndexOf(".");
      if (lastDot < 0) {
        issues.push({
          severity: "warning",
          path: `workflows[${i}].steps[${j}].action_id`,
          message: `action_id "${step.action_id}" 不符合 state.control 形式`,
        });
        continue;
      }
      const sid = head.slice(0, lastDot);
      const cid = head.slice(lastDot + 1);
      const state = map.states.find((s) => s.id === sid);
      if (!state) {
        issues.push({
          severity: "error",
          path: `workflows[${i}].steps[${j}].action_id`,
          message: `workflow "${w.id}" 步骤 ${j} 引用了未知 state: ${sid}`,
        });
        continue;
      }
      const ctrl = state.controls.find((c) => c.id === cid);
      if (!ctrl) {
        issues.push({
          severity: "error",
          path: `workflows[${i}].steps[${j}].action_id`,
          message: `workflow "${w.id}" 步骤 ${j} 引用了未知 control: ${sid}.${cid}`,
        });
      }
    }
  }
  return issues;
}

export function hasErrors(issues: ValidationIssue[]): boolean {
  return issues.some((i) => i.severity === "error");
}

export function formatIssues(issues: ValidationIssue[]): string {
  return issues
    .map((i) => `[${i.severity.toUpperCase()}] ${i.path}: ${i.message}`)
    .join("\n");
}
