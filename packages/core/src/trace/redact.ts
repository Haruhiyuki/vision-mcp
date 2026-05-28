// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Vision-MCP Authors
/**
 * 字符串脱敏：按 safety_policy.redaction_patterns 把命中片段替换为 ***。
 * 用于在 trace、approval 请求和日志中保护敏感字段。
 */
export function redactString(text: string, patterns: string[]): string {
  let out = text;
  for (const p of patterns) {
    try {
      const re = new RegExp(p, "g");
      out = out.replace(re, "***");
    } catch {
      // 非法 regex 静默跳过；trace 不应因脱敏失败而中断
    }
  }
  return out;
}

export function redactObject<T>(value: T, patterns: string[]): T {
  if (patterns.length === 0) return value;
  return JSON.parse(
    redactString(JSON.stringify(value), patterns),
  ) as T;
}
