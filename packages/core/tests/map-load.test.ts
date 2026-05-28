// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Vision-MCP Authors
import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  VisionMap,
  applyPatches,
  loadMap,
  saveMap,
  writePatch,
} from "@vision-mcp/core";

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "vision-mcp-test-"));
}

const sampleMap = (): import("@vision-mcp/core").VisionMap =>
  VisionMap.parse({
    version: "0.1",
    app: { id: "demo", name: "Demo", platform: "any" },
    visual_box: {
      id: "demo-cap",
      mode: "real_window",
      platform: "any",
      coordinate_space: "normalized_client_rect",
      display: { width_px: 800, height_px: 600 },
      contract: { require_client_size_px: [800, 600] },
    },
    states: [
      {
        id: "home",
        anchors: [{ type: "ocr_text", text: "Hello" }],
        controls: [
          {
            id: "btn",
            role: "button",
            action_types: ["click"],
            locator_priority: [
              { type: "bbox_norm", value: [0.2, 0.2, 0.3, 0.1] },
            ],
            visual: { bbox_norm: [0.2, 0.2, 0.3, 0.1] },
          },
        ],
      },
    ],
  });

describe("map io", () => {
  it("save + load 一致", async () => {
    const dir = await makeTempDir();
    const mp = path.join(dir, "vision-mcp.yaml");
    const original = sampleMap();
    await saveMap(mp, original);
    const result = await loadMap(mp);
    expect(result.baseline.app.id).toBe("demo");
    expect(result.effective.states[0].controls[0].id).toBe("btn");
  });

  it("applyPatches: control_bbox 覆盖 bbox 与 locator", async () => {
    const dir = await makeTempDir();
    const mp = path.join(dir, "vision-mcp.yaml");
    const original = sampleMap();
    await saveMap(mp, original);
    await writePatch(dir, {
      kind: "control_bbox",
      id: "patch-1",
      trust: "trusted",
      state_id: "home",
      control_id: "btn",
      new_bbox_norm: [0.5, 0.5, 0.2, 0.1],
      method: "test",
    } as never);
    const result = await loadMap(mp);
    const ctrl = result.effective.states[0].controls[0];
    expect(ctrl.visual?.bbox_norm).toEqual([0.5, 0.5, 0.2, 0.1]);
    expect(
      (ctrl.locator_priority[0] as { type: string; value: number[] }).value,
    ).toEqual([0.5, 0.5, 0.2, 0.1]);
  });

  it("applyPatches: geometry_profile 更新 require_client_size_px", () => {
    const baseline = sampleMap();
    const next = applyPatches(baseline, [
      {
        kind: "geometry_profile",
        id: "g1",
        trust: "trusted",
        visual_box_id: "demo-cap",
        display: { width_px: 1024, height_px: 768 },
        confidence: 1,
        requires_review: false,
      } as never,
    ]);
    expect(next.visual_box.display.width_px).toBe(1024);
    expect(next.visual_box.contract.require_client_size_px).toEqual([1024, 768]);
  });
});
