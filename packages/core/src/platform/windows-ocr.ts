import type { Frame, RectPx } from "../capsule/types.js";
import type { OcrProvider, OcrToken } from "../locator/types.js";
import type { WindowsPlatformAdapter } from "./windows.js";

interface RawToken {
  text: string;
  confidence: number;
  bbox_norm: [number, number, number, number];
}

/**
 * Windows.Media.Ocr OCR provider，走 helper 的 ocr.recognize_rect RPC。
 *
 * 等价 macOS 的 DarwinOcrProvider；接口对齐让 click-text / scroll-until-text /
 * postcondition.ocr_present 跨平台同代码路径。
 *
 * 实测性能（PS 5.1 + Win11 26100）：
 *   - 首次 RPC: ~1s（含 WinRT 类型懒加载）
 *   - warm 400×200: ~120ms（含 GDI 截图 + PNG 编码 + OCR）
 *   - warm 1200×600: ~170ms（约 160 词）
 *
 * 限制：
 *   - 需要安装对应语言包（设置 → 时间和语言 → 添加语言）；中文需"中文（简体，中国）"
 *     + 勾选"基本输入"/"光学字符识别"
 *   - 单边 ≤ 10000px（API 限制）
 *   - 不返回 per-word confidence（统一 1.0；macOS Vision framework 给真置信度）
 */
export class WindowsOcrProvider implements OcrProvider {
  private cache = new Map<string, { ts: number; tokens: OcrToken[] }>();
  private readonly ttlMs: number;

  constructor(
    private readonly adapter: WindowsPlatformAdapter,
    options: { cache_ttl_ms?: number } = {},
  ) {
    this.ttlMs = options.cache_ttl_ms ?? 1500;
  }

  invalidate(): void {
    this.cache.clear();
  }

  async recognize(_frame: Frame): Promise<OcrToken[]> {
    // recognize() 不带屏幕坐标；调用方应优先用 recognizeRect()，与 darwin-ocr 同语义
    return [];
  }

  async recognizeRect(
    screenRect: RectPx,
    options: { languages?: string[]; nocache?: boolean } = {},
  ): Promise<OcrToken[]> {
    const key = `screen:${screenRect.x},${screenRect.y},${screenRect.width},${screenRect.height}`;
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

  /** 列出系统装的 OCR 语言包，给 doctor 命令展示。 */
  async languages(): Promise<Array<{ tag: string; display: string }>> {
    const r = await this.adapter.helperRequest<Array<{ tag: string; display: string }> | { tag: string; display: string }>(
      "ocr.languages",
      {},
      10_000,
    );
    return Array.isArray(r) ? r : r ? [r] : [];
  }
}
