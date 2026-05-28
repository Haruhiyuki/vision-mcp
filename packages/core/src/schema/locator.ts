// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Vision-MCP Authors
import { z } from "zod";
import { BBoxNorm } from "./primitives.js";

/**
 * 控件定位器。地图按 locator_priority 顺序逐个尝试，命中即停。
 * 设计参考：设计文档 §4 Locator 与 §10.3 control。
 */
export const AccessibilityLocator = z.object({
  type: z.literal("accessibility"),
  name: z.string().optional(),
  name_regex: z.string().optional(),
  /** 显式排除：node.name 等于此值时不算命中。 */
  name_not: z.string().optional(),
  role: z.string().optional(),
  automation_id: z.string().optional(),
  class_name: z.string().optional(),
  description: z.string().optional(),
  description_regex: z.string().optional(),
  /** 显式排除：node.description 等于此值时不算命中。 */
  description_not: z.string().optional(),
  index: z.number().int().nonnegative().optional(),
});

export const OcrTextLocator = z.object({
  type: z.literal("ocr_text"),
  text: z.string(),
  match: z.enum(["exact", "contains", "regex"]).default("contains"),
  min_confidence: z.number().min(0).max(1).default(0.8),
  search_region: BBoxNorm.optional(),
});

export const NearbyTextLocator = z.object({
  type: z.literal("nearby_text"),
  text: z.string(),
  direction: z
    .enum(["left", "right", "above", "below", "any"])
    .default("any"),
  max_distance_norm: z.number().min(0).max(1).default(0.2),
});

export const ImagePatchLocator = z.object({
  type: z.literal("image_patch"),
  file: z.string().describe("相对 map 根目录的 patch 图像路径"),
  hash: z.string().optional().describe("可选 dHash/pHash，用于快速预筛"),
  min_similarity: z.number().min(0).max(1).default(0.85),
});

export const BBoxNormLocator = z.object({
  type: z.literal("bbox_norm"),
  value: BBoxNorm,
});

export const VlmLocator = z.object({
  type: z.literal("vlm"),
  prompt: z.string(),
  hint_bbox_norm: BBoxNorm.optional(),
  cost_budget_usd: z.number().nonnegative().optional(),
});

/**
 * i18n / 跨语言友好：在指定 region（或全屏）内取第 N 个匹配 role 的 AX 节点。
 * 不依赖文字 → 同一套 map 在中/英/日 locale 下都工作。
 *
 * 例："sidebar 第 2 个 cell" → { type: 'ordinal_in_region', region_id: 'sidebar',
 *      role: 'AXCell', index: 1 }
 */
export const OrdinalInRegionLocator = z.object({
  type: z.literal("ordinal_in_region"),
  region_id: z.string().optional(),
  role: z.string().optional(),
  role_regex: z.string().optional(),
  index: z.number().int().nonnegative(),
  min_width_norm: z.number().min(0).max(1).default(0.01),
  min_height_norm: z.number().min(0).max(1).default(0.01),
});

export const Locator = z.discriminatedUnion("type", [
  AccessibilityLocator,
  OcrTextLocator,
  NearbyTextLocator,
  ImagePatchLocator,
  BBoxNormLocator,
  VlmLocator,
  OrdinalInRegionLocator,
]);

export type Locator = z.infer<typeof Locator>;
export type AccessibilityLocator = z.infer<typeof AccessibilityLocator>;
export type OcrTextLocator = z.infer<typeof OcrTextLocator>;
export type ImagePatchLocator = z.infer<typeof ImagePatchLocator>;
export type BBoxNormLocator = z.infer<typeof BBoxNormLocator>;
export type VlmLocator = z.infer<typeof VlmLocator>;
export type OrdinalInRegionLocator = z.infer<typeof OrdinalInRegionLocator>;
