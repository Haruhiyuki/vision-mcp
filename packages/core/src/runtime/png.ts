// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Vision-MCP Authors
import zlib from "node:zlib";

/**
 * 极简 PNG 编码器：8-bit RGBA、无滤波。
 * 入参 pixels 长度必须 = width * height * 4（RGBA）。
 * 输出可被任何 PNG 解码器读。
 *
 * 用在 trace asset 写入 + agent snapshot 等热路径，避免依赖 sharp 之类的 native lib。
 */
export function encodeRgbaToPng(
  width: number,
  height: number,
  pixels: Uint8Array,
): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8;
  ihdrData[9] = 6; // RGBA
  ihdrData[10] = 0;
  ihdrData[11] = 0;
  ihdrData[12] = 0;
  const ihdr = chunk("IHDR", ihdrData);
  const stride = width * 4;
  const filtered = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    filtered[y * (stride + 1)] = 0; // filter None
    Buffer.from(pixels.buffer, pixels.byteOffset + y * stride, stride).copy(
      filtered,
      y * (stride + 1) + 1,
    );
  }
  const idatData = zlib.deflateSync(filtered);
  const idat = chunk("IDAT", idatData);
  const iend = chunk("IEND", Buffer.alloc(0));
  return Buffer.concat([sig, ihdr, idat, iend]);
}

/**
 * 把 RGBA 帧按目标宽度等比降采样（box average，纯 JS）。
 * targetWidth >= 原宽时原样返回。给截图落盘/内联前减体积用。
 */
export function downscaleRgba(
  width: number,
  height: number,
  pixels: Uint8Array,
  targetWidth: number,
): { width: number; height: number; pixels: Uint8Array } {
  if (targetWidth <= 0 || targetWidth >= width) return { width, height, pixels };
  const outW = targetWidth;
  const outH = Math.max(1, Math.round((height * targetWidth) / width));
  const out = new Uint8Array(outW * outH * 4);
  const xRatio = width / outW;
  const yRatio = height / outH;
  for (let oy = 0; oy < outH; oy++) {
    const y0 = Math.floor(oy * yRatio);
    const y1 = Math.min(height, Math.max(y0 + 1, Math.floor((oy + 1) * yRatio)));
    for (let ox = 0; ox < outW; ox++) {
      const x0 = Math.floor(ox * xRatio);
      const x1 = Math.min(width, Math.max(x0 + 1, Math.floor((ox + 1) * xRatio)));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      const count = (x1 - x0) * (y1 - y0);
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const si = (sy * width + sx) * 4;
          r += pixels[si];
          g += pixels[si + 1];
          b += pixels[si + 2];
          a += pixels[si + 3];
        }
      }
      const di = (oy * outW + ox) * 4;
      out[di] = Math.round(r / count);
      out[di + 1] = Math.round(g / count);
      out[di + 2] = Math.round(b / count);
      out[di + 3] = Math.round(a / count);
    }
  }
  return { width: outW, height: outH, pixels: out };
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([len, body, crc]);
}

const CRC_TABLE: number[] = (() => {
  const t: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t.push(c >>> 0);
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
