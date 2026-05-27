import { z } from "zod";
import { Platform } from "./primitives.js";
import { VisualBox } from "./capsule.js";
import { Region } from "./region.js";
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
  /**
   * 顶层 regions：跨 state 共享的 UI 区域（sidebar / toolbar / playbar / status_bar 等）。
   * state.inherit_regions 引用这些 id 来"装配"该 state 上的可用 controls。
   * 解决"sidebar 13 项在每个 state 都重复定义"的 map 膨胀问题。
   */
  regions: z.array(Region).default([]),
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
