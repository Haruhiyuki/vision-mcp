// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Vision-MCP Authors
import jpegJs from "jpeg-js";

/**
 * RGBA 帧的区域裁剪 / JPEG 编码 / 空白帧统计。
 *
 * 这些是截图成本控制的基础件：
 *  - crop：区域截图（agent 大多数确认只需看一小块，整窗大图纯浪费 token）
 *  - jpeg：UI 截图 JPEG q85 比无滤波 PNG 小 5–10×（磁盘/传输；host 端 token
 *    由像素分辨率决定，与格式无关——降 token 靠 crop + 降采样，不靠换格式）
 *  - stats：均匀色帧检测（窗口句柄失效/被遮挡时静默拿到纯色图，必须能识别）
 */

export interface PxRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 归一化区域 [x, y, w, h]（0..1，相对帧）→ 像素 rect，自动 clamp 到帧内。 */
export function regionNormToPx(
  region: readonly [number, number, number, number],
  frameWidth: number,
  frameHeight: number,
): PxRect {
  const x = Math.max(0, Math.min(frameWidth - 1, Math.round(region[0] * frameWidth)));
  const y = Math.max(0, Math.min(frameHeight - 1, Math.round(region[1] * frameHeight)));
  const width = Math.max(1, Math.min(frameWidth - x, Math.round(region[2] * frameWidth)));
  const height = Math.max(1, Math.min(frameHeight - y, Math.round(region[3] * frameHeight)));
  return { x, y, width, height };
}

/** 从 RGBA buffer 裁出矩形区域（rect 会先 clamp 到帧内）。 */
export function cropRgba(
  width: number,
  height: number,
  pixels: Uint8Array,
  rect: PxRect,
): { width: number; height: number; pixels: Uint8Array } {
  const x = Math.max(0, Math.min(width - 1, Math.floor(rect.x)));
  const y = Math.max(0, Math.min(height - 1, Math.floor(rect.y)));
  const w = Math.max(1, Math.min(width - x, Math.floor(rect.width)));
  const h = Math.max(1, Math.min(height - y, Math.floor(rect.height)));
  if (x === 0 && y === 0 && w === width && h === height) {
    return { width, height, pixels };
  }
  const out = new Uint8Array(w * h * 4);
  for (let row = 0; row < h; row++) {
    const srcStart = ((y + row) * width + x) * 4;
    out.set(pixels.subarray(srcStart, srcStart + w * 4), row * w * 4);
  }
  return { width: w, height: h, pixels: out };
}

/** RGBA → JPEG（jpeg-js 纯 JS 编码，无 native 依赖）。quality 1–100。 */
export function encodeRgbaToJpeg(
  width: number,
  height: number,
  pixels: Uint8Array,
  quality = 85,
): Buffer {
  const q = Math.max(1, Math.min(100, Math.round(quality)));
  const { data } = jpegJs.encode(
    { data: Buffer.from(pixels.buffer, pixels.byteOffset, width * height * 4), width, height },
    q,
  );
  return Buffer.from(data);
}

export interface FrameStats {
  /** 采样像素是否（近似）全为同一颜色——句柄失效/遮挡的典型产物。 */
  uniform: boolean;
  /** 采样均值亮度 0–255。 */
  mean_luma: number;
  /** 采样亮度极差（max-min）。<=2 视为 uniform（容忍压缩噪声）。 */
  luma_range: number;
}

/**
 * 均匀色帧检测：等距采样至多 ~4096 像素，看亮度极差。
 * 纯色帧（黑/白/灰）意味着几乎肯定没拍到目标内容——调用方应显式提示而非让
 * agent 读一张白图后自己纳闷。
 */
export function frameStats(
  width: number,
  height: number,
  pixels: Uint8Array,
): FrameStats {
  const total = width * height;
  const step = Math.max(1, Math.floor(total / 4096));
  let min = 255;
  let max = 0;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < total; i += step) {
    const idx = i * 4;
    const luma = Math.round(
      0.299 * pixels[idx] + 0.587 * pixels[idx + 1] + 0.114 * pixels[idx + 2],
    );
    if (luma < min) min = luma;
    if (luma > max) max = luma;
    sum += luma;
    count++;
  }
  const range = count > 0 ? max - min : 0;
  return {
    uniform: count > 0 && range <= 2,
    mean_luma: count > 0 ? Math.round(sum / count) : 0,
    luma_range: range,
  };
}
