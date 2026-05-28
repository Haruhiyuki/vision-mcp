// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Vision-MCP Authors
import { z } from "zod";
import { Condition } from "./condition.js";

export const WorkflowInput = z.object({
  name: z.string().min(1),
  type: z.enum(["string", "number", "boolean", "secret"]).default("string"),
  required: z.boolean().default(true),
  default: z.unknown().optional(),
  description: z.string().optional(),
});

export type WorkflowInput = z.infer<typeof WorkflowInput>;

export const WorkflowStep = z.object({
  action_id: z.string().min(1),
  params: z.record(z.unknown()).optional(),
  approval_required: z.boolean().default(false),
  retry: z
    .object({
      max_attempts: z.number().int().min(1).max(5).default(2),
      delay_ms: z.number().int().nonnegative().default(500),
    })
    .optional(),
  on_failure: z
    .enum(["abort", "skip", "repair", "ask_user"])
    .default("repair"),
  /**
   * Step-level postcondition 覆盖 control.postcondition。runtime 在执行这一步时优先
   * 用 step.postcondition；没有就 fallback 到 control.postcondition。
   *
   * 典型场景：harvest_session 沉淀 workflow 时自动给每个 step 加
   * `{ type: state_should_be, state_id: <next_state_id> }`，让 workflow 复用时
   * 真做视觉/AX 验证而非只看 input RPC ok。
   */
  postcondition: Condition.optional(),
  notes: z.string().optional(),
});

export type WorkflowStep = z.infer<typeof WorkflowStep>;

export const Workflow = z.object({
  id: z.string().min(1).regex(/^[a-zA-Z0-9_][a-zA-Z0-9_.\-]*$/),
  description: z.string().optional(),
  inputs: z.array(WorkflowInput).default([]),
  steps: z.array(WorkflowStep).min(1),
  timeout_ms: z.number().int().positive().default(120_000),
  notes: z.string().optional(),
});

export type Workflow = z.infer<typeof Workflow>;
