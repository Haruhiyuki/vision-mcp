// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Vision-MCP Authors
import { z } from "zod";

export const RepairPolicy = z
  .object({
    max_auto_repair_level: z.number().int().min(0).max(6).default(3),
    geometry: z
      .object({
        tolerate_client_size_delta_px: z.number().int().nonnegative().default(2),
        tolerate_origin_change: z.boolean().default(true),
        require_same_dpi: z.boolean().default(true),
      })
      .default({}),
    state: z
      .object({
        min_anchor_score: z.number().min(0).max(1).default(0.86),
        min_ocr_similarity: z.number().min(0).max(1).default(0.88),
        min_visual_similarity: z.number().min(0).max(1).default(0.82),
      })
      .default({}),
    control_relocation: z
      .object({
        confidence_threshold: z.number().min(0).max(1).default(0.92),
        max_bbox_shift_norm: z.number().min(0).max(1).default(0.08),
      })
      .default({}),
    destructive_actions: z
      .object({
        auto_repair_before_action: z.boolean().default(false),
        require_user_confirmation: z.boolean().default(true),
      })
      .default({}),
  })
  .default({});

export type RepairPolicy = z.infer<typeof RepairPolicy>;

export const SafetyPolicy = z
  .object({
    /**
     * 这些动作类别默认不允许自动执行，必须人类批准。
     * 设计文档 §15.3 列出的默认禁止动作。
     */
    forbidden_action_categories: z
      .array(z.string())
      .default([
        "payment",
        "destructive",
        "external_communication",
        "permission_change",
        "captcha",
      ]),
    /**
     * 任意 control 的 risk_level >= requires_confirmation 时，runtime 必须先取得批准。
     */
    require_approval_for_risk_levels: z
      .array(z.enum(["requires_confirmation", "destructive"]))
      .default(["requires_confirmation", "destructive"]),
    /**
     * 截图/OCR/输入字段脱敏正则。匹配片段会被替换为 ***。
     */
    redaction_patterns: z.array(z.string()).default([]),
    allow_cloud_vlm: z.boolean().default(false),
    audit_log_retention_days: z.number().int().nonnegative().default(30),
  })
  .default({});

export type SafetyPolicy = z.infer<typeof SafetyPolicy>;

export const InputLeasePolicy = z
  .object({
    default_lease_ms: z.number().int().positive().default(5000),
    break_on_user_input: z.boolean().default(true),
    break_hotkey: z.string().default("Esc Esc"),
    require_revalidate_after_break: z.boolean().default(true),
  })
  .default({});

export type InputLeasePolicy = z.infer<typeof InputLeasePolicy>;
