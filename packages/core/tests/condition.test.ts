// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Vision-MCP Authors
import { describe, expect, it } from "vitest";
import {
  Condition,
  evaluateCondition,
  VisionMap,
} from "@vision-mcp/core";

const map = VisionMap.parse({
  version: "0.1",
  app: { id: "demo", name: "Demo", platform: "any" },
  visual_box: {
    id: "cap",
    mode: "real_window",
    platform: "any",
    coordinate_space: "normalized_client_rect",
    display: { width_px: 800, height_px: 600 },
    contract: { require_client_size_px: [800, 600] },
  },
  states: [
    {
      id: "modal",
      kind: "modal",
      anchors: [{ type: "ocr_text", text: "提示" }],
      controls: [],
    },
  ],
});

describe("evaluateCondition", () => {
  it("text_should_appear 命中 OCR token", async () => {
    const cond = Condition.parse({
      type: "text_should_appear",
      text: "保存成功",
      timeout_ms: 1000,
    });
    const r = await evaluateCondition(cond, {
      map,
      state_match: null,
      insights: {
        frame: {
          width_px: 800,
          height_px: 600,
          pixels: new Uint8Array(800 * 600 * 4),
          captured_at: "2026",
          source: "window",
          client_rect_in_frame: { x: 0, y: 0, width: 800, height: 600 },
        },
        ocr: [
          { text: "保存成功", bbox_norm: [0.3, 0.4, 0.1, 0.05], confidence: 0.95 },
        ],
        accessibility: [],
      },
    });
    expect(r.ok).toBe(true);
  });

  it("modal_should_close: 当前 state 是 modal 时返回 false", async () => {
    const cond = Condition.parse({ type: "modal_should_close" });
    const r = await evaluateCondition(cond, {
      map,
      state_match: { state_id: "modal", score: 1, matched_anchors: [] },
      insights: {
        frame: {
          width_px: 1,
          height_px: 1,
          pixels: new Uint8Array(4),
          captured_at: "2026",
          source: "window",
          client_rect_in_frame: { x: 0, y: 0, width: 1, height: 1 },
        },
        ocr: [],
        accessibility: [],
      },
    });
    expect(r.ok).toBe(false);
  });

  it("any 任一命中即通过", async () => {
    const cond = Condition.parse({
      any: [
        { type: "text_should_appear", text: "X" },
        { type: "state_should_be", state_id: "modal" },
      ],
    });
    const r = await evaluateCondition(cond, {
      map,
      state_match: { state_id: "modal", score: 1, matched_anchors: [] },
      insights: {
        frame: {
          width_px: 1,
          height_px: 1,
          pixels: new Uint8Array(4),
          captured_at: "2026",
          source: "window",
          client_rect_in_frame: { x: 0, y: 0, width: 1, height: 1 },
        },
        ocr: [],
        accessibility: [],
      },
    });
    expect(r.ok).toBe(true);
  });
});
