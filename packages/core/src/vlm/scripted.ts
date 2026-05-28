// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Vision-MCP Authors
import type { Frame } from "../capsule/types.js";
import type { BBoxNorm } from "../schema/index.js";
import type { VlmAskResult, VlmProvider, VlmRelocateResult } from "./types.js";

/**
 * ScriptedVlmProvider：测试 / 离线模式。按 prompt 正则查表返回固定答案。
 * 不调任何外部 API，让 vision-mcp 在 CI 中也能演练 discover 的 VLM 路径。
 */
export class ScriptedVlmProvider implements VlmProvider {
  private calls = 0;
  constructor(
    private readonly rules: Array<{
      match: RegExp;
      ask?: (frame: Frame, prompt: string) => string;
      relocate?: (frame: Frame, prompt: string, hint?: BBoxNorm) => VlmRelocateResult | null;
    }> = [],
  ) {}

  async ask(frame: Frame, prompt: string): Promise<VlmAskResult> {
    this.calls++;
    for (const r of this.rules) {
      if (r.match.test(prompt) && r.ask) {
        return { text: r.ask(frame, prompt), cost_usd: 0, tokens_in: 0, tokens_out: 0 };
      }
    }
    return { text: "", cost_usd: 0, tokens_in: 0, tokens_out: 0 };
  }

  async relocate(
    frame: Frame,
    prompt: string,
    hint?: BBoxNorm,
  ): Promise<VlmRelocateResult | null> {
    this.calls++;
    for (const r of this.rules) {
      if (r.match.test(prompt) && r.relocate) {
        return r.relocate(frame, prompt, hint);
      }
    }
    return null;
  }

  stats() {
    return {
      total_calls: this.calls,
      total_tokens_in: 0,
      total_tokens_out: 0,
      total_cost_usd: 0,
      cache_hits: 0,
    };
  }
}
