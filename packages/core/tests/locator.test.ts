// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Vision-MCP Authors
import { describe, expect, it } from "vitest";
import {
  DHashProvider,
  FixedOcrProvider,
  LocatorResolver,
  VisionMap,
  computeDHash,
  hammingDistance,
  matchText,
} from "@vision-mcp/core";

const frame = {
  width_px: 200,
  height_px: 100,
  pixels: new Uint8Array(200 * 100 * 4).fill(255),
  captured_at: "2026-01-01T00:00:00Z",
  source: "window" as const,
  client_rect_in_frame: { x: 0, y: 0, width: 200, height: 100 },
};

describe("locator text matching", () => {
  it("contains 命中单 token", () => {
    const r = matchText(
      [
        { text: "登录", bbox_norm: [0.4, 0.5, 0.1, 0.05], confidence: 0.9 },
        { text: "取消", bbox_norm: [0.6, 0.5, 0.1, 0.05], confidence: 0.9 },
      ],
      { text: "登录", match: "contains" },
    );
    expect(r).not.toBeNull();
    expect(r!.bbox_norm[0]).toBeCloseTo(0.4, 5);
  });

  it("可拼接相邻 token", () => {
    const r = matchText(
      [
        { text: "用户", bbox_norm: [0.1, 0.1, 0.1, 0.05], confidence: 0.9 },
        { text: "名称", bbox_norm: [0.2, 0.1, 0.1, 0.05], confidence: 0.9 },
      ],
      { text: "用户名称", match: "contains" },
    );
    expect(r).not.toBeNull();
    expect(r!.tokens.length).toBe(2);
  });

  it("置信度过低不命中", () => {
    const r = matchText(
      [{ text: "提交", bbox_norm: [0, 0, 0.1, 0.1], confidence: 0.4 }],
      { text: "提交", min_confidence: 0.8 },
    );
    expect(r).toBeNull();
  });
});

describe("visual hash", () => {
  it("dHash 在完全相同帧上为 0 距离", async () => {
    const a = computeDHash(frame);
    const b = computeDHash(frame);
    expect(hammingDistance(a, b)).toBe(0);
  });

  it("DHashProvider similarity 落在 [0,1]", async () => {
    const p = new DHashProvider();
    const a = await p.hash(frame);
    const sim = p.similarity(a, a);
    expect(sim).toBe(1);
  });
});

describe("LocatorResolver detectState", () => {
  it("匹配 ocr 锚点的 state", async () => {
    const map = VisionMap.parse({
      version: "0.1",
      app: { id: "demo", name: "Demo", platform: "any" },
      visual_box: {
        id: "cap",
        mode: "real_window",
        platform: "any",
        coordinate_space: "normalized_client_rect",
        display: { width_px: 200, height_px: 100 },
        contract: { require_client_size_px: [200, 100] },
      },
      states: [
        {
          id: "login",
          anchors: [
            { type: "ocr_text", text: "登录" },
          ],
          controls: [],
        },
      ],
    });
    const resolver = new LocatorResolver({
      ocr: new FixedOcrProvider([
        { text: "登录", bbox_norm: [0.1, 0.1, 0.1, 0.05], confidence: 0.95 },
      ]),
    });
    const insights = await resolver.analyze(frame);
    const r = resolver.detectState(map, insights);
    expect(r?.state_id).toBe("login");
  });
});
