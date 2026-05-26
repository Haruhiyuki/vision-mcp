import { z } from "zod";
import { Platform } from "./primitives.js";
import { VisualBox } from "./capsule.js";
import { State, Transition } from "./state.js";
import { Workflow } from "./workflow.js";
import { InputLeasePolicy, RepairPolicy, SafetyPolicy } from "./policy.js";

export const AppDescriptor = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[a-zA-Z0-9_][a-zA-Z0-9_.\-]*$/, "app id 必须是合法 slug"),
  name: z.string().min(1),
  platform: Platform,
  build: z.string().optional(),
  launch_hint: z
    .enum(["attach_after_launch", "launch_then_attach", "auto_launch"])
    .default("attach_after_launch"),
  description: z.string().optional(),
});

export type AppDescriptor = z.infer<typeof AppDescriptor>;

export const VisionMap = z.object({
  version: z.string().default("0.1"),
  app: AppDescriptor,
  visual_box: VisualBox,
  states: z.array(State).default([]),
  transitions: z.array(Transition).default([]),
  workflows: z.array(Workflow).default([]),
  repair_policy: RepairPolicy,
  safety_policy: SafetyPolicy,
  input_lease_policy: InputLeasePolicy,
  metadata: z
    .object({
      created_at: z.string().datetime().optional(),
      created_by: z.string().optional(),
      tags: z.array(z.string()).default([]),
      notes: z.string().optional(),
      builder_version: z.string().optional(),
    })
    .default({}),
});

export type VisionMap = z.infer<typeof VisionMap>;
