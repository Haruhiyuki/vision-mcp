// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Vision-MCP Authors
import type {
  Condition,
  ConditionAtom,
  ConditionGroup,
  State,
  VisionMap,
} from "../schema/index.js";
import { matchText } from "../locator/text.js";
import type { FrameInsights, LocatorMatch, StateMatch } from "../locator/types.js";

export interface ConditionContext {
  map: VisionMap;
  state_match: StateMatch | null;
  insights: FrameInsights;
  /** capsule.attach 取得的窗口 title，用于 window_title_should_match。 */
  window_title?: string;
  recent_controls?: LocatorMatch[];
  /** 动作前的 frame visual_hash；visual_diff_should_be 用。 */
  baseline_visual_hash?: string;
}

export async function evaluateCondition(
  cond: Condition,
  ctx: ConditionContext,
): Promise<{ ok: boolean; reasons: string[] }> {
  if (isGroup(cond)) {
    const reasons: string[] = [];
    if (cond.all) {
      for (const c of cond.all) {
        const r = await evaluateAtom(c, ctx);
        if (!r.ok) return { ok: false, reasons: [...reasons, r.reason] };
        reasons.push(r.reason);
      }
      return { ok: true, reasons };
    }
    if (cond.any) {
      const allReasons: string[] = [];
      for (const c of cond.any) {
        const r = await evaluateAtom(c, ctx);
        if (r.ok) return { ok: true, reasons: [r.reason] };
        allReasons.push(r.reason);
      }
      return { ok: false, reasons: allReasons };
    }
    if (cond.not) {
      const r = await evaluateAtom(cond.not, ctx);
      return { ok: !r.ok, reasons: [`not(${r.reason})`] };
    }
    return { ok: true, reasons: ["empty condition group"] };
  }
  const r = await evaluateAtom(cond, ctx);
  return { ok: r.ok, reasons: [r.reason] };
}

async function evaluateAtom(
  atom: ConditionAtom,
  ctx: ConditionContext,
): Promise<{ ok: boolean; reason: string }> {
  switch (atom.type) {
    case "state_should_be":
      return {
        ok: ctx.state_match?.state_id === atom.state_id,
        reason: `state_should_be=${atom.state_id} actual=${ctx.state_match?.state_id ?? "unknown"}`,
      };
    case "text_should_appear": {
      const r = matchText(ctx.insights.ocr, {
        text: atom.text,
        match: atom.match,
        min_confidence: 0.7,
      });
      return {
        ok: !!r,
        reason: `text_should_appear="${atom.text}" → ${r ? "found" : "not found"}`,
      };
    }
    case "text_should_disappear": {
      // 用 atom.min_confidence 而不是写死 0.6 — schema 暴露了字段就应该尊重用户的阈值
      // 默认 0.6 是 disappear 的合理保守值：低置信度的残留也算"还在"，更严谨
      const r = matchText(ctx.insights.ocr, {
        text: atom.text,
        match: "contains",
        min_confidence: (atom as { min_confidence?: number }).min_confidence ?? 0.6,
      });
      return {
        ok: !r,
        reason: `text_should_disappear="${atom.text}" → ${r ? "still present" : "gone"}`,
      };
    }
    case "window_title_should_match": {
      const title = ctx.window_title ?? "";
      const re = new RegExp(atom.pattern);
      return {
        ok: re.test(title),
        reason: `window_title=${title} match /${atom.pattern}/`,
      };
    }
    case "modal_should_close": {
      const state = ctx.state_match?.state_id;
      const isModal = ctx.map.states.find(
        (s) => s.id === state && (s.kind === "modal" || s.kind === "dialog" || s.kind === "system_modal"),
      );
      return {
        ok: !isModal,
        reason: `modal_should_close → ${isModal ? "still showing" : "closed"}`,
      };
    }
    case "control_should_exist": {
      const found = ctx.recent_controls?.some((c) => c.control_id === atom.control_id);
      return {
        ok: !!found,
        reason: `control_should_exist=${atom.control_id} → ${found ? "yes" : "no"}`,
      };
    }
    case "control_should_not_exist": {
      const found = ctx.recent_controls?.some((c) => c.control_id === atom.control_id);
      return {
        ok: !found,
        reason: `control_should_not_exist=${atom.control_id} → ${found ? "still" : "ok"}`,
      };
    }
    case "visual_similar_should_be": {
      const target = ctx.map.states.find((s) => s.id === atom.state_id);
      if (!target) {
        return { ok: false, reason: `visual_similar target state ${atom.state_id} not in map` };
      }
      const anchor = target.anchors.find((a) => a.type === "visual_hash");
      if (!anchor || anchor.type !== "visual_hash") {
        return { ok: false, reason: `target state ${atom.state_id} 缺少 visual_hash anchor` };
      }
      if (!ctx.insights.visual_hash) {
        return { ok: false, reason: "current frame 缺少 visual_hash" };
      }
      const dist = hamming(ctx.insights.visual_hash, anchor.hash);
      const similarity = 1 - dist / 64;
      return {
        ok: similarity >= (atom.min_similarity ?? 0.82),
        reason: `visual_similarity=${similarity.toFixed(3)} (≥${atom.min_similarity})`,
      };
    }
    case "visual_diff_should_be": {
      // 由 waitForCondition 调用方负责取"动作前 baseline frame"。这里只判断当前
      // visual_hash 与 ctx.baseline_visual_hash 的差异是否超过阈值。
      const baseline = ctx.baseline_visual_hash;
      if (!baseline || !ctx.insights.visual_hash) {
        return { ok: false, reason: "visual_diff: baseline 或当前 hash 缺失" };
      }
      const sim = 1 - hamming(baseline, ctx.insights.visual_hash) / 64;
      return {
        ok: sim <= atom.max_similarity,
        reason: `visual_diff similarity=${sim.toFixed(3)} (≤${atom.max_similarity}=变化)`,
      };
    }
    case "ocr_should_appear": {
      // ocr_should_appear 与 text_should_appear 实现一致；语义差异在 schema 文档
      const r = matchText(ctx.insights.ocr, {
        text: atom.text,
        match: atom.match,
        min_confidence: atom.min_confidence,
      });
      return {
        ok: !!r,
        reason: `ocr_should_appear="${atom.text}" → ${r ? `found(conf=${r.confidence.toFixed(2)})` : "not found"}`,
      };
    }
  }
}

