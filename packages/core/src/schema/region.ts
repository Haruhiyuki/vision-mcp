// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Vision-MCP Authors
import { z } from "zod";
import { BBoxNorm } from "./primitives.js";
import { Control } from "./control.js";

const RegionIdSchema = z
  .string()
  .min(1)
  .regex(
    /^[a-zA-Z0-9_][a-zA-Z0-9_.\-]*$/,
    "region id 只能包含字母数字下划线点和连字符",
  );

/**
 * Region：跨多个 state 共享的 UI 区域（如 sidebar / toolbar / playbar）。
 *
 * 设计动机：实测 Apple Music 时发现 sidebar 13 项 + 底部播放栏 9 项在每个 state
 * 都要重复声明，map 膨胀且改动易遗漏。引入 Region 后：
 *   - 顶层 regions: [sidebar, playbar]
 *   - 各 state inherit_regions: ["sidebar", "playbar"]
 *   - region 内 control 的 action_id 形式：`<region_id>.<control_id>[:action_type]`
 *
 * runtime perform_action 查 control 顺序：
 *   1. 解析 action_id 拆出第一段
 *   2. 若匹配 region_id → 在该 region.controls 查
 *   3. 否则当成 state_id → 先查 state.controls，再查 state.inherit_regions 引用的 regions
 *
 * bbox_norm 可选；填上后可让 detect_state 用 region 命中验证 capsule 布局未变。
 */
export const Region = z.object({
  id: RegionIdSchema,
  description: z.string().optional(),
  bbox_norm: BBoxNorm.optional(),
  controls: z.array(Control).default([]),
  notes: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export type Region = z.infer<typeof Region>;
export const RegionId = RegionIdSchema;
