// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Vision-MCP Authors
import { z } from "zod";
import { ActionType, BBoxNorm, RiskLevel } from "./primitives.js";
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
  /**
   * kind 默认 "control"（单一可操作元素）。kind="collection" 描述一组同质元素
   * （网格/列表/横向滚动条），通过 action_id `<owner>.<id>[i]` 寻址第 i 个 cell。
   * 加这一层抽象前 map 经常出现 result_card_1_1..2_4 这种 8 倍重复。
   */
  kind: z.enum(["control", "collection"]).default("control"),
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
  /**
   * 仅 kind="collection" 时使用：描述如何枚举一组同质 cell。
   * 每个 cell 共享 action_types / locator_priority 模板，但 bbox 按 enumeration 推算。
   */
  enumeration: z
    .object({
      layout: z.enum(["grid", "row", "column"]).default("grid"),
      /** grid 排布时 rows × cols；row/column 时只用 count 字段。 */
      rows: z.number().int().positive().optional(),
      cols: z.number().int().positive().optional(),
      count: z.number().int().positive().optional(),
      /** 第一个 cell 的 bbox。后续 cell 按 spacing 平移。 */
      cell_bbox_norm: BBoxNorm,
      /** 相邻 cell 中心间距（norm）。 */
      spacing_x: z.number().min(0).max(1).default(0),
      spacing_y: z.number().min(0).max(1).default(0),
    })
    .optional(),
});

export type Control = z.infer<typeof Control>;
export const ControlId = ControlIdSchema;
