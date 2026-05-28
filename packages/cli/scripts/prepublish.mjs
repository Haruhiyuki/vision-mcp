#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Vision-MCP Authors
// 跨平台 prepublishOnly：clean + build + 删冗余 + 复制 native/
// 不用 find / cp -R / rm 等 Unix 命令，确保 Windows 维护者也能跑 npm publish。

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cliRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(cliRoot, "..", "..");

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", shell: false, ...opts });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} exited ${r.status}`);
  }
}

async function rmRf(p) {
  await fs.rm(p, { recursive: true, force: true });
}

async function copyDir(src, dst) {
  // Node 16.7+ 有 fs.cp，仅 recursive 复制目录
  await fs.cp(src, dst, { recursive: true });
}

async function walk(dir, predicate) {
  const out = [];
  async function visit(d) {
    let entries;
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        await visit(p);
      } else if (predicate(p, e)) {
        out.push(p);
      }
    }
  }
  await visit(dir);
  return out;
}

async function main() {
  process.chdir(cliRoot);
  console.log(`[prepublish] cwd=${cliRoot}`);

  // 1. clean
  console.log(`[prepublish] clean dist + native`);
  await rmRf(path.join(cliRoot, "dist"));
  await rmRf(path.join(cliRoot, "native"));
  // 清理 *.tsbuildinfo（cli 目录本身）
  const tsbuildinfos = await walk(cliRoot, (p) => /tsbuildinfo$/.test(p));
  for (const f of tsbuildinfos) {
    if (f.includes(`${path.sep}node_modules${path.sep}`)) continue;
    await fs.rm(f, { force: true });
  }

  // 2. build
  console.log(`[prepublish] tsc -b`);
  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  run(npx, ["tsc", "-b"]);

  // 3. 删 dist 里的 .map / .tsbuildinfo（前面 tsc 又生成了）
  const distDir = path.join(cliRoot, "dist");
  const dropPatterns = await walk(distDir, (p) =>
    p.endsWith(".map") || p.endsWith(".tsbuildinfo"),
  );
  console.log(`[prepublish] drop ${dropPatterns.length} .map/.tsbuildinfo from dist`);
  for (const f of dropPatterns) await fs.rm(f, { force: true });

  // 4. 复制 repo 根 native/ → cli/native/
  const srcNative = path.join(repoRoot, "native");
  const dstNative = path.join(cliRoot, "native");
  console.log(`[prepublish] copy ${srcNative} → ${dstNative}`);
  await copyDir(srcNative, dstNative);

  // 5. 删 native 里已编译产物（macOS binary / Windows exe / Windows .ps1 编辑期缓存）
  const candidates = [
    path.join(dstNative, "macos", "vision-mcp-helper"),
    path.join(dstNative, "windows", "vision-mcp-helper.exe"),
  ];
  for (const c of candidates) await fs.rm(c, { force: true });

  console.log(`[prepublish] ✅ done`);
}

main().catch((err) => {
  console.error("[prepublish] failed:", err);
  process.exit(1);
});
