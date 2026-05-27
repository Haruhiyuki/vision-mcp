import type { Frame } from "../capsule/types.js";
import type { BBoxNorm } from "../schema/index.js";
import { encodeRgbaToPng } from "../runtime/png.js";
import type { VlmAskResult, VlmProvider, VlmRelocateResult } from "./types.js";

/**
 * ClaudeVlmProvider：调 Anthropic messages API（带 image content block）。
 *
 * 仅在 `safety_policy.allow_cloud_vlm = true` 时该调用方应被允许。
 * 使用方负责：
 *   - 设置 ANTHROPIC_API_KEY 环境变量
 *   - 选择合适的 model（默认 claude-opus-4-7，按 Claude 知识截止日期 2026-01）
 *
 * 配合 P4 cache：相同 visual_hash + prompt 命中时跳过实际 API。
 */
export interface ClaudeVlmOptions {
  apiKey?: string;            // 默认从 ANTHROPIC_API_KEY 读
  model?: string;             // 默认 claude-opus-4-7
  api_base?: string;          // 默认 https://api.anthropic.com/v1
  max_tokens?: number;        // 默认 1024
  enable_cache?: boolean;     // 默认 true
}

interface CacheEntry {
  visual_hash: string;
  prompt: string;
  result: VlmAskResult;
  ts: number;
}

export class ClaudeVlmProvider implements VlmProvider {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly api_base: string;
  private readonly max_tokens: number;
  private readonly enable_cache: boolean;
  private cache = new Map<string, CacheEntry>();
  private stats_total_calls = 0;
  private stats_total_in = 0;
  private stats_total_out = 0;
  private stats_total_cost = 0;
  private stats_cache_hits = 0;

  constructor(opts: ClaudeVlmOptions = {}) {
    this.apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY ?? "";
    this.model = opts.model ?? "claude-opus-4-7";
    this.api_base = opts.api_base ?? "https://api.anthropic.com/v1";
    this.max_tokens = opts.max_tokens ?? 1024;
    this.enable_cache = opts.enable_cache ?? true;
    if (!this.apiKey) {
      throw new Error(
        "ClaudeVlmProvider 需要 ANTHROPIC_API_KEY（环境变量或 opts.apiKey）",
      );
    }
  }

  async ask(frame: Frame, prompt: string): Promise<VlmAskResult> {
    const cacheKey = await frameCacheKey(frame, prompt);
    if (this.enable_cache && this.cache.has(cacheKey)) {
      this.stats_cache_hits++;
      const e = this.cache.get(cacheKey)!;
      return { ...e.result, cache_hit: true };
    }
    const png = encodeRgbaToPng(frame.width_px, frame.height_px, frame.pixels);
    const body = {
      model: this.model,
      max_tokens: this.max_tokens,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: png.toString("base64"),
              },
            },
            { type: "text", text: prompt },
          ],
        },
      ],
    };
    const resp = await fetch(`${this.api_base}/messages`, {
      method: "POST",
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const txt = await resp.text();
      throw new Error(`Claude vision API ${resp.status}: ${txt.slice(0, 300)}`);
    }
    const json: any = await resp.json();
    const text = (json.content ?? [])
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("");
    const tokens_in = json.usage?.input_tokens ?? 0;
    const tokens_out = json.usage?.output_tokens ?? 0;
    // 粗略价格估算：opus 4 输入 $15 / 1M tokens，输出 $75 / 1M。后续可按 model 切换。
    const cost = (tokens_in / 1_000_000) * 15 + (tokens_out / 1_000_000) * 75;
    this.stats_total_calls++;
    this.stats_total_in += tokens_in;
    this.stats_total_out += tokens_out;
    this.stats_total_cost += cost;
    const result: VlmAskResult = {
      text,
      cost_usd: cost,
      tokens_in,
      tokens_out,
      cache_hit: false,
    };
    if (this.enable_cache) {
      this.cache.set(cacheKey, { visual_hash: cacheKey.split("|")[0], prompt, result, ts: Date.now() });
    }
    return result;
  }

  async relocate(
    frame: Frame,
    prompt: string,
    hint?: BBoxNorm,
  ): Promise<VlmRelocateResult | null> {
    const wrappedPrompt = [
      "You are a UI grounding model. Look at the screenshot and find the element described below.",
      `Description: ${prompt}`,
      hint ? `Hint bbox (normalized): ${JSON.stringify(hint)}` : "",
      "",
      "Respond with a single JSON object on one line:",
      `{"bbox_norm": [x, y, w, h], "confidence": <0..1>, "reasoning": "..."}`,
      "x,y,w,h are all normalized to [0,1] relative to the image. Do not wrap in markdown.",
    ].filter(Boolean).join("\n");
    const r = await this.ask(frame, wrappedPrompt);
    let parsed: any;
    try {
      // Try to find a JSON object in the response
      const m = r.text.match(/\{[\s\S]*\}/);
      parsed = m ? JSON.parse(m[0]) : null;
    } catch {
      parsed = null;
    }
    if (!parsed || !Array.isArray(parsed.bbox_norm) || parsed.bbox_norm.length !== 4) {
      return null;
    }
    return {
      bbox_norm: parsed.bbox_norm as BBoxNorm,
      confidence: Number(parsed.confidence ?? 0.5),
      reasoning: parsed.reasoning,
      cost_usd: r.cost_usd,
      tokens_in: r.tokens_in,
      tokens_out: r.tokens_out,
    };
  }

  stats() {
    return {
      total_calls: this.stats_total_calls,
      total_tokens_in: this.stats_total_in,
      total_tokens_out: this.stats_total_out,
      total_cost_usd: this.stats_total_cost,
      cache_hits: this.stats_cache_hits,
    };
  }
}

async function frameCacheKey(frame: Frame, prompt: string): Promise<string> {
  // 简短 visual_hash：用 dHash 9x8 同算法的紧凑版
  const { DHashProvider } = await import("../locator/visual-hash.js");
  const hasher = new DHashProvider();
  const h = await hasher.hash(frame);
  return `${h}|${prompt}`;
}
