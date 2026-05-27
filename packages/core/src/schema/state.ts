import { z } from "zod";
import { Control } from "./control.js";

const StateAnchor = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("ocr_text"),
    text: z.string(),
    min_confidence: z.number().min(0).max(1).default(0.85),
    match: z.enum(["exact", "contains", "regex"]).default("contains"),
  }),
  z.object({
    type: z.literal("accessibility"),
    role: z.string().optional(),
    name: z.string().optional(),
    name_regex: z.string().optional(),
    description: z.string().optional(),
    description_regex: z.string().optional(),
    automation_id: z.string().optional(),
  }),
  z.object({
    type: z.literal("window_title"),
    pattern: z.string(),
  }),
  z.object({
    type: z.literal("visual_hash"),
    hash: z.string(),
    min_similarity: z.number().min(0).max(1).default(0.82),
  }),
]);

export type StateAnchor = z.infer<typeof StateAnchor>;

export const State = z.object({
  id: z
    .string()
    .min(1)
    .regex(
      /^[a-zA-Z0-9_][a-zA-Z0-9_.\-]*$/,
      "state id 只能包含字母数字下划线点和连字符",
    ),
  description: z.string().optional(),
  kind: z
    .enum(["page", "modal", "menu", "tooltip", "dialog", "system_modal"])
    .default("page"),
  anchors: z
    .array(StateAnchor)
    .min(1)
    .describe("状态识别锚点；任一锚点命中即可，但应优先多锚点全命中"),
  match_policy: z.enum(["any_anchor", "all_anchors", "score"]).default("any_anchor"),
  controls: z.array(Control).default([]),
  /**
   * 引用顶层 regions[] 中的 id；该 state 上额外可见的"全局区域 controls"。
   * runtime 解析 action_id 找 control 时会先查 state.controls，再依次查 inherit_regions。
   */
  inherit_regions: z.array(z.string()).default([]),
  parent_state_id: z.string().optional(),
  variants: z.array(z.string()).default([]),
  notes: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export type State = z.infer<typeof State>;

export const Transition = z.object({
  from: z.string(),
  action_id: z.string().describe("形如 state_id.control_id，或 workflow 内自定义 id"),
  to: z.string(),
  verify: z
    .array(
      z.discriminatedUnion("type", [
        z.object({
          type: z.literal("text_appears"),
          text: z.string(),
          timeout_ms: z.number().int().positive().default(3000),
        }),
        z.object({
          type: z.literal("state_should_be"),
          state_id: z.string(),
        }),
        z.object({
          type: z.literal("window_title_should_match"),
          pattern: z.string(),
        }),
      ]),
    )
    .default([]),
  notes: z.string().optional(),
});

export type Transition = z.infer<typeof Transition>;
