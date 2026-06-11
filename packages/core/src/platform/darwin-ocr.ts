// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Vision-MCP Authors
import type { Frame, RectPx } from "../capsule/types.js";
import type { OcrProvider, OcrToken } from "../locator/types.js";
import type { DarwinHelperAdapter } from "./darwin-helper.js";

interface RawToken {
  text: string;
  confidence: number;
  bbox_norm: [number, number, number, number];
}

/**
 * macOS Vision Framework OCR provider，走 swift helper 的 ocr.recognize_rect 方法。
 *
 * 关键差异 vs 通用 OcrProvider：
 *   - 接口 `recognize(frame)` 不知道 frame 在屏幕上的位置 → 默认对整个 client_rect OCR。
 *   - 但 vision-mcp 真正想要的常常是"对 attached_window 当前可见区域 OCR"，
 *     这时调用 `recognizeRect(rectScreen, clientRectPxForNormalization)` 直接拿屏幕 rect。
 *
 * 性能：1280×800 区域全 OCR ~200-400ms（accurate 路径，中英混合）。
 */
export class DarwinOcrProvider implements OcrProvider {
  private cache = new Map<string, { ts: number; tokens: OcrToken[] }>();
  private readonly ttlMs: number;

  constructor(
    private readonly adapter: DarwinHelperAdapter,
    options: { cache_ttl_ms?: number } = {},
  ) {
    this.ttlMs = options.cache_ttl_ms ?? 1500;
  }

  invalidate(): void {
    this.cache.clear();
  }

  async recognize(_frame: Frame): Promise<OcrToken[]> {
    // recognize() 不带屏幕坐标，无法精确告诉 helper 区域；调用方应优先用 recognizeRect()。
    // RuntimeExecutor.detectState 改造为：判断 provider 是 DarwinOcrProvider 时直接调
    // recognizeRect(client_rect_px)，因此本方法保留空实现作 fallback。
    return [];
  }

  /**
   * OCR 整个窗口（SCKit 抓窗口帧 → Vision），与 WindowsOcrProvider.recognizeWindow 对齐。
   * 不依赖屏幕可见性：被遮挡 / 不在前台的窗口也能 OCR，且不必 raise 抢焦点。
   * regionNorm 可选 [nx, ny, nw, nh] 在窗口帧内裁剪（如只裁客户区），
   * bbox 归一化到 regionNorm（若提供）或整个窗口帧。
   * 老 helper 无 ocr.recognize_window 方法时此调用会抛错——调用方 fallback recognizeRect。
   */
  async recognizeWindow(
    windowHandle: string,
    options: {
      regionNorm?: [number, number, number, number];
      languages?: string[];
      nocache?: boolean;
    } = {},
  ): Promise<OcrToken[]> {
    const region = options.regionNorm ? options.regionNorm.join(",") : "full";
    const key = `window:${windowHandle}:${region}:${(options.languages ?? []).join("+")}`;
    if (!options.nocache) {
      const hit = this.cache.get(key);
      if (hit && Date.now() - hit.ts < this.ttlMs) return hit.tokens;
    }
    const r = await this.adapter.helperRequest<{ tokens: RawToken[]; via?: string }>(
      "ocr.recognize_window",
      {
        handle: windowHandle,
        region_norm: options.regionNorm,
        languages: options.languages ?? [],
      },
      20_000,
    );
    const tokens: OcrToken[] = (r.tokens ?? []).map((t) => ({
      text: t.text,
      confidence: t.confidence,
      bbox_norm: t.bbox_norm,
    }));
    if (!options.nocache) {
      this.cache.set(key, { ts: Date.now(), tokens });
    }
    return tokens;
  }

  /**
   * 对指定屏幕矩形 OCR，bbox 归一化到该矩形内部。
   * 适合 click_text / nearby_text / OCR-grounded postcondition。
   */
  async recognizeRect(
    screenRect: RectPx,
    options: { languages?: string[]; nocache?: boolean } = {},
  ): Promise<OcrToken[]> {
    const key = `screen:${screenRect.x},${screenRect.y},${screenRect.width},${screenRect.height}:${(options.languages ?? []).join("+")}`;
    if (!options.nocache) {
      const hit = this.cache.get(key);
      if (hit && Date.now() - hit.ts < this.ttlMs) return hit.tokens;
    }
    const r = await this.adapter.helperRequest<{ tokens: RawToken[] }>(
      "ocr.recognize_rect",
      {
        rect: {
          x: screenRect.x,
          y: screenRect.y,
          width: screenRect.width,
          height: screenRect.height,
        },
        languages: options.languages ?? [],
      },
      20_000,
    );
    const tokens: OcrToken[] = (r.tokens ?? []).map((t) => ({
      text: t.text,
      confidence: t.confidence,
      bbox_norm: t.bbox_norm,
    }));
    if (!options.nocache) {
      this.cache.set(key, { ts: Date.now(), tokens });
    }
    return tokens;
  }
}
