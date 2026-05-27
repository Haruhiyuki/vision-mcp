import { describe, expect, it } from "vitest";
import {
  inferDisplayKind,
  isRecommendedWorkspace,
  pickWorkspaceDisplay,
  synthesizeOffScreenWorkspace,
  describeDisplay,
  type DisplayInfo,
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

describe("workspace display selection", () => {
  it("primary 单显示器 → pick 失败（不返回 primary）", () => {
    const r = pickWorkspaceDisplay([mk({ id: "d0", is_primary: true })]);
    expect(r.display).toBeNull();
    expect(r.scored[0].kind).toBe("primary");
  });

  it("有副屏 → 优先 extended", () => {
    const r = pickWorkspaceDisplay([
      mk({ id: "p", is_primary: true }),
      mk({ id: "e", bounds: { x: 1920, y: 0, width: 1920, height: 1080 }, work_area: { x: 1920, y: 0, width: 1920, height: 1080 } }),
    ]);
    expect(r.display?.id).toBe("e");
    expect(r.scored[0].kind).toBe("extended");
  });

  it("有 virtual 显示器 → virtual 优先于 extended", () => {
    const r = pickWorkspaceDisplay([
      mk({ id: "p", is_primary: true }),
      mk({ id: "e" }),
      mk({ id: "v", is_virtual: true, kind: "virtual" }),
    ]);
    expect(r.display?.id).toBe("v");
  });

  it("sidecar 优先于 extended", () => {
    const r = pickWorkspaceDisplay([
      mk({ id: "p", is_primary: true }),
      mk({ id: "e" }),
      mk({ id: "s", kind: "sidecar", name: "iPad" }),
    ]);
    expect(r.display?.id).toBe("s");
  });

  it("minClient 不够时降分", () => {
    const r = pickWorkspaceDisplay(
      [mk({ id: "small", bounds: { x: 0, y: 0, width: 800, height: 600 }, work_area: { x: 0, y: 0, width: 800, height: 600 } })],
      { minClient: { width: 1280, height: 800 } },
    );
    expect(r.display).toBeNull();
  });

  it("inferDisplayKind 通过 name 识别第三方虚拟驱动", () => {
    expect(inferDisplayKind(mk({ name: "BetterDisplay 4K", is_primary: false }))).toBe("virtual");
    expect(inferDisplayKind(mk({ name: "Sidecar Display" }))).toBe("sidecar");
    expect(inferDisplayKind(mk({ name: "AirPlay TV" }))).toBe("airplay");
    expect(inferDisplayKind(mk({ name: "Random Monitor" }))).toBe("extended");
    expect(inferDisplayKind(mk({ name: "X", is_primary: true }))).toBe("primary");
  });

  it("isRecommendedWorkspace primary=false / virtual=true", () => {
    expect(isRecommendedWorkspace(mk({ is_primary: true, kind: "primary" }))).toBe(false);
    expect(isRecommendedWorkspace(mk({ kind: "virtual" }))).toBe(true);
    expect(isRecommendedWorkspace(mk({ kind: "sidecar" }))).toBe(true);
    expect(isRecommendedWorkspace(mk({ kind: "mirror" }))).toBe(false);
  });

  it("synthesizeOffScreenWorkspace 把窗口放在主屏右下角让 SCKit 仍能渲染", () => {
    const primary = mk({ id: "p", is_primary: true, bounds: { x: 0, y: 0, width: 1920, height: 1080 } });
    const off = synthesizeOffScreenWorkspace({ primary, width: 1280, height: 800 });
    expect(off.id).toBe("off-screen-workspace");
    expect(off.kind).toBe("virtual");
    expect(off.recommended_for_workspace).toBe(true);
    // 默认 peek=40 → 窗口左上在 (1920-40, 1080-40) = (1880, 1040)
    expect(off.bounds.x).toBe(1880);
    expect(off.bounds.y).toBe(1040);
    expect(off.bounds.width).toBe(1280);
    expect(off.bounds.height).toBe(800);
  });

  it("describeDisplay 返回 emoji + 信息", () => {
    const s = describeDisplay(mk({ id: "d0", name: "Mi Monitor", is_primary: true, kind: "primary" }));
    expect(s).toContain("d0");
    expect(s).toContain("Mi Monitor");
    expect(s).toContain("primary");
  });
});
