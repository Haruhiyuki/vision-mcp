import type { Frame } from "../capsule/types.js";
import type { VisualHashProvider } from "./types.js";

/**
 * 简化版 dHash 实现：把帧缩放到 9x8 灰度，对每行相邻像素做大小比较，得到 64-bit hash。
 * 仅依赖 RGBA buffer，无外部依赖。
 *
 * 对小幅亮度/位置变化稳健，是 state 锚点 visual_hash anchor 的默认实现。
 */
export class DHashProvider implements VisualHashProvider {
  async hash(frame: Frame): Promise<string> {
    return computeDHash(frame);
  }
  similarity(a: string, b: string): number {
    return 1 - hammingDistance(a, b) / 64;
  }
}

export function computeDHash(frame: Frame): string {
  const w = 9;
  const h = 8;
  const gray = resampleToGray(frame, w, h);
  let bits = 0n;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w - 1; x++) {
      const left = gray[y * w + x];
      const right = gray[y * w + x + 1];
      bits <<= 1n;
      if (left > right) bits |= 1n;
    }
  }
  return bits.toString(16).padStart(16, "0");
}

export function hammingDistance(a: string, b: string): number {
  if (a.length !== b.length) {
    // 不同长度直接给最大差，避免崩溃
    return 64;
  }
  let x = BigInt("0x" + a) ^ BigInt("0x" + b);
  let count = 0;
  while (x > 0n) {
    if (x & 1n) count++;
    x >>= 1n;
  }
  return count;
}

function resampleToGray(frame: Frame, dstW: number, dstH: number): Uint8Array {
  const { width_px: sw, height_px: sh, pixels } = frame;
  const out = new Uint8Array(dstW * dstH);
  for (let y = 0; y < dstH; y++) {
    const sy = Math.floor((y * sh) / dstH);
    for (let x = 0; x < dstW; x++) {
      const sx = Math.floor((x * sw) / dstW);
      const idx = (sy * sw + sx) * 4;
      const r = pixels[idx] ?? 0;
      const g = pixels[idx + 1] ?? 0;
      const b = pixels[idx + 2] ?? 0;
      // Rec. 601 luma
      out[y * dstW + x] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
    }
  }
  return out;
}
