// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Vision-MCP Authors
import type {
  BBoxNorm,
  ContractRules,
  PointNorm,
  VisualBox,
} from "../schema/index.js";
import type {
  DisplayInfo,
  GeometryState,
  RectPx,
  WindowInfo,
} from "./types.js";

/**
 * 把 capsule client rect 中的归一化 bbox 解到屏幕像素 bbox。
 */
export function denormalizeBBox(
  bbox: BBoxNorm,
  clientRect: RectPx,
): RectPx {
  return {
    x: Math.round(clientRect.x + bbox[0] * clientRect.width),
    y: Math.round(clientRect.y + bbox[1] * clientRect.height),
    width: Math.max(1, Math.round(bbox[2] * clientRect.width)),
    height: Math.max(1, Math.round(bbox[3] * clientRect.height)),
  };
}

export function denormalizePoint(
  point: PointNorm,
  clientRect: RectPx,
): { x: number; y: number } {
  return {
    x: Math.round(clientRect.x + point[0] * clientRect.width),
    y: Math.round(clientRect.y + point[1] * clientRect.height),
  };
}

export function normalizeRect(rect: RectPx, clientRect: RectPx): BBoxNorm {
  return [
    (rect.x - clientRect.x) / clientRect.width,
    (rect.y - clientRect.y) / clientRect.height,
    rect.width / clientRect.width,
    rect.height / clientRect.height,
  ];
}

/**
 * 给定 visual_box.contract 与当前 display/window，产出 GeometryState。
 * 此函数是平台无关的纯函数，由 platform adapter 提供原始信息。
 */
export function buildGeometryState(args: {
  visualBox: VisualBox;
  contract: ContractRules;
  display: DisplayInfo;
  window: WindowInfo;
}): GeometryState {
  const { visualBox, contract, display, window: win } = args;
  const violations: string[] = [];
  const warnings: string[] = [];

  const expected = visualBox.display;
  // 仅当 contract 显式要求尺寸时才检查——没写 require_client_size_px 就是"不关心尺寸"
  //（quick-look / 骨架 map 场景），不再拿 display 期望尺寸兜底误报。
  const sizeMatch = (() => {
    const req = contract.require_client_size_px;
    if (!req) return true;
    const dw = Math.abs(win.client_bounds.width - req[0]);
    const dh = Math.abs(win.client_bounds.height - req[1]);
    const delta = Math.max(dw, dh);
    if (delta <= contract.tolerate_client_size_delta_px) return true;
    const msg = `client size 不匹配：实际 ${win.client_bounds.width}x${win.client_bounds.height} ≠ 期望 ${req[0]}x${req[1]}`;
    // 菜单栏/标题栏挤压量级的差异：warning，不阻塞 ok
    if (delta <= contract.warn_client_size_delta_px) {
      warnings.push(msg);
      return true;
    }
    violations.push(msg);
    return false;
  })();

  // scale / DPI 是显示器固有属性（Retina 恒为 2 / 144），和 map 期望不一致
  // 不代表操作会失败——降为 warning，避免每次 migrate/snapshot 刷屏。
  const scaleMatch = Math.abs(display.scale - expected.scale) < 0.01;
  if (!scaleMatch) {
    warnings.push(`scale 不匹配：实际 ${display.scale} ≠ 期望 ${expected.scale}`);
  }

  const dpiMatch =
    display.dpi_x === expected.dpi_x && display.dpi_y === expected.dpi_y;
  if (!dpiMatch) {
    warnings.push(
      `DPI 不匹配：实际 ${display.dpi_x}x${display.dpi_y} ≠ 期望 ${expected.dpi_x}x${expected.dpi_y}`,
    );
  }

  if (contract.require_unminimized && win.is_minimized) {
    violations.push("窗口处于最小化状态");
  }

  const foregroundMatch =
    !contract.require_foreground_for_input || win.is_foreground;
  if (!foregroundMatch) {
    violations.push("窗口未处于前台，无法接受输入");
  }

  if (contract.require_same_display) {
    if (win.display_id && display.id !== win.display_id) {
      violations.push(
        `窗口已离开 capsule 显示器：当前在 ${win.display_id} ≠ ${display.id}`,
      );
    }
  }

  return {
    display,
    window: win,
    client_rect_px: win.client_bounds,
    scale_match: scaleMatch,
    size_match: sizeMatch,
    dpi_match: dpiMatch,
    foreground_match: foregroundMatch,
    ok: violations.length === 0,
    violations,
    warnings,
  };
}

/**
 * 计算把目标窗口放进 display 工作区的目标矩形。
 * 默认居中并保持期望的 client size；如果 work_area 不够大，按比例缩小并发出 warning。
 */
export function planMigrationRect(
  display: DisplayInfo,
  expectedClientSize: { width: number; height: number },
  windowNonClientPadding: { dx: number; dy: number } = { dx: 0, dy: 0 },
): { rect: RectPx; warning?: string } {
  const wa = display.work_area;
  let w = expectedClientSize.width + windowNonClientPadding.dx;
  let h = expectedClientSize.height + windowNonClientPadding.dy;
  let warning: string | undefined;
  if (w > wa.width || h > wa.height) {
    const scale = Math.min(wa.width / w, wa.height / h, 1);
    w = Math.floor(w * scale);
    h = Math.floor(h * scale);
    warning = `capsule work area ${wa.width}x${wa.height} 不足以容纳期望尺寸，已按 ${scale.toFixed(
      2,
    )} 缩放`;
  }
  const x = wa.x + Math.floor((wa.width - w) / 2);
  const y = wa.y + Math.floor((wa.height - h) / 2);
  return { rect: { x, y, width: w, height: h }, warning };
}
