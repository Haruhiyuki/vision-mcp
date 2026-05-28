// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Vision-MCP Authors
import { describe, expect, it } from "vitest";
import {
  Control,
  Patch,
  State,
  VisionMap,
  lintMap,
  hasErrors,
} from "@vision-mcp/core";

describe("schema", () => {
  it("接受最小可用 map", () => {
    const map = VisionMap.parse({
      version: "0.1",
      app: { id: "demo", name: "Demo", platform: "any" },
      visual_box: {
        id: "demo-capsule",
        mode: "real_window",
        platform: "any",
        coordinate_space: "normalized_client_rect",
        display: { width_px: 800, height_px: 600 },
        contract: { require_client_size_px: [800, 600] },
      },
    });
    expect(map.repair_policy.max_auto_repair_level).toBe(3);
    expect(map.input_lease_policy.default_lease_ms).toBe(5000);
  });

  it("拒绝非法 control id", () => {
    expect(() =>
      Control.parse({
        id: ".bad id",
        role: "button",
        action_types: ["click"],
        locator_priority: [{ type: "bbox_norm", value: [0, 0, 1, 1] }],
      }),
    ).toThrow();
  });

  it("拒绝缺失 anchors 的 state", () => {
    expect(() =>
      State.parse({
        id: "x",
        anchors: [],
        controls: [],
      }),
    ).toThrow();
  });

  it("接受 control_bbox patch", () => {
    const p = Patch.parse({
      kind: "control_bbox",
      id: "p-1",
      state_id: "s",
      control_id: "c",
      new_bbox_norm: [0.1, 0.1, 0.2, 0.2],
      method: "ocr_text",
    });
    expect(p.kind).toBe("control_bbox");
  });

  it("lintMap 发现重复 state id", () => {
    const map = VisionMap.parse({
      version: "0.1",
      app: { id: "demo", name: "Demo", platform: "any" },
      visual_box: {
        id: "demo-capsule",
        mode: "real_window",
        platform: "any",
        coordinate_space: "normalized_client_rect",
        display: { width_px: 800, height_px: 600 },
        contract: { require_client_size_px: [800, 600] },
      },
      states: [
        { id: "dup", anchors: [{ type: "ocr_text", text: "A" }], controls: [] },
        { id: "dup", anchors: [{ type: "ocr_text", text: "B" }], controls: [] },
      ],
    });
    const issues = lintMap(map);
    expect(hasErrors(issues)).toBe(true);
  });
});