function isGroup(c: Condition): c is ConditionGroup {
  return (
    typeof c === "object" &&
    c !== null &&
    (("all" in c) || ("any" in c) || ("not" in c)) &&
    !("type" in c)
  );
}

function hamming(a: string, b: string): number {
  if (a.length !== b.length) return 64;
  let x = BigInt("0x" + a) ^ BigInt("0x" + b);
  let count = 0;
  while (x > 0n) {
    if (x & 1n) count++;
    x >>= 1n;
  }
  return count;
}

/**
 * Condition 评估需要的数据类型集合。
 *
 * 按"信号 → AX/UIA → OCR → 视觉"成本递增排序：
 *   needsWindowTitle  ~5ms   信号（window.get RPC）
 *   needsVisualHash   ~60ms  capture frame + dHash
 *   needsAx           ~200ms（CEF/Chrome 可能 1s+）
 *   needsOcr          ~200ms（限定 client_rect 较快）
 *   needsState        最贵   capture + OCR + AX + visual_hash 综合
 *
 * waitForCondition 用这个决定 refresh 收集什么——能用信号验出来就不付视觉成本。
 */
export interface ConditionDataKinds {
  needsWindowTitle: boolean;
  needsVisualHash: boolean;
  needsOcr: boolean;
  needsAx: boolean;
  needsState: boolean;
  needsControls: boolean;
}

/**
 * 推断 condition 整棵树需要的数据类型。`any` / `all` / `not` 都展开看每个 atom。
 *
 * 关键：state_should_be / modal_should_close 这种基于 detect_state 的 condition 触发全收集
 * （AX + OCR + visual_hash），因为 detect_state 是综合判定。
 */
export function getConditionDataRequirements(cond: Condition): ConditionDataKinds {
  const reqs: ConditionDataKinds = {
    needsWindowTitle: false,
    needsVisualHash: false,
    needsOcr: false,
    needsAx: false,
    needsState: false,
    needsControls: false,
  };
  function visit(c: Condition) {
    if (isGroup(c)) {
      if (c.all) c.all.forEach(visit);
      if (c.any) c.any.forEach(visit);
      if (c.not) visit(c.not);
      return;
    }
    switch (c.type) {
      case "window_title_should_match":
        reqs.needsWindowTitle = true; break;
      case "text_should_appear":
      case "text_should_disappear":
      case "ocr_should_appear":
        reqs.needsOcr = true; break;
      case "visual_similar_should_be":
      case "visual_diff_should_be":
        reqs.needsVisualHash = true; break;
      case "state_should_be":
      case "modal_should_close":
        reqs.needsState = true; break;
      case "control_should_exist":
      case "control_should_not_exist":
        reqs.needsControls = true; break;
    }
  }
  visit(cond);
  // detect_state 需要综合 OCR + AX + visual_hash
  if (reqs.needsState) {
    reqs.needsAx = true;
    reqs.needsOcr = true;
    reqs.needsVisualHash = true;
  }
  return reqs;
}

/**
 * 等待某个 postcondition 在 timeout 内变为 true。
 *
 * refresh 函数接收 ConditionDataKinds 参数——按需收集数据，不必每轮都做全套 capture+AX+OCR。
 * 比如用户只配 window_title_should_match，refresh 只需调 capsule.status 拿 window title，
 * 整轮 ~5ms，不付视觉成本。
 *
 * `any: [...]` 复合 condition 会按顺序短路求值（evaluateCondition 内实现）。这意味着用户
 * 可以配 `any: [信号 cond, OCR cond, 视觉 cond]` 表达"前面过就不验后面"。
 */
export async function waitForCondition(
  cond: Condition,
  refresh: (reqs: ConditionDataKinds) => Promise<ConditionContext>,
  options: { timeout_ms?: number; polling_ms?: number } = {},
): Promise<{ ok: boolean; reasons: string[]; iterations: number }> {
  const timeout = options.timeout_ms ?? 15000;
  const polling = options.polling_ms ?? 250;
  const reqs = getConditionDataRequirements(cond);
  const start = Date.now();
  let iterations = 0;
  let last: { ok: boolean; reasons: string[] } = { ok: false, reasons: [] };
  // 保证至少跑一次完整 refresh — 即便 refresh 比 timeout 还慢（例如 AX dump 数十秒），
  // 也应给条件一次评估机会，否则永远超时。
  do {
    iterations++;
    const ctx = await refresh(reqs);
    last = await evaluateCondition(cond, ctx);
    if (last.ok) return { ...last, iterations };
    if (Date.now() - start >= timeout) break;
    await sleep(polling);
  } while (Date.now() - start < timeout);
  return { ...last, iterations };
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}
