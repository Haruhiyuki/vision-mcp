// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Vision-MCP Authors
import type {
  Capsule,
} from "../capsule/manager.js";
import type { Workflow } from "../schema/index.js";
import { MapBuilder } from "./builder.js";

export interface RecordedStep {
  action_id: string;
  params?: Record<string, unknown>;
  approval_required?: boolean;
  notes?: string;
}

/**
 * Recorder：人类演示阶段使用。它不会真正接管用户的鼠标键盘，只是观察 Capsule 的事件与
 * agent 调用 perform_action 的历史，把它们转写成 workflow。
 *
 * 用法：
 *   const rec = new WorkflowRecorder({ id: "create_invoice" });
 *   rec.observeAction("invoice.customer_name", { text: "{{customer_name}}" });
 *   rec.observeAction("invoice.amount", { text: "{{amount}}" });
 *   rec.observeAction("invoice.submit", undefined, { approval_required: true });
 *   builder.addWorkflow(rec.build());
 */
export class WorkflowRecorder {
  private readonly steps: RecordedStep[] = [];
  constructor(
    private readonly meta: {
      id: string;
      description?: string;
      inputs?: Workflow["inputs"];
    },
  ) {}

  observeAction(
    actionId: string,
    params?: Record<string, unknown>,
    opts: { approval_required?: boolean; notes?: string } = {},
  ): this {
    this.steps.push({
      action_id: actionId,
      params,
      approval_required: opts.approval_required,
      notes: opts.notes,
    });
    return this;
  }

  build(): Workflow {
    return {
      id: this.meta.id,
      description: this.meta.description,
      inputs: this.meta.inputs ?? [],
      steps: this.steps.map((s) => ({
        action_id: s.action_id,
        params: s.params,
        approval_required: s.approval_required ?? false,
        on_failure: "abort",
        notes: s.notes,
      })),
      timeout_ms: 120_000,
    };
  }
}

/**
 * 从 capsule 事件流自动推断 transitions（attach → state_detected → action → state_detected）。
 * 当前实现是骨架：调用方提供 builder 与 detect 函数，recorder 拼装 transitions。
 */
export class TransitionRecorder {
  private fromState: string | null = null;
  constructor(private readonly builder: MapBuilder) {}

  enterState(stateId: string) {
    this.fromState = stateId;
  }

  observeAction(actionId: string, newState: string) {
    if (this.fromState && newState && this.fromState !== newState) {
      this.builder.addTransition({
        from: this.fromState,
        action_id: actionId,
        to: newState,
      });
    }
    this.fromState = newState;
  }
}
