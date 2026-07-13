// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Vision-MCP Authors
import { describe, expect, it } from "vitest";
import {
  cropRgba,
  encodeRgbaToJpeg,
  frameStats,
  regionNormToPx,
} from "../src/runtime/image.js";

function makeFrame(w: number, h: number, fill: (x: number, y: number) => [number, number, number]): Uint8Array {
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = fill(x, y);
      const i = (y * w + x) * 4;
      px[i] = r;
      px[i + 1] = g;
      px[i + 2] = b;
      px[i + 3] = 255;
    }
  }
  return px;
}

describe("regionNormToPx", () => {
  it("归一化区域映射到像素并 clamp", () => {
    expect(regionNormToPx([0.25, 0.5, 0.5, 0.25], 400, 200)).toEqual({
      x: 100,
      y: 100,
      width: 200,
      height: 50,
    });
    // 越界区域 clamp 到帧内
    expect(regionNormToPx([0.9, 0.9, 0.5, 0.5], 100, 100)).toEqual({
      x: 90,
      y: 90,
      width: 10,
      height: 10,
    });
  });
});

describe("cropRgba", () => {
  it("裁剪返回目标区域像素", () => {
    // 左半黑右半白的 4x2 帧，裁右半
    const px = makeFrame(4, 2, (x) => (x < 2 ? [0, 0, 0] : [255, 255, 255]));
    const out = cropRgba(4, 2, px, { x: 2, y: 0, width: 2, height: 2 });
    expect(out.width).toBe(2);
    expect(out.height).toBe(2);
    expect(out.pixels[0]).toBe(255);
    expect(out.pixels[out.pixels.length - 4]).toBe(255);
  });

  it("整帧裁剪原样返回（零拷贝）", () => {
    const px = makeFrame(4, 4, () => [10, 20, 30]);
    const out = cropRgba(4, 4, px, { x: 0, y: 0, width: 4, height: 4 });
    expect(out.pixels).toBe(px);
  });

  it("越界 rect 自动 clamp", () => {
    const px = makeFrame(4, 4, () => [1, 2, 3]);
    const out = cropRgba(4, 4, px, { x: 3, y: 3, width: 10, height: 10 });
    expect(out.width).toBe(1);
    expect(out.height).toBe(1);
  });
});

describe("encodeRgbaToJpeg", () => {
  it("产出合法 JPEG（SOI/EOI marker）且明显小于原始像素", () => {
    const w = 64;
    const h = 64;
    const px = makeFrame(w, h, (x, y) => [x * 4, y * 4, 128]);
    const jpg = encodeRgbaToJpeg(w, h, px, 85);
    expect(jpg[0]).toBe(0xff);
    expect(jpg[1]).toBe(0xd8); // SOI
    expect(jpg[jpg.length - 2]).toBe(0xff);
    expect(jpg[jpg.length - 1]).toBe(0xd9); // EOI
    expect(jpg.length).toBeLessThan(px.length / 4);
  });
});

describe("frameStats", () => {
  it("纯色帧判定为 uniform", () => {
    const px = makeFrame(100, 100, () => [255, 255, 255]);
    const s = frameStats(100, 100, px);
    expect(s.uniform).toBe(true);
    expect(s.mean_luma).toBe(255);
  });

  it("有内容的帧不是 uniform", () => {
    const px = makeFrame(100, 100, (x) => (x % 7 === 0 ? [0, 0, 0] : [255, 255, 255]));
    const s = frameStats(100, 100, px);
    expect(s.uniform).toBe(false);
    expect(s.luma_range).toBeGreaterThan(200);
  });
});
