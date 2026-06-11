// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Vision-MCP Authors
import { z } from "zod";
import { CapsuleMode, CoordinateSpace, Platform } from "./primitives.js";

export const GeometryContract = z.object({
  width_px: z.number().int().positive(),
  height_px: z.number().int().positive(),
  scale: z.number().positive().default(1.0),
  dpi_x: z.number().int().positive().default(96),
  dpi_y: z.number().int().positive().default(96),
  refresh_rate_hz: z.number().int().positive().default(60),
});

export type GeometryContract = z.infer<typeof GeometryContract>;

export const TargetWindow = z.object({
  process_name: z.string().optional(),
  title_regex: z.string().optional(),
  class_name: z.string().optional(),
  bundle_id: z.string().optional().describe("macOS bundle id"),
});

export type TargetWindow = z.infer<typeof TargetWindow>;

export const ContractRules = z
  .object({
    require_same_display: z.boolean().default(true),
    require_client_size_px: z
      .tuple([z.number().int().positive(), z.number().int().positive()])
      .optional(),
    tolerate_client_size_delta_px: z.number().int().nonnegative().default(2),
    /**
     * 尺寸差在 (tolerate, warn] 区间记 warning 不记 violation——
     * macOS 菜单栏/标题栏挤压会造成 ~23px 的无害差异，不该每次都报错。
     * 超过 warn 阈值才视为真 drift（violation，触发 repair）。
     */
    warn_client_size_delta_px: z.number().int().nonnegative().default(40),
    require_unminimized: z.boolean().default(true),
    require_foreground_for_input: z.boolean().default(true),
    validate_before_each_action: z.boolean().default(true),
  })
  .default({});

export type ContractRules = z.infer<typeof ContractRules>;

export const VisualBox = z.object({
  id: z.string().min(1),
  mode: CapsuleMode,
  platform: Platform.default("any"),
  display: GeometryContract,
  target_window: TargetWindow.optional(),
  coordinate_space: CoordinateSpace.default("normalized_client_rect"),
  contract: ContractRules,
  /**
   * 当主 contract 不满足时，按顺序尝试 fallback。
   * 例如：先尝试 same_session_virtual_display，失败降级到 real_window。
   */
  fallbacks: z.array(CapsuleMode).default([]),
});

export type VisualBox = z.infer<typeof VisualBox>;
