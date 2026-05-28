// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Vision-MCP Authors
import { describe, expect, it } from "vitest";
import {
  Capsule,
  MockPlatformAdapter,
  VisionMap,
  buildGeometryState,
  denormalizeBBox,
  planMigrationRect,
} from "@vision-mcp/core";

const baseMap = () =>
  VisionMap.parse({
    version: "0.1",
    app: { id: "demo", name: "Demo", platform: "any" },
    visual_box: {
      id: "cap",
      mode: "real_window",
      platform: "any",
      coordinate_space: "normalized_client_rect",
      display: { width_px: 1280, height_px: 800 },
      target_window: { process_name: "demo.exe" },
      contract: {
        require_client_size_px: [1280, 800],
        tolerate_client_size_delta_px: 2,
      },
    },
  });

describe("geometry helpers", () => {
  it("denormalizeBBox 把归一化框映射到屏幕坐标", () => {
    const r = denormalizeBBox(
      [0.1, 0.2, 0.5, 0.25],
      { x: 0, y: 0, width: 1000, height: 800 },
    );
    expect(r).toEqual({ x: 100, y: 160, width: 500, height: 200 });
  });

  it("planMigrationRect 居中放置", () => {
    const { rect } = planMigrationRect(
      {
        id: "d",
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        work_area: { x: 0, y: 28, width: 1920, height: 1052 },
        scale: 1,
        dpi_x: 96,
        dpi_y: 96,
        refresh_rate_hz: 60,
        is_primary: true,
        is_virtual: false,
      },
      { width: 1280, height: 800 },
    );
    expect(rect.width).toBe(1280);
    expect(rect.height).toBe(800);
    expect(rect.x).toBeGreaterThan(0);
    expect(rect.y).toBeGreaterThan(28);
  });
});

describe("Capsule with mock adapter", () => {
  it("attach → migrate → restore 全流程", async () => {
    const adapter = new MockPlatformAdapter();
    adapter.addWindow({
      title: "Demo Window",
      process_name: "demo.exe",
      bounds: { x: 50, y: 50, width: 800, height: 600 },
    });
    const map = baseMap();
    const cap = new Capsule(map.visual_box, adapter, map.input_lease_policy);
    const display = await cap.ensureDisplay({
      geometry: map.visual_box.display,
      mode: map.visual_box.mode,
    });
    const win = await cap.attach({ target: map.visual_box.target_window! });
    expect(win.title).toBe("Demo Window");
    const migrated = await cap.migrate(display.id);
    expect(migrated.bounds.width).toBeGreaterThan(800);
    const geom = await cap.validateGeometry();
    expect(geom.ok).toBe(true);
    await cap.restore();
    const status = await cap.status();
    expect(status.attached_window).toBeUndefined();
  });

  it("buildGeometryState 标记 size mismatch", () => {
    const map = baseMap();
    const state = buildGeometryState({
      visualBox: map.visual_box,
      contract: map.visual_box.contract,
      display: {
        id: "d",
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        work_area: { x: 0, y: 28, width: 1920, height: 1052 },
        scale: 1,
        dpi_x: 96,
        dpi_y: 96,
        refresh_rate_hz: 60,
        is_primary: true,
        is_virtual: false,
      },
      window: {
        id: "w",
        title: "x",
        process_name: "demo.exe",
        process_id: 1,
        bounds: { x: 0, y: 0, width: 600, height: 400 },
        client_bounds: { x: 0, y: 0, width: 600, height: 400 },
        is_minimized: false,
        is_maximized: false,
        is_fullscreen: false,
        is_foreground: true,
        native_handle: "w",
        display_id: "d",
      },
    });
    expect(state.ok).toBe(false);
    expect(state.violations.length).toBeGreaterThan(0);
  });
});
