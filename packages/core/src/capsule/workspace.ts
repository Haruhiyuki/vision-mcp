import type { DisplayInfo, DisplayKind } from "./types.js";

/**
 * Workspace display 选择：从一组 displays 里挑出最适合做 agent workspace 的。
 *
 * 设计文档 §9.2：macOS 首发不创建系统虚拟显示器，而是优先利用已有的
 * "non-primary" 显示器（含 Sidecar / AirPlay / 第三方虚拟驱动）作为 capsule workspace。
 * 把窗口移到这些显示器上，agent 操作不会抢用户主屏。
 *
 * 优先级（高 → 低）：
 *   1. virtual         （BetterDisplay / Deskreen / DummyDisplay / Windows IDD 等专门做虚拟工作区的）
 *   2. sidecar         （iPad as second display；用户能直接接管）
 *   3. airplay         （AirPlay 到外部接收端）
 *   4. extended        （普通物理副屏）
 *   5. primary         （兜底；如果只有主屏会走 real_window，不返回 primary）
 *   6. mirror / unknown （不返回）
 *
 * 还会要求 work_area 至少能容纳 minClient（如不指定，0）。
 */
export interface WorkspacePickOptions {
  minClient?: { width: number; height: number };
  /** 显式排除某些 display id（例如 attach 时窗口当前所在的主屏）。 */
  exclude?: string[];
  /** 允许返回 primary 作为兜底（默认 false，调用方自己决定要不要降级）。 */
  allowPrimary?: boolean;
}

export interface WorkspacePickResult {
  display: DisplayInfo | null;
  reason: string;
  /** 详细评分列表，便于 CLI/UI 展示。 */
  scored: ReadonlyArray<{ display: DisplayInfo; score: number; kind: DisplayKind; note: string }>;
}

const KIND_SCORE: Record<DisplayKind, number> = {
  virtual: 100,
  sidecar: 80,
  airplay: 70,
  extended: 50,
  primary: 10,
  mirror: 0,
  unknown: 30,
};

export function inferDisplayKind(d: DisplayInfo): DisplayKind {
  if (d.kind) return d.kind;
  if (d.is_virtual) return "virtual";
  if (d.is_primary) return "primary";
  // 老 helper 没传 kind：name 兜底
  const name = (d.name ?? "").toLowerCase();
  if (name.includes("sidecar") || name.includes("ipad")) return "sidecar";
  if (name.includes("airplay")) return "airplay";
  if (
    name.includes("betterdisplay") ||
    name.includes("deskreen") ||
    name.includes("dummy") ||
    name.includes("virtual")
  ) {
    return "virtual";
  }
  return "extended";
}

export function isRecommendedWorkspace(d: DisplayInfo): boolean {
  if (d.recommended_for_workspace !== undefined) return d.recommended_for_workspace;
  const k = inferDisplayKind(d);
  return k === "virtual" || k === "sidecar" || k === "airplay" || k === "extended";
}

export function pickWorkspaceDisplay(
  displays: ReadonlyArray<DisplayInfo>,
  opts: WorkspacePickOptions = {},
): WorkspacePickResult {
  const exclude = new Set(opts.exclude ?? []);
  const minW = opts.minClient?.width ?? 0;
  const minH = opts.minClient?.height ?? 0;

  const scored = displays
    .filter((d) => !exclude.has(d.id))
    .map((d) => {
      const kind = inferDisplayKind(d);
      let score = KIND_SCORE[kind];
      const note: string[] = [`kind=${kind}`];
      const fits = d.work_area.width >= minW && d.work_area.height >= minH;
      if (!fits) {
        score = -1; // 太小 → 直接排除（不是"降分"，是不可用）
        note.push(
          `work_area ${d.work_area.width}x${d.work_area.height} < 期望 ${minW}x${minH}`,
        );
      }
      if (!opts.allowPrimary && kind === "primary") {
        score = -1;
        note.push("excluded primary");
      }
      if (kind === "mirror") {
        score = -1;
        note.push("excluded mirror");
      }
      return { display: d, score, kind, note: note.join("; ") };
    })
    .sort((a, b) => b.score - a.score);

  const best = scored.find((s) => s.score >= 0);
  if (!best) {
    return {
      display: null,
      reason:
        scored.length === 0
          ? "no displays"
          : `no suitable workspace display (best score ${scored[0]?.score})`,
      scored,
    };
  }
  return {
    display: best.display,
    reason: `picked ${best.kind} display ${best.display.id} (score ${best.score})`,
    scored,
  };
}

