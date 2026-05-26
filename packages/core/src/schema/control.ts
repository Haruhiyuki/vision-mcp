import { z } from "zod";
import { ActionType, RiskLevel } from "./primitives.js";
import { Locator } from "./locator.js";
import { Condition } from "./condition.js";
import { VisualHint } from "./visual.js";

const ControlIdSchema = z
  .string()
  .min(1)
  .regex(
    /^[a-zA-Z0-9_][a-zA-Z0-9_.\-]*$/,
    "control id 只能包含字母数字下划线点和连字符，且不能以分隔符开头",
  );

export const Control = z.object({
  id: ControlIdSchema,
  role: z
    .string()
    .describe(
      "button | textbox | combobox | list_item | menu_item | tab | link | image | container 等",
    ),
  label: z.string().optional(),
  description: z.string().optional(),
  action_types: z
    .array(ActionType)
    .min(1)
    .describe("控件支持的动作类型；首项为默认动作"),
  locator_priority: z
    .array(Locator)
    .min(1)
    .describe("从结构化到坐标兜底的多 locator 列表，按优先级排序"),
  visual: VisualHint.optional(),
  precondition: Condition.optional(),
  postcondition: Condition.optional(),
  risk_level: RiskLevel.default("safe"),
  approval_required: z.boolean().default(false),
  notes: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export type Control = z.infer<typeof Control>;
export const ControlId = ControlIdSchema;
