import { z } from "zod";
import { BBoxNorm, PointNorm } from "./primitives.js";

export const VisualHint = z.object({
  bbox_norm: BBoxNorm.optional(),
  center_norm: PointNorm.optional(),
  patch_file: z
    .string()
    .optional()
    .describe("控件局部截图路径，相对 map 根目录"),
  patch_hash: z.string().optional(),
});

export type VisualHint = z.infer<typeof VisualHint>;
