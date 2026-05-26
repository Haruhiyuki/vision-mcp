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
      const r = matchText(ctx.insights.ocr, {
        text: atom.text,
        match: "contains",
        min_confidence: 0.6,
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
 * 等待某个 postcondition 在 timeout 内变为 true，每 polling_ms 重新生成 insights。
 */
export async function waitForCondition(
  cond: Condition,
  refresh: () => Promise<ConditionContext>,
  options: { timeout_ms?: number; polling_ms?: number } = {},
): Promise<{ ok: boolean; reasons: string[]; iterations: number }> {
  const timeout = options.timeout_ms ?? 15000;
  const polling = options.polling_ms ?? 250;
  const start = Date.now();
  let iterations = 0;
  let last: { ok: boolean; reasons: string[] } = { ok: false, reasons: [] };
  // 保证至少跑一次完整 refresh — 即便 refresh 比 timeout 还慢（例如 AX dump 数十秒），
  // 也应给条件一次评估机会，否则永远超时。
  do {
    iterations++;
    const ctx = await refresh();
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
