import type { BBoxNorm } from "../schema/index.js";
import type { Frame } from "../capsule/types.js";

/**
 * VlmProvider 接口（重新定义，比 locator/types.ts 中已有的 VlmProvider 更通用）。
 *
 * vision-mcp 用 VLM 做两件事：
 *   1. relocate(frame, prompt, hint)：在当前 frame 中找一个控件，返回 bbox + confidence
 *      （locator type "vlm" 用这个）
 *   2. ask(frame, prompt)：自由问答，例如"这是什么页面？列出所有按钮"
 *      （discover / builder 用这个）
 *
 * 实现：
 *   - ClaudeVlmProvider：走 Anthropic messages API（带 image content block）
 *   - ScriptedVlmProvider：测试用，按 prompt 查表返回
 */
export interface VlmRelocateResult {
  bbox_norm: BBoxNorm;
  confidence: number;
  reasoning?: string;
  cost_usd?: number;
  tokens_in?: number;
  tokens_out?: number;
}

export interface VlmAskResult {
  text: string;
  cost_usd?: number;
  tokens_in?: number;
  tokens_out?: number;
  cache_hit?: boolean;
}

export interface VlmProvider {
  relocate(
    frame: Frame,
    prompt: string,
    hint?: BBoxNorm,
  ): Promise<VlmRelocateResult | null>;

  /**
   * 自由问答：返回 VLM 看图后的回答文本。
   * 调用方负责解析（例如要求 JSON 输出后 JSON.parse）。
   */
  ask(frame: Frame, prompt: string): Promise<VlmAskResult>;

  /** 累计统计：tokens / 费用（用于 P4 监控）。 */
  stats?(): {
    total_calls: number;
    total_tokens_in: number;
    total_tokens_out: number;
    total_cost_usd: number;
    cache_hits: number;
  };
}
