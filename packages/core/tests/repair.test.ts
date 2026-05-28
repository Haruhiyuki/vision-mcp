// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Vision-MCP Authors
import { describe, expect, it } from "vitest";
import {
  Capsule,
  LocatorResolver,
  MockPlatformAdapter,
  RepairEngine,
  VisionMap,
  applyPatches,
} from "@vision-mcp/core";

describe("RepairEngine", () => {
  it("L3 relocateControl 通过 label 命中并写 control_bbox patch", async () => {
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
          id: "page",
          anchors: [{ type: "ocr_text", text: "Title" }],
          controls: [
            {
              id: "btn",
              role: "button",
              label: "Save",
              action_types: ["click"],
              locator_priority: [
                { type: "bbox_norm", value: [0.2, 0.2, 0.05, 0.05] },
              ],
              visual: { bbox_norm: [0.2, 0.2, 0.05, 0.05] },
            },
          ],
        },
      ],
    });
    const adapter = new MockPlatformAdapter();
    adapter.addWindow({
      title: "Demo",
      process_name: "demo.exe",
      bounds: { x: 0, y: 0, width: 800, height: 600 },
    });
    const capsule = new Capsule(map.visual_box, adapter, map.input_lease_policy);
    const display = await capsule.ensureDisplay({
      geometry: map.visual_box.display,
      mode: map.visual_box.mode,
    });
    await capsule.attach({
      target: { process_name: "demo.exe" },
    });
    await capsule.migrate(display.id);
    const resolver = new LocatorResolver({
      ocr: {
        recognize: async () => [
          { text: "Save", bbox_norm: [0.22, 0.22, 0.05, 0.05], confidence: 0.97 },
        ],
      },
    });
    const frame = await capsule.capture();
    const insights = await resolver.analyze(frame);

    let captured: import("@vision-mcp/core").Patch | undefined;
    const engine = new RepairEngine({
      map,
      capsule,
      resolver,
      mapBaseDir: ".",
      onPatch: (p) => {
        captured = p;
      },
    });
    const r = await engine.relocateControl({
      state: map.states[0],
      control: map.states[0].controls[0],
      insights,
    });
    expect(r.match).not.toBeNull();
    expect(captured?.kind).toBe("control_bbox");
    if (captured?.kind === "control_bbox") {
      expect(captured.new_bbox_norm[0]).toBeCloseTo(0.22, 2);
    }

    // applyPatches 应该把 control bbox 替换
    const next = applyPatches(map, [captured!]);
    expect(next.states[0].controls[0].visual?.bbox_norm).toEqual(
      captured?.kind === "control_bbox" ? captured.new_bbox_norm : null,
    );
  });

  it("attempt L0 在几何 OK 时返回 succeeded=true", async () => {
    const map = VisionMap.parse({
      version: "0.1",
      app: { id: "demo", name: "Demo", platform: "any" },
      visual_box: {
        id: "cap",
        mode: "real_window",
        platform: "any",
        coordinate_space: "normalized_client_rect",
        display: { width_px: 800, height_px: 600 },
        target_window: { process_name: "demo.exe" },
        contract: { require_client_size_px: [800, 600] },
      },
    });
    const adapter = new MockPlatformAdapter();
    adapter.addWindow({
      title: "Demo",
      process_name: "demo.exe",
      bounds: { x: 0, y: 0, width: 800, height: 600 },
    });
    const capsule = new Capsule(map.visual_box, adapter, map.input_lease_policy);
    const display = await capsule.ensureDisplay({
      geometry: map.visual_box.display,
      mode: map.visual_box.mode,
    });
    await capsule.attach({ target: map.visual_box.target_window! });
    await capsule.migrate(display.id);
    const resolver = new LocatorResolver({});
    const engine = new RepairEngine({
      map,
      capsule,
      resolver,
      mapBaseDir: ".",
    });
    const r = await engine.attempt({ level: 0 });
    expect(r.succeeded).toBe(true);
  });
});
