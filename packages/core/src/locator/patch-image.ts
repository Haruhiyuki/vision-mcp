import { promises as fs } from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import type { Frame } from "../capsule/types.js";
import type { BBoxNorm } from "../schema/index.js";
import type { PatchImageProvider } from "./types.js";

/**
 * 默认 image_patch locator 实现：
 *   - 从磁盘加载 patch PNG → 解码为 RGBA → 计算 dHash（9×8 = 64 bit）。
 *   - 在 frame 上滑窗找最相似的位置：把 frame 切成与 patch 同大小的网格，每格算 dHash，
 *     与 patch hash hamming 距离最小的位置就是 match。
 *   - 相似度 = 1 - hamming/64；超过 min_similarity 视为命中。
 *
 * 设计取舍：dHash 滑窗比像素 NCC 快 ~10x，对小幅光照/缩放变化更稳。
 * 对完全像素级精确匹配不如 NCC，但对 icon / 按钮匹配足够。
 */
export class DefaultPatchImageProvider implements PatchImageProvider {
  private cache = new Map<string, { hash: string; w: number; h: number }>();

  async search(
    frame: Frame,
    patch: { file: string; min_similarity: number },
    baseDir: string,
  ): Promise<{ bbox_norm: BBoxNorm; similarity: number } | null> {
    const cacheKey = path.resolve(baseDir, patch.file);
    let pd = this.cache.get(cacheKey);
    if (!pd) {
      try {
        const buf = await fs.readFile(cacheKey);
        const dec = decodePng(buf);
        if (!dec) return null;
        const ph = dHashRgba(dec.pixels, dec.width, dec.height);
        pd = { hash: ph, w: dec.width, h: dec.height };
        this.cache.set(cacheKey, pd);
      } catch {
        return null;
      }
    }
    // 在 frame 上以 patch 同大小为步进做滑窗（步长 = patch.w/2 提速）
    const fw = frame.width_px;
    const fh = frame.height_px;
    const pw = pd.w;
    const ph = pd.h;
    if (pw > fw || ph > fh) return null;
    const stepX = Math.max(4, Math.floor(pw / 2));
    const stepY = Math.max(4, Math.floor(ph / 2));
    let bestSim = -1;
    let bestPos = { x: 0, y: 0 };
    for (let y = 0; y + ph <= fh; y += stepY) {
      for (let x = 0; x + pw <= fw; x += stepX) {
        const sub = sliceRgba(frame.pixels, fw, x, y, pw, ph);
        const h = dHashRgba(sub, pw, ph);
        const dist = hamming(h, pd.hash);
        const sim = 1 - dist / 64;
        if (sim > bestSim) {
          bestSim = sim;
          bestPos = { x, y };
        }
      }
    }
    if (bestSim < patch.min_similarity) return null;
    const bbox_norm: BBoxNorm = [
      bestPos.x / fw,
      bestPos.y / fh,
      pw / fw,
      ph / fh,
    ];
    return { bbox_norm, similarity: bestSim };
  }
}

/** dHash 9x8 灰度版（与 visual-hash.ts 相同算法，但接受任意 RGBA buffer + 尺寸）。 */
function dHashRgba(pixels: Uint8Array, srcW: number, srcH: number): string {
  const w = 9, h = 8;
  const gray = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const sy = Math.floor((y * srcH) / h);
    for (let x = 0; x < w; x++) {
      const sx = Math.floor((x * srcW) / w);
      const idx = (sy * srcW + sx) * 4;
      const r = pixels[idx] ?? 0;
      const g = pixels[idx + 1] ?? 0;
      const b = pixels[idx + 2] ?? 0;
      gray[y * w + x] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
    }
  }
  let bits = 0n;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w - 1; x++) {
      bits <<= 1n;
      if (gray[y * w + x] > gray[y * w + x + 1]) bits |= 1n;
    }
  }
  return bits.toString(16).padStart(16, "0");
}

function hamming(a: string, b: string): number {
  if (a.length !== b.length) return 64;
  let x = BigInt("0x" + a) ^ BigInt("0x" + b);
  let count = 0;
  while (x > 0n) {
    if (x & 1n) count++;
    x >>= 1n;
  }
  return count;
}

function sliceRgba(
  src: Uint8Array,
  srcW: number,
  x0: number,
  y0: number,
  w: number,
  h: number,
): Uint8Array {
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const srcOff = ((y0 + y) * srcW + x0) * 4;
    const dstOff = y * w * 4;
    out.set(src.subarray(srcOff, srcOff + w * 4), dstOff);
  }
  return out;
}

function decodePng(buf: Buffer): { width: number; height: number; pixels: Uint8Array } | null {
  if (
    buf.length < 8 ||
    buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47
  ) return null;
  let off = 8, width = 0, height = 0, bitDepth = 0, colorType = 0;
  const idats: Buffer[] = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === "IDAT") {
      idats.push(data);
    } else if (type === "IEND") break;
    off += 12 + len;
  }
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) return null;
  const channels = colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idats));
  const stride = width * channels;
  const pixels = new Uint8Array(width * height * 4);
  let src = 0;
  let prevLine = new Uint8Array(stride);
  const currLine = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[src++];
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? currLine[i - channels] : 0;
      const b = prevLine[i];
      const c = i >= channels ? prevLine[i - channels] : 0;
      let v = raw[src + i];
      switch (filter) {
        case 1: v = (v + a) & 0xff; break;
        case 2: v = (v + b) & 0xff; break;
        case 3: v = (v + Math.floor((a + b) / 2)) & 0xff; break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
          break;
        }
      }
      currLine[i] = v;
    }
    src += stride;
    for (let x = 0; x < width; x++) {
      const di = (y * width + x) * 4;
      const si = x * channels;
      pixels[di] = currLine[si];
      pixels[di + 1] = currLine[si + 1];
      pixels[di + 2] = currLine[si + 2];
      pixels[di + 3] = channels === 4 ? currLine[si + 3] : 255;
    }
    prevLine.set(currLine);
  }
  return { width, height, pixels };
}
