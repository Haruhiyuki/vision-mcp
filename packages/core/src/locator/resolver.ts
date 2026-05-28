// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Vision-MCP Authors
import type {
  Control,
  Locator,
  State,
  StateAnchor,
  VisionMap,
} from "../schema/index.js";
import { VisionMcpError } from "../errors.js";
import type {
  AccessibilityNode,
  FrameInsights,
  LocatorMatch,
  LocatorProviders,
  StateMatch,
} from "./types.js";
import { findNearby, matchText } from "./text.js";
import { DHashProvider } from "./visual-hash.js";

/**
 * Locator resolver：在给定 frame insights 上按优先级寻找单个控件，
 * 或评估当前 state 与 map 中 state 列表的匹配度。
 *
 * 设计目标：
 *   - 多 locator 融合（accessibility → ocr → nearby → image_patch → bbox_norm → vlm）。
 *   - 任一 locator 命中即返回；没命中走下一个。
 *   - 始终返回 bbox_norm + center_norm，用于后续输入坐标换算。
 */
export class LocatorResolver {
  private hasher: DHashProvider;
  constructor(private readonly providers: LocatorProviders) {
    this.hasher = new DHashProvider();
  }

  async analyze(frame: FrameInsights["frame"]): Promise<FrameInsights> {
    const insights: FrameInsights = {
      frame,
      ocr: this.providers.ocr ? await this.providers.ocr.recognize(frame) : [],
      accessibility: [],
      visual_hash: undefined,
    };
    if (this.providers.visualHash) {
      insights.visual_hash = await this.providers.visualHash.hash(frame);
    } else {
      insights.visual_hash = await this.hasher.hash(frame);
    }
    return insights;
  }

  async setAccessibility(
    insights: FrameInsights,
    windowHandle?: string,
  ): Promise<void> {
    if (this.providers.accessibility && windowHandle) {
      insights.accessibility =
        await this.providers.accessibility.snapshot(windowHandle);
    }
  }

  /**
   * 在 map.states 中找到与当前 frame 最匹配的 state。
   * 返回最佳 match（也可能为 null，表示无任何 state 通过最低分阈值）。
   */
  detectState(map: VisionMap, insights: FrameInsights): StateMatch | null {
    const minOcr = map.repair_policy.state.min_ocr_similarity;
    const minVis = map.repair_policy.state.min_visual_similarity;
    let best: StateMatch | null = null;
    for (const state of map.states) {
      const matched: StateAnchor[] = [];
      let score = 0;
      let weights = 0;
      for (const anchor of state.anchors) {
        weights += 1;
        if (anchor.type === "ocr_text") {
          const r = matchText(insights.ocr, {
            text: anchor.text,
            match: anchor.match,
            min_confidence: anchor.min_confidence,
          });
          if (r) {
            matched.push(anchor);
            score += r.confidence;
          }
        } else if (anchor.type === "accessibility") {
          const ok = matchAccessibility(insights.accessibility, anchor);
          if (ok) {
            matched.push(anchor);
            score += 1;
          }
        } else if (anchor.type === "window_title") {
          if (insights.window_title) {
            try {
              const re = new RegExp(anchor.pattern);
              if (re.test(insights.window_title)) {
                matched.push(anchor);
                score += 1;
              }
            } catch {
              // 非法正则不算命中
            }
          }
        } else if (anchor.type === "visual_hash") {
          if (
            insights.visual_hash &&
            this.hasher.similarity(insights.visual_hash, anchor.hash) >=
              (anchor.min_similarity ?? minVis)
          ) {
            matched.push(anchor);
            score += 1;
          }
        }
      }
      const matchPolicy = state.match_policy;
      const passes =
        matchPolicy === "any_anchor"
          ? matched.length > 0
          : matchPolicy === "all_anchors"
            ? matched.length === state.anchors.length
            : score / Math.max(weights, 1) >= Math.min(minOcr, minVis);
      if (!passes) continue;
      const normalized = score / Math.max(weights, 1);
      if (
        !best ||
        normalized > best.score ||
        // 同 score 时选 anchors 命中数量更多的（更具体的状态优先）
        (normalized === best.score && matched.length > best.matched_anchors.length)
      ) {
        best = { state_id: state.id, score: normalized, matched_anchors: matched };
      }
    }
    return best;
  }

