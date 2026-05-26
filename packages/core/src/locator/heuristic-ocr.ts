import type { Frame } from "../capsule/types.js";
import type { OcrProvider, OcrToken } from "./types.js";

/**
 * 启发式 OCR 提供者。它本身不识别文字，而是从外部注入的 "ground truth" 中按 frame
 * 时间戳/hash 查找对应 tokens。用途：
 *   - 单元测试 / mock 运行：构造已知 token 列表。
 *   - native helper 已经做完 OCR 时，把结果挂到 frame，再用本提供者透传。
 *
 * 生产环境应换成基于 Tesseract / PaddleOCR / Apple Vision / Windows OCR 的实现。
 */
export class StaticOcrProvider implements OcrProvider {
  private store = new Map<string, OcrToken[]>();

  set(frameKey: string, tokens: OcrToken[]): void {
    this.store.set(frameKey, tokens);
  }

  async recognize(frame: Frame): Promise<OcrToken[]> {
    return this.store.get(keyOf(frame)) ?? [];
  }
}

export function keyOf(frame: Frame): string {
  return `${frame.source}:${frame.width_px}x${frame.height_px}:${frame.captured_at}`;
}

/**
 * 把一组 tokens 包装成 frame-key 与时间无关的 provider，方便测试。
 */
export class FixedOcrProvider implements OcrProvider {
  constructor(private readonly tokens: OcrToken[]) {}
  async recognize(_frame: Frame): Promise<OcrToken[]> {
    return [...this.tokens];
  }
}
