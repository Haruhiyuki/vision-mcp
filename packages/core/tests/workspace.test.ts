// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Vision-MCP Authors
import { describe, expect, it } from "vitest";
import {
  inferDisplayKind,
  pickStableDisplay,
  describeDisplay,
  type DisplayInfo,
  type WindowInfo,
} from "@vision-mcp/core";

function mk(overrides: Partial<DisplayInfo>): DisplayInfo {
  return {
    id: "d",
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    work_area: { x: 0, y: 28, width: 1920, height: 1052 },
    scale: 1,
    dpi_x: 96,
    dpi_y: 96,
    refresh_rate_hz: 60,
    is_primary: false,
    is_virtual: false,
    ...overrides,
  };
}

function mkWindow(displayId?: string): WindowInfo {
  return {
    id: "w",
    title: "test",
    process_name: "test",
    process_id: 1234,
    bounds: { x: 0, y: 0, width: 800, height: 600 },
    client_bounds: { x: 0, y: 0, width: 800, height: 600 },
    display_id: displayId,
    is_minimized: false,
    is_maximized: false,
    is_fullscreen: false,
    is_foreground: true,
    native_handle: "w",
  };
}

describe("pickStableDisplay", () => {
  it("单显示器场景：返回 primary", () => {
    const r = pickStableDisplay([mk({ id: "d0", is_primary: true })]);
    expect(r.display?.id).toBe("d0");
  });

  it("有窗口当前 display：优先用它（不强行回主屏）", () => {
    const r = pickStableDisplay(
      [mk({ id: "p", is_primary: true }), mk({ id: "ext", bounds: { x: 1920, y: 0, width: 1920, height: 1080 }, work_area: { x: 1920, y: 0, width: 1920, height: 1080 } })],
      { window: mkWindow("ext") },
    );
    expect(r.display?.id).toBe("ext");
  });

  it("无窗口 hint + 多显示器：返回 primary", () => {
    const r = pickStableDisplay(
      [mk({ id: "p", is_primary: true }), mk({ id: "ext", bounds: { x: 1920, y: 0, width: 1920, height: 1080 } })],
    );
    expect(r.display?.id).toBe("p");
  });

  it("primary 太小不够容纳 minClient：fallback 到能装下的副屏", () => {
    const r = pickStableDisplay(
      [
        mk({ id: "small", is_primary: true, bounds: { x: 0, y: 0, width: 800, height: 600 }, work_area: { x: 0, y: 0, width: 800, height: 600 } }),
        mk({ id: "big", bounds: { x: 0, y: 0, width: 2560, height: 1440 }, work_area: { x: 0, y: 0, width: 2560, height: 1440 } }),
      ],
      { minClient: { width: 1280, height: 800 } },
    );
    expect(r.display?.id).toBe("big");
  });

  it("空 display 列表：display=null", () => {
    const r = pickStableDisplay([]);
    expect(r.display).toBeNull();
  });
});

describe("inferDisplayKind / describeDisplay", () => {
  it("primary 标记为 primary", () => {
    expect(inferDisplayKind(mk({ is_primary: true }))).toBe("primary");
  });

  it("非 primary 不带 kind hint：fallback 到 extended", () => {
    expect(inferDisplayKind(mk({ is_primary: false }))).toBe("extended");
  });

  it("已有 kind 字段：照用", () => {
    expect(inferDisplayKind(mk({ kind: "mirror" }))).toBe("mirror");
  });

  it("describeDisplay 输出含 id 和分辨率", () => {
    const s = describeDisplay(mk({ id: "d0", name: "Mi Monitor", is_primary: true }));
    expect(s).toContain("d0");
    expect(s).toContain("Mi Monitor");
    expect(s).toContain("primary");
    expect(s).toContain("1920x1080");
  });
});
