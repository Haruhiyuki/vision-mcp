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

  it("capture：窗口句柄失效 → 显式 WINDOW_NOT_FOUND（而非拍出幽灵空图）", async () => {
    const adapter = new MockPlatformAdapter();
    adapter.addWindow({
      title: "Demo Window",
      process_name: "demo.exe",
      bounds: { x: 50, y: 50, width: 800, height: 600 },
    });
    const map = baseMap();
    const cap = new Capsule(map.visual_box, adapter, map.input_lease_policy);
    await cap.ensureDisplay({ geometry: map.visual_box.display, mode: map.visual_box.mode });
    const win = await cap.attach({ target: map.visual_box.target_window! });
    await expect(cap.capture()).resolves.toBeTruthy();
    adapter.removeWindow(win.native_handle); // 模拟目标进程重启/窗口关闭
    await expect(cap.capture()).rejects.toMatchObject({
      code: "WINDOW_NOT_FOUND",
      recoverable: true,
    });
  });

  it("capture：帧尺寸与窗口几何不符 → CAPTURE_INVALID（隐藏/离屏 surface 的静默空图）", async () => {
    const adapter = new MockPlatformAdapter();
    adapter.addWindow({
      title: "Demo Window",
      process_name: "demo.exe",
      bounds: { x: 50, y: 50, width: 800, height: 600 },
    });
    // 平台层对幽灵句柄返回 1000x1000 纯色帧（实测过的故障形态）
    adapter.setFrameProvider(() => ({
      width_px: 1000,
      height_px: 1000,
      pixels: new Uint8Array(1000 * 1000 * 4).fill(255),
      captured_at: new Date().toISOString(),
      source: "window" as const,
      client_rect_in_frame: { x: 0, y: 0, width: 1000, height: 1000 },
    }));
    const map = baseMap();
    const cap = new Capsule(map.visual_box, adapter, map.input_lease_policy);
    await cap.ensureDisplay({ geometry: map.visual_box.display, mode: map.visual_box.mode });
    await cap.attach({ target: map.visual_box.target_window! });
    await expect(cap.capture()).rejects.toMatchObject({
      code: "CAPTURE_INVALID",
      recoverable: true,
    });
  });

  it("capture：Retina 2x 帧（bounds×scale）通过几何校验", async () => {
    const adapter = new MockPlatformAdapter({
      displays: [{ bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scale: 2, is_primary: true }],
    });
    adapter.addWindow({
      title: "Demo Window",
      process_name: "demo.exe",
      bounds: { x: 50, y: 50, width: 800, height: 600 },
    });
    adapter.setFrameProvider((win) => ({
      width_px: win.bounds.width * 2,
      height_px: win.bounds.height * 2,
      pixels: new Uint8Array(win.bounds.width * 2 * win.bounds.height * 2 * 4).fill(200),
      captured_at: new Date().toISOString(),
      source: "window" as const,
      client_rect_in_frame: { x: 0, y: 0, width: win.bounds.width * 2, height: win.bounds.height * 2 },
    }));
    const map = baseMap();
    const cap = new Capsule(map.visual_box, adapter, map.input_lease_policy);
    await cap.ensureDisplay({ geometry: map.visual_box.display, mode: map.visual_box.mode });
    await cap.attach({ target: map.visual_box.target_window! });
    const frame = await cap.capture();
    expect(frame.width_px).toBe(1600);
  });

  it("attach 未匹配时错误信息列出可枚举的窗口进程（可诊断的 WINDOW_NOT_FOUND）", async () => {
    const adapter = new MockPlatformAdapter();
    adapter.addWindow({
      title: "Other Window",
      process_name: "other.exe",
      bounds: { x: 0, y: 0, width: 640, height: 480 },
    });
    const map = baseMap();
    const cap = new Capsule(map.visual_box, adapter, map.input_lease_policy);
    await cap.ensureDisplay({
      geometry: map.visual_box.display,
      mode: map.visual_box.mode,
    });
    // 过滤不匹配 → 错误里应带上「当前可枚举到窗口的进程」提示，
    // 而不是一句无从下手的 NOT_FOUND
    await expect(
      cap.attach({ target: { process_name: "demo.exe" } }),
    ).rejects.toThrow(/other\.exe/);
  });

  it("Retina scale/DPI 差异与菜单栏量级尺寸差是 warning，不阻塞 ok", () => {
    const map = baseMap();
    const state = buildGeometryState({
      visualBox: map.visual_box,
      contract: map.visual_box.contract,
      display: {
        id: "d",
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        work_area: { x: 0, y: 28, width: 1920, height: 1052 },
        scale: 2, // Retina
        dpi_x: 144,
        dpi_y: 144,
        refresh_rate_hz: 60,
        is_primary: true,
        is_virtual: false,
      },
      window: {
        id: "w",
        title: "x",
        process_name: "demo.exe",
        process_id: 1,
        bounds: { x: 0, y: 28, width: 1280, height: 777 },
        // 高度被菜单栏挤掉 23px：warning 而非 violation
        client_bounds: { x: 0, y: 28, width: 1280, height: 777 },
        is_minimized: false,
        is_maximized: false,
        is_fullscreen: false,
        is_foreground: true,
        native_handle: "w",
        display_id: "d",
      },
    });
    expect(state.ok).toBe(true);
    expect(state.violations).toEqual([]);
    expect(state.warnings.length).toBe(3); // size + scale + dpi
  });

  it("contract 未配置 require_client_size_px 时不检查尺寸", () => {
    const map = baseMap();
    const contract = { ...map.visual_box.contract, require_client_size_px: undefined };
    const state = buildGeometryState({
      visualBox: map.visual_box,
      contract,
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
    expect(state.ok).toBe(true);
    expect(state.size_match).toBe(true);
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
