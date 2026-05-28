// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Vision-MCP Authors
import type { BBoxNorm } from "../schema/index.js";
import type { OcrToken } from "./types.js";

/**
 * 简单的 token 串匹配：把多 token 顺序拼接，支持 exact/contains/regex。
 * 返回命中区域的合并 bbox 和综合置信度。
 */
export interface TextMatchOptions {
  text: string;
  match?: "exact" | "contains" | "regex";
  min_confidence?: number;
}

export interface TextMatchResult {
  bbox_norm: BBoxNorm;
  confidence: number;
  tokens: OcrToken[];
}

export function matchText(
  tokens: OcrToken[],
  opts: TextMatchOptions,
): TextMatchResult | null {
  const minConf = opts.min_confidence ?? 0.7;
  const mode = opts.match ?? "contains";
  const filtered = tokens.filter((t) => t.confidence >= minConf);

  if (mode === "regex") {
    const re = new RegExp(opts.text);
    const hits = filtered.filter((t) => re.test(t.text));
    if (hits.length === 0) return null;
    return mergeTokens(hits);
  }

  const normalizedTarget = normalize(opts.text);
  // 先尝试单 token 命中
  for (const t of filtered) {
    if (compareToken(t.text, opts.text, mode)) {
      return mergeTokens([t]);
    }
  }
  // 尝试连续多 token 拼接
  for (let i = 0; i < filtered.length; i++) {
    let combined = normalize(filtered[i].text);
    let j = i;
    while (j < filtered.length && combined.length < normalizedTarget.length + 8) {
      if (compareNormalized(combined, normalizedTarget, mode)) {
        return mergeTokens(filtered.slice(i, j + 1));
      }
      j++;
      if (j < filtered.length) {
        combined += normalize(filtered[j].text);
      }
    }
    if (compareNormalized(combined, normalizedTarget, mode)) {
      return mergeTokens(filtered.slice(i, j + 1));
    }
  }
  return null;
}

function normalize(s: string): string {
  return s.replace(/\s+/g, "").toLowerCase();
}

function compareToken(
  candidate: string,
  target: string,
  mode: "exact" | "contains",
): boolean {
  const a = normalize(candidate);
  const b = normalize(target);
  return compareNormalized(a, b, mode);
}

function compareNormalized(
  a: string,
  b: string,
  mode: "exact" | "contains",
): boolean {
  return mode === "exact" ? a === b : a.includes(b);
}

function mergeTokens(tokens: OcrToken[]): TextMatchResult {
  const xs = tokens.map((t) => t.bbox_norm[0]);
  const ys = tokens.map((t) => t.bbox_norm[1]);
  const x2s = tokens.map((t) => t.bbox_norm[0] + t.bbox_norm[2]);
  const y2s = tokens.map((t) => t.bbox_norm[1] + t.bbox_norm[3]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  const w = Math.max(...x2s) - x;
  const h = Math.max(...y2s) - y;
  const confidence =
    tokens.reduce((acc, t) => acc + t.confidence, 0) / tokens.length;
  return {
    bbox_norm: [x, y, w, h],
    confidence,
    tokens,
  };
}

/**
 * 使用 token 与目标点的相对位置筛选，例如 "找到目标文本下方最近的输入框"。
 */
export function findNearby(
  tokens: OcrToken[],
  pivotBBox: BBoxNorm,
  direction: "left" | "right" | "above" | "below" | "any",
  maxDistanceNorm: number,
): OcrToken[] {
  const pivotCenter: [number, number] = [
    pivotBBox[0] + pivotBBox[2] / 2,
    pivotBBox[1] + pivotBBox[3] / 2,
  ];
  const result: { token: OcrToken; distance: number }[] = [];
  for (const t of tokens) {
    const c: [number, number] = [
      t.bbox_norm[0] + t.bbox_norm[2] / 2,
      t.bbox_norm[1] + t.bbox_norm[3] / 2,
    ];
    const dx = c[0] - pivotCenter[0];
    const dy = c[1] - pivotCenter[1];
    if (direction === "left" && dx >= 0) continue;
    if (direction === "right" && dx <= 0) continue;
    if (direction === "above" && dy >= 0) continue;
    if (direction === "below" && dy <= 0) continue;
    const dist = Math.hypot(dx, dy);
    if (dist > maxDistanceNorm) continue;
    result.push({ token: t, distance: dist });
  }
  return result.sort((a, b) => a.distance - b.distance).map((r) => r.token);
}
