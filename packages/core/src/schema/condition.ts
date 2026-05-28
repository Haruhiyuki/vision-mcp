// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Vision-MCP Authors
import { z } from "zod";

/**
 * Postcondition / precondition 描述。校验失败应当走 repair ladder。
 * 设计参考：§10.3 / §11.2 / §12。
 */
const StateShouldBe = z.object({
  type: z.literal("state_should_be"),
  state_id: z.string(),
});

const TextShouldAppear = z.object({
  type: z.literal("text_should_appear"),
  text: z.string(),
  timeout_ms: z.number().int().positive().default(3000),
  match: z.enum(["exact", "contains", "regex"]).default("contains"),
});

const TextShouldDisappear = z.object({
  type: z.literal("text_should_disappear"),
  text: z.string(),
  timeout_ms: z.number().int().positive().default(3000),
});

const WindowTitleShouldMatch = z.object({
  type: z.literal("window_title_should_match"),
  pattern: z.string(),
});

const ModalShouldClose = z.object({
  type: z.literal("modal_should_close"),
  modal_id: z.string().optional(),
  timeout_ms: z.number().int().positive().default(3000),
});

const ControlShouldExist = z.object({
  type: z.literal("control_should_exist"),
  control_id: z.string(),
});

const ControlShouldNotExist = z.object({
  type: z.literal("control_should_not_exist"),
  control_id: z.string(),
});

const VisualSimilarShouldBe = z.object({
  type: z.literal("visual_similar_should_be"),
  state_id: z.string(),
  min_similarity: z.number().min(0).max(1).default(0.82),
});

/**
 * click 前后局部区域的 dHash 应有显著差异。比 visual_similar_should_be 强：
 * 不需要预定义 baseline state，只对比"动作前后"。
 *
 * 用法：postcondition: { type: visual_diff_should_be, region_norm: [...], max_similarity: 0.85 }
 *   - 在 action 前 capsule.capture 取 region 子图 → 算 dHash A
 *   - 在 action 后 capsule.capture 取同 region → 算 dHash B
 *   - 若 similarity(A, B) <= max_similarity 视为变化已发生 → ok
 *
 * 解决"workflow succeeded 但底部没换歌"这类幽灵 bug。
 */
const VisualDiffShouldBe = z.object({
  type: z.literal("visual_diff_should_be"),
  region_norm: z
    .tuple([
      z.number().min(0).max(1.5),
      z.number().min(0).max(1.5),
      z.number().min(0).max(1.5),
      z.number().min(0).max(1.5),
    ])
    .optional()
    .describe("可选；不填则取整个 client rect 比对"),
  max_similarity: z.number().min(0).max(1).default(0.85),
  timeout_ms: z.number().int().positive().default(3000),
});

/**
 * 明确依赖 OCR provider 的 text 出现校验。
 * text_should_appear 在历史上既匹配 OCR 也匹配 AX 名字，语义模糊；
 * ocr_should_appear 显式表达"我要 OCR 这帧并找文字"，配合 visual-first 流程。
 */
const OcrShouldAppear = z.object({
  type: z.literal("ocr_should_appear"),
  text: z.string(),
  match: z.enum(["exact", "contains", "regex"]).default("contains"),
  min_confidence: z.number().min(0).max(1).default(0.6),
  region_norm: z
    .tuple([
      z.number().min(0).max(1.5),
      z.number().min(0).max(1.5),
      z.number().min(0).max(1.5),
      z.number().min(0).max(1.5),
    ])
    .optional()
    .describe("可选限定 OCR 搜索区域，比全屏 OCR 快 5-10x"),
  timeout_ms: z.number().int().positive().default(4000),
});

export const ConditionAtom = z.discriminatedUnion("type", [
  StateShouldBe,
  TextShouldAppear,
  TextShouldDisappear,
  WindowTitleShouldMatch,
  ModalShouldClose,
  ControlShouldExist,
  ControlShouldNotExist,
  VisualSimilarShouldBe,
  VisualDiffShouldBe,
  OcrShouldAppear,
]);

export type ConditionAtom = z.infer<typeof ConditionAtom>;

export const ConditionGroup = z
  .object({
    all: z.array(ConditionAtom).optional(),
    any: z.array(ConditionAtom).optional(),
    not: ConditionAtom.optional(),
  })
  .refine(
    (v) =>
      [v.all, v.any, v.not].filter((x) => x !== undefined).length >= 1,
    { message: "ConditionGroup 至少要有 all/any/not 其一" },
  );

export type ConditionGroup = z.infer<typeof ConditionGroup>;

/**
 * 顶层 Condition：允许是单个 atom（最常见的 state_should_be / text_should_appear），
 * 也可以是组合（all/any/not）。
 */
export const Condition = z.union([ConditionAtom, ConditionGroup]);
export type Condition = z.infer<typeof Condition>;
