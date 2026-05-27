import type { DisplayInfo, DisplayKind, WindowInfo } from "./types.js";

/**
 * Stable display 选择：从一组 displays 里挑出适合"把窗口稳定放在那里"的 display。
 *
 * 设计取舍：vision-mcp 不创建虚拟显示器（macOS / Windows public API 都不可靠）。
 * Capsule 总是把目标窗口放在用户实际能看到的某个 display 上，**完整可见**。
 *
 * 优先级（高 → 低）：
 *   1. 窗口当前所在的 display（如果它已经被用户拖到副屏，就保留在那里）
 *   2. primary display（默认）
 *   3. 第一个能装下 minClient 尺寸的 display
 */
export interface StablePickOptions {
  minClient?: { width: number; height: number };
  /** 已 attach 的窗口；如果它已经在某个 display，优先用那个 display 不打扰用户。 */
  window?: WindowInfo;
}

export interface StablePickResult {
  display: DisplayInfo | null;
  reason: string;
}

export function pickStableDisplay(
  displays: ReadonlyArray<DisplayInfo>,
  opts: StablePickOptions = {},
): StablePickResult {
  if (displays.length === 0) {
    return { display: null, reason: "no displays" };
  }
  const minW = opts.minClient?.width ?? 0;
  const minH = opts.minClient?.height ?? 0;
  const fits = (d: DisplayInfo) =>
    d.work_area.width >= minW && d.work_area.height >= minH;

  // 1. 窗口当前 display
  if (opts.window?.display_id) {
    const d = displays.find((d) => d.id === opts.window!.display_id);
    if (d && fits(d)) {
      return { display: d, reason: `using window's current display ${d.id}` };
    }
  }
  // 2. primary
  const primary = displays.find((d) => d.is_primary);
  if (primary && fits(primary)) {
    return { display: primary, reason: `using primary display ${primary.id}` };
  }
  // 3. 第一个能装下的
  const any = displays.find(fits);
  if (any) {
    return { display: any, reason: `using first fitting display ${any.id}` };
  }
  // 4. 兜底返回第一个（geometry contract 会发警告）
  return {
    display: displays[0],
    reason: `no display fits minClient ${minW}x${minH}; falling back to ${displays[0].id}`,
  };
}

/** display kind 推断（仅用于 UI 展示；不再决定 workspace 评分）。 */
export function inferDisplayKind(d: DisplayInfo): DisplayKind {
  if (d.kind) return d.kind;
  if (d.is_primary) return "primary";
  return "extended";
}

/** display 人类友好字符串。 */
export function describeDisplay(d: DisplayInfo): string {
  const kind = inferDisplayKind(d);
  const name = d.name ? ` "${d.name}"` : "";
  const tag = kind === "primary" ? "⭐ primary" : kind === "extended" ? "🖥️ extended" : kind;
  return `${d.id}${name} ${tag} ${d.bounds.width}x${d.bounds.height}@${d.scale}x (work ${d.work_area.width}x${d.work_area.height})`;
}
