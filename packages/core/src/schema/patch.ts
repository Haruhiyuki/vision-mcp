// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Vision-MCP Authors
import { z } from "zod";
import { BBoxNorm } from "./primitives.js";
import { Control } from "./control.js";
import { State } from "./state.js";

const PatchTrust = z.enum(["session_only", "trusted", "untrusted_proposal"]);
export type PatchTrust = z.infer<typeof PatchTrust>;

const PatchBase = z.object({
  id: z.string().min(1),
  trust: PatchTrust.default("session_only"),
  created_at: z.string().datetime().optional(),
  created_by: z.string().optional(),
  reason: z.string().optional(),
  confidence: z.number().min(0).max(1).default(1),
  requires_review: z.boolean().default(false),
  expires_at: z.string().datetime().optional(),
});

export const GeometryProfilePatch = PatchBase.extend({
  kind: z.literal("geometry_profile"),
  visual_box_id: z.string(),
  display: z.object({
    width_px: z.number().int().positive(),
    height_px: z.number().int().positive(),
    scale: z.number().positive().optional(),
    dpi_x: z.number().int().positive().optional(),
    dpi_y: z.number().int().positive().optional(),
  }),
});

export const ControlBBoxPatch = PatchBase.extend({
  kind: z.literal("control_bbox"),
  state_id: z.string(),
  control_id: z.string(),
  old_bbox_norm: BBoxNorm.optional(),
  new_bbox_norm: BBoxNorm,
  method: z.string().describe("relocation 方法描述，例如 ocr_text + nearby_text"),
});

export const ControlLocatorPatch = PatchBase.extend({
  kind: z.literal("control_locator"),
  state_id: z.string(),
  control_id: z.string(),
  /** 部分覆盖：仅替换/追加给定字段。如果未给出，则保留原 control。 */
  partial: Control.partial(),
});

export const StatePatch = PatchBase.extend({
  kind: z.literal("state"),
  state: State,
  operation: z.enum(["add", "replace", "remove"]).default("add"),
});

/**
 * 往现有 state（或 region）加新 control。
 *
 * 与 ControlLocatorPatch 区分：
 *   - ControlLocatorPatch：state 里已有此 control_id → 修字段
 *   - ControlAddPatch：state 里没有此 control_id → 新增；已存在则忽略（幂等）
 *
 * 设计动机：agent 探索新页面时发现 baseline state 缺一个可交互元素，
 * 应该走 patch 渐进沉淀（trust=session_only → 验证后升级 trusted），
 * 而不是 commit_state 整覆盖（会丢手编 control 的 risk_level / locator 等）。
 */
export const ControlAddPatch = PatchBase.extend({
  kind: z.literal("control_add"),
  state_id: z.string().describe("state.id 或 region.id；后者支持往共享 region 加 control"),
  control: Control,
});

export const Patch = z.discriminatedUnion("kind", [
  GeometryProfilePatch,
  ControlBBoxPatch,
  ControlLocatorPatch,
  StatePatch,
  ControlAddPatch,
]);

export type Patch = z.infer<typeof Patch>;
export type GeometryProfilePatch = z.infer<typeof GeometryProfilePatch>;
export type ControlBBoxPatch = z.infer<typeof ControlBBoxPatch>;
export type ControlLocatorPatch = z.infer<typeof ControlLocatorPatch>;
export type StatePatch = z.infer<typeof StatePatch>;
export type ControlAddPatch = z.infer<typeof ControlAddPatch>;
