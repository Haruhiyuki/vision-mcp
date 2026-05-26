import { z } from "zod";

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