/**
 * Off-screen workspace：合成一个"虚拟工作区"，把窗口放在主屏边缘"几乎屏外"的位置。
 *
 * 设计取舍：
 *   macOS WindowServer 不允许窗口完全离开主屏——一旦完全屏外，窗口会被
 *   WindowServer 标记为 hidden，停止渲染，CGWindowList/SCKit 都拿不到内容。
 *   实测 AX setPosition 也会被 constrainFrameRectToScreen 自动 clamp 到至少留 ~40px 可见。
 *
 *   所以"屏外"在 macOS 单屏环境下不可达；本函数改为：
 *     - 把窗口放到主屏右下角，让 windowH 的顶部 32px 留在主屏内（标题栏可见）
 *     - 整体看起来像一个"折叠"到角落的窗口，agent 操作时配合 virtual cursor
 *       (warp_restore 模式) 让用户的物理光标不被打扰
 *     - 通过 Live View（capture.window + http server）在浏览器看到完整画面
 *
 *   真正完美的"不抢主屏"体验仍然需要副屏 / Sidecar / AirPlay / 第三方虚拟显示驱动。
 */
export function synthesizeOffScreenWorkspace(opts: {
  primary: DisplayInfo;
  width: number;
  height: number;
  offsetX?: number;
  offsetY?: number;
}): DisplayInfo {
  // 默认策略：窗口的左上角放在主屏右下角附近，让窗口大部分在屏外，但保留至少 ~40px 在屏内。
  // 这样 macOS WindowServer 仍把窗口当 visible 渲染，SCKit 能拿到完整 content。
  const peekPx = 40;
  const offX = opts.offsetX ?? Math.max(0, opts.primary.bounds.x + opts.primary.bounds.width - peekPx);
  const offY = opts.offsetY ?? Math.max(0, opts.primary.bounds.y + opts.primary.bounds.height - peekPx);
  return {
    id: "off-screen-workspace",
    bounds: { x: offX, y: offY, width: opts.width, height: opts.height },
    work_area: { x: offX, y: offY, width: opts.width, height: opts.height },
    scale: opts.primary.scale,
    dpi_x: opts.primary.dpi_x,
    dpi_y: opts.primary.dpi_y,
    refresh_rate_hz: opts.primary.refresh_rate_hz,
    is_primary: false,
    is_virtual: true,
    kind: "virtual",
    name: "vision-mcp peek-corner workspace",
    vendor: "vision-mcp",
    product: "off-screen-synth",
    recommended_for_workspace: true,
    native_handle: "off-screen",
  };
}

/** 给 CLI / UI 用的人类友好字符串。 */
export function describeDisplay(d: DisplayInfo): string {
  const kind = inferDisplayKind(d);
  const tag =
    kind === "virtual"
      ? "🖥️ virtual"
      : kind === "sidecar"
      ? "📱 sidecar"
      : kind === "airplay"
      ? "📡 airplay"
      : kind === "extended"
      ? "🖥️ extended"
      : kind === "primary"
      ? "⭐ primary"
      : kind === "mirror"
      ? "🪞 mirror"
      : "?";
  const name = d.name ? ` "${d.name}"` : "";
  return `${d.id}${name} ${tag} ${d.bounds.width}x${d.bounds.height}@${d.scale}x (work ${d.work_area.width}x${d.work_area.height})`;
}