  async resolveControl(
    map: VisionMap,
    state: State,
    control: Control,
    insights: FrameInsights,
    baseDir: string,
  ): Promise<LocatorMatch> {
    for (const loc of control.locator_priority) {
      const m = await this.tryLocator(loc, control, insights, baseDir, map);
      if (m) return m;
    }
    if (control.visual?.bbox_norm) {
      // 兜底：使用预存视觉提示
      const bbox = control.visual.bbox_norm;
      return {
        control_id: control.id,
        bbox_norm: bbox,
        center_norm: [bbox[0] + bbox[2] / 2, bbox[1] + bbox[3] / 2],
        confidence: 0.5,
        locator_used: "bbox_norm",
        evidence: "fallback to visual.bbox_norm hint",
      };
    }
    throw new VisionMcpError(
      "LOCATOR_FAILED",
      `控件 ${state.id}.${control.id} 所有 locator 都未命中`,
      { recoverable: true },
    );
  }

  private async tryLocator(
    loc: Locator,
    control: Control,
    insights: FrameInsights,
    baseDir: string,
    map: VisionMap,
  ): Promise<LocatorMatch | null> {
    switch (loc.type) {
      case "accessibility": {
        const node = findAccessibilityNode(insights.accessibility, loc);
        if (!node) return null;
        return {
          control_id: control.id,
          bbox_norm: node.bbox_norm,
          center_norm: [
            node.bbox_norm[0] + node.bbox_norm[2] / 2,
            node.bbox_norm[1] + node.bbox_norm[3] / 2,
          ],
          confidence: 0.98,
          locator_used: "accessibility",
          evidence: `ax:${node.role}/${node.name ?? node.automation_id ?? ""}`,
        };
      }
      case "ocr_text": {
        const tokens = filterTokens(insights.ocr, loc.search_region);
        const r = matchText(tokens, {
          text: loc.text,
          match: loc.match,
          min_confidence: loc.min_confidence,
        });
        if (!r) return null;
        return {
          control_id: control.id,
          bbox_norm: r.bbox_norm,
          center_norm: [
            r.bbox_norm[0] + r.bbox_norm[2] / 2,
            r.bbox_norm[1] + r.bbox_norm[3] / 2,
          ],
          confidence: r.confidence,
          locator_used: "ocr_text",
          evidence: `ocr:${loc.text}`,
        };
      }
      case "nearby_text": {
        const pivot = control.visual?.bbox_norm;
        if (!pivot) return null;
        const nearby = findNearby(
          insights.ocr,
          pivot,
          loc.direction,
          loc.max_distance_norm,
        );
        const target = nearby.find((t) => t.text.includes(loc.text));
        if (!target) return null;
        return {
          control_id: control.id,
          bbox_norm: target.bbox_norm,
          center_norm: [
            target.bbox_norm[0] + target.bbox_norm[2] / 2,
            target.bbox_norm[1] + target.bbox_norm[3] / 2,
          ],
          confidence: target.confidence,
          locator_used: "nearby_text",
          evidence: `nearby:${loc.direction}:${loc.text}`,
        };
      }
      case "image_patch": {
        if (!this.providers.patchImage) return null;
        const r = await this.providers.patchImage.search(
          insights.frame,
          { file: loc.file, min_similarity: loc.min_similarity },
          baseDir,
        );
        if (!r) return null;
        return {
          control_id: control.id,
          bbox_norm: r.bbox_norm,
          center_norm: [
            r.bbox_norm[0] + r.bbox_norm[2] / 2,
            r.bbox_norm[1] + r.bbox_norm[3] / 2,
          ],
          confidence: r.similarity,
          locator_used: "image_patch",
          evidence: `patch:${loc.file}`,
        };
      }
      case "bbox_norm": {
        return {
          control_id: control.id,
          bbox_norm: loc.value,
          center_norm: [
            loc.value[0] + loc.value[2] / 2,
            loc.value[1] + loc.value[3] / 2,
          ],
          confidence: 0.6,
          locator_used: "bbox_norm",
          evidence: "static bbox",
        };
      }
      case "vlm": {
        if (!this.providers.vlm) return null;
        if (!map.safety_policy.allow_cloud_vlm) {
          return null;
        }
        const r = await this.providers.vlm.relocate(
          insights.frame,
          loc.prompt,
          loc.hint_bbox_norm,
        );
        if (!r) return null;
        return {
          control_id: control.id,
          bbox_norm: r.bbox_norm,
          center_norm: [
            r.bbox_norm[0] + r.bbox_norm[2] / 2,
            r.bbox_norm[1] + r.bbox_norm[3] / 2,
          ],
          confidence: r.confidence,
          locator_used: "vlm",
          evidence: `vlm:${loc.prompt.slice(0, 32)}`,
        };
      }
      case "ordinal_in_region": {
        // 在指定 region 内或全屏，按 (y, x) 排序取第 index 个匹配 role 的 AX 节点
        const regionBbox = loc.region_id
          ? map.regions?.find((r) => r.id === loc.region_id)?.bbox_norm
          : undefined;
        let nodes = insights.accessibility;
        if (regionBbox) {
          const [rx, ry, rw, rh] = regionBbox;
          nodes = nodes.filter((n) => {
            const [nx, ny] = n.bbox_norm;
            return nx >= rx - 0.01 && ny >= ry - 0.01 &&
                   nx <= rx + rw + 0.01 && ny <= ry + rh + 0.01;
          });
        }
        nodes = nodes.filter((n) => {
          if (loc.role && n.role !== loc.role) return false;
          if (loc.role_regex && (!n.role || !new RegExp(loc.role_regex).test(n.role))) return false;
          const [, , w, h] = n.bbox_norm;
          if (w < (loc.min_width_norm ?? 0.01)) return false;
          if (h < (loc.min_height_norm ?? 0.01)) return false;
          return true;
        });
        nodes = [...nodes].sort((a, b) => {
          const dy = a.bbox_norm[1] - b.bbox_norm[1];
          if (Math.abs(dy) > 0.01) return dy;
          return a.bbox_norm[0] - b.bbox_norm[0];
        });
        const hit = nodes[loc.index];
        if (!hit) return null;
        const [x, y, w, h] = hit.bbox_norm;
        return {
          control_id: control.id,
          bbox_norm: hit.bbox_norm,
          center_norm: [x + w / 2, y + h / 2],
          confidence: 0.85,
          locator_used: "ordinal_in_region",
          evidence: `ordinal_in_region: ${loc.region_id ?? "all"} role=${loc.role ?? loc.role_regex} idx=${loc.index}`,
        };
      }
    }
  }
}

