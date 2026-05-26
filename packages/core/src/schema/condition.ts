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

export const ConditionAtom = z.discriminatedUnion("type", [
  StateShouldBe,
  TextShouldAppear,
  TextShouldDisappear,
  WindowTitleShouldMatch,
  ModalShouldClose,
  ControlShouldExist,
  ControlShouldNotExist,
  VisualSimilarShouldBe,
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
