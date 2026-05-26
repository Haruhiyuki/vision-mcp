import type {
  BBoxNorm,
  Control,
  Locator,
  State,
  StateAnchor,
} from "../schema/index.js";
import type { Frame, RectPx } from "../capsule/types.js";

export interface OcrToken {
  text: string;
  bbox_norm: BBoxNorm;
  confidence: number;
}

export interface AccessibilityNode {
  id: string;
  role?: string;
  name?: string;
  description?: string;
  automation_id?: string;
  class_name?: string;
  bbox_norm: BBoxNorm;
  enabled?: boolean;
  visible?: boolean;
  children?: AccessibilityNode[];
}

export interface FrameInsights {
  frame: Frame;
  ocr: OcrToken[];
  accessibility: AccessibilityNode[];
  /** 64-bit perceptual hash 字符串，用于 visual similarity。 */
  visual_hash?: string;
  /** 来自 capsule.status() 的窗口标题，用于 window_title anchor。 */
  window_title?: string;
}

export interface OcrProvider {
  recognize(frame: Frame): Promise<OcrToken[]>;
}

export interface AccessibilityProvider {
  /**
   * 返回当前窗口的 accessibility 树。坐标应已归一化到 frame 的 client rect。
   */
  snapshot(windowHandle: string): Promise<AccessibilityNode[]>;
  /**
   * 失效内部缓存。Runtime 在每次 dispatch 完成后调用，确保 postcondition / 下一次
   * locator 解析看到新页面而不是上一次 click 前的 AX。
   */
  invalidate?(windowHandle?: string): void;
}

export interface VisualHashProvider {
  hash(frame: Frame): Promise<string>;
  similarity(a: string, b: string): number;
}

export interface PatchImageProvider {
  /**
   * 在 frame 中搜索给定 patch 图像，返回最高匹配位置与分数。
   * 没有命中时返回 null。
   */
  search(
    frame: Frame,
    patch: { file: string; min_similarity: number },
    baseDir: string,
  ): Promise<{ bbox_norm: BBoxNorm; similarity: number } | null>;
}

export interface VlmProvider {
  /**
   * 调用视觉语言模型重定位控件。需要 safety policy 允许 cloud_vlm。
   */
  relocate(
    frame: Frame,
    prompt: string,
    hint?: BBoxNorm,
  ): Promise<{ bbox_norm: BBoxNorm; confidence: number; cost_usd?: number } | null>;
}

export interface LocatorProviders {
  ocr?: OcrProvider;
  accessibility?: AccessibilityProvider;
  visualHash?: VisualHashProvider;
  patchImage?: PatchImageProvider;
  vlm?: VlmProvider;
}

export interface LocatorMatch {
  control_id: string;
  bbox_norm: BBoxNorm;
  center_norm: [number, number];
  confidence: number;
  locator_used: Locator["type"];
  evidence?: string;
}

export interface StateMatch {
  state_id: string;
  score: number;
  matched_anchors: StateAnchor[];
}