function filterTokens(
  tokens: import("./types.js").OcrToken[],
  region?: import("../schema/index.js").BBoxNorm,
): import("./types.js").OcrToken[] {
  if (!region) return tokens;
  const [rx, ry, rw, rh] = region;
  return tokens.filter((t) => {
    const cx = t.bbox_norm[0] + t.bbox_norm[2] / 2;
    const cy = t.bbox_norm[1] + t.bbox_norm[3] / 2;
    return cx >= rx && cx <= rx + rw && cy >= ry && cy <= ry + rh;
  });
}

function matchAccessibility(
  nodes: AccessibilityNode[],
  anchor: Extract<StateAnchor, { type: "accessibility" }>,
): boolean {
  return !!findAccessibilityNode(nodes, {
    type: "accessibility",
    role: anchor.role,
    name: anchor.name,
    name_regex: anchor.name_regex,
    description: anchor.description,
    description_regex: anchor.description_regex,
    automation_id: anchor.automation_id,
  });
}

function findAccessibilityNode(
  nodes: AccessibilityNode[],
  q: {
    type: "accessibility";
    role?: string;
    name?: string;
    name_regex?: string;
    name_not?: string;
    description?: string;
    description_regex?: string;
    description_not?: string;
    automation_id?: string;
    class_name?: string;
    index?: number;
  },
): AccessibilityNode | null {
  const matches: AccessibilityNode[] = [];
  const walk = (list: AccessibilityNode[]) => {
    for (const n of list) {
      if (q.role && n.role !== q.role) {
      } else if (q.automation_id && n.automation_id !== q.automation_id) {
      } else if (q.class_name && n.class_name !== q.class_name) {
      } else if (q.name && n.name !== q.name) {
      } else if (q.name_not && n.name === q.name_not) {
      } else if (q.name_regex && (!n.name || !new RegExp(q.name_regex).test(n.name))) {
      } else if (q.description && n.description !== q.description) {
      } else if (q.description_not && n.description === q.description_not) {
      } else if (q.description_regex && (!n.description || !new RegExp(q.description_regex).test(n.description))) {
      } else {
        matches.push(n);
      }
      if (n.children) walk(n.children);
    }
  };
  walk(nodes);
  if (matches.length === 0) return null;
  if (q.index !== undefined && q.index < matches.length) return matches[q.index];
  return matches[0];
}
