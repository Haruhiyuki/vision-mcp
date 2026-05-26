import { z } from "zod";

/**
 * 归一化坐标。原点在 capsule client rect 左上角，xy 为左上、wh 为尺寸；范围 [0,1]。
 * 不允许出现负值，避免把屏幕坐标错误地塞进 map。
 */
export const BBoxNorm = z
  .tuple([
    z.number().min(0).max(1.5),
    z.number().min(0).max(1.5),
    z.number().min(0).max(1.5),
    z.number().min(0).max(1.5),
  ])
  .describe("[x, y, w, h] 归一化坐标，相对 capsule client rect");

export type BBoxNorm = z.infer<typeof BBoxNorm>;

export const PointNorm = z
  .tuple([z.number().min(0).max(1.5), z.number().min(0).max(1.5)])
  .describe("[x, y] 归一化坐标点");

export type PointNorm = z.infer<typeof PointNorm>;

export const Platform = z.enum(["windows", "macos", "any"]);
export type Platform = z.infer<typeof Platform>;

export const CoordinateSpace = z.enum([
  "normalized_client_rect",
  "normalized_window_rect",
  "normalized_display_rect",
]);
export type CoordinateSpace = z.infer<typeof CoordinateSpace>;

export const CapsuleMode = z.enum([
  "same_session_virtual_display",
  "real_window",
  "existing_display",
  "third_party_virtual_display",
]);
export type CapsuleMode = z.infer<typeof CapsuleMode>;

export const RiskLevel = z.enum([
  "safe",
  "requires_confirmation",
  "destructive",
]);
export type RiskLevel = z.infer<typeof RiskLevel>;

export const ActionType = z.enum([
  "click",
  "double_click",
  "right_click",
  "hover",
  "type",
  "key",
  "scroll",
  "drag",
  "drop",
  "wait",
  "noop",
]);
export type ActionType = z.infer<typeof ActionType>;
