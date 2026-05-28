#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Vision-MCP Authors
//
// 跨平台 prepublishOnly：clean + build + 删 dist 里的 .map / .tsbuildinfo
// 不依赖 Unix find / rm，Windows 维护者也能 npm publish。

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(__dirname, "..");

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: "inherit", shell: false, cwd: pkgRoot });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} exited ${r.status}`);
}

async function rmRf(p) {
  await fs.rm(p, { recursive: true, force: true });
}

async function walk(dir, predicate) {
  const out = [];
  async function visit(d) {
    let entries;
    try { entries = await fs.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await visit(p);
      else if (predicate(p)) out.push(p);
    }
  }
  await visit(dir);
  return out;
}

async function main() {
  console.log(`[prepublish] cwd=${pkgRoot}`);
  await rmRf(path.join(pkgRoot, "dist"));
  for (const e of await fs.readdir(pkgRoot)) {
    if (e.endsWith(".tsbuildinfo")) await fs.rm(path.join(pkgRoot, e), { force: true });
  }
  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  run(npx, ["tsc", "-b"]);
  const distDir = path.join(pkgRoot, "dist");
  const drops = await walk(distDir, (p) => p.endsWith(".map") || p.endsWith(".tsbuildinfo"));
  for (const f of drops) await fs.rm(f, { force: true });
  console.log(`[prepublish] ✅ done (dropped ${drops.length} .map/.tsbuildinfo)`);
}

main().catch((err) => {
  console.error("[prepublish] failed:", err);
  process.exit(1);
});
