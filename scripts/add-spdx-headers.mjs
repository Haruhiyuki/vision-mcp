#!/usr/bin/env node
// 给所有源文件加 SPDX-License-Identifier header（幂等）。
// 跑一次或在 pre-commit hook 里跑都安全。
//
// 用法: node scripts/add-spdx-headers.mjs [--check]
//   --check: 只检查不修改；缺 header 的文件返回 exit 1（CI 用）

import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const CHECK_ONLY = process.argv.includes("--check");

// 按扩展名给 header 模板。SPDX-License-Identifier + 版权 + 项目名 3 行。
const HEADER_FOR_EXT = {
  ".ts": [
    "// SPDX-License-Identifier: Apache-2.0",
    "// Copyright (C) 2026 Vision-MCP Authors",
    "",
  ].join("\n"),
  ".mjs": [
    "// SPDX-License-Identifier: Apache-2.0",
    "// Copyright (C) 2026 Vision-MCP Authors",
    "",
  ].join("\n"),
  ".swift": [
    "// SPDX-License-Identifier: Apache-2.0",
    "// Copyright (C) 2026 Vision-MCP Authors",
    "",
  ].join("\n"),
  ".ps1": [
    "# SPDX-License-Identifier: Apache-2.0",
    "# Copyright (C) 2026 Vision-MCP Authors",
    "",
  ].join("\n"),
};

// 排除目录（不递归进）
const SKIP_DIRS = new Set([
  "node_modules", "dist", ".git", "apps", ".traces", "patches",
  ".github",  // workflow yaml 没必要加 SPDX
]);

async function walk(dir, out = []) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      await walk(p, out);
    } else {
      const ext = path.extname(e.name);
      if (HEADER_FOR_EXT[ext]) out.push({ path: p, ext });
    }
  }
  return out;
}

async function processFile({ path: filePath, ext }) {
  const header = HEADER_FOR_EXT[ext];
  const content = await fs.readFile(filePath, "utf8");

  // 已有 SPDX 头 → 跳过
  if (content.includes("SPDX-License-Identifier")) {
    return { path: filePath, status: "ok" };
  }

  if (CHECK_ONLY) {
    return { path: filePath, status: "missing" };
  }

  // .ps1 special：保留 UTF-8 BOM 在最开头；header 在 BOM 后
  let prefix = "";
  let body = content;
  if (body.charCodeAt(0) === 0xfeff) {
    prefix = "﻿";
    body = body.slice(1);
  }

  // shebang 文件：header 在 shebang 后
  if (body.startsWith("#!")) {
    const nl = body.indexOf("\n");
    const shebang = body.slice(0, nl + 1);
    body = body.slice(nl + 1);
    await fs.writeFile(filePath, prefix + shebang + header + body);
  } else {
    await fs.writeFile(filePath, prefix + header + body);
  }
  return { path: filePath, status: "added" };
}

const files = await walk(repoRoot);
const results = await Promise.all(files.map(processFile));
const added = results.filter((r) => r.status === "added");
const missing = results.filter((r) => r.status === "missing");
const ok = results.filter((r) => r.status === "ok");

console.log(`Scanned ${results.length} source files:`);
console.log(`  ${ok.length} already had SPDX header`);
console.log(`  ${added.length} added`);
if (CHECK_ONLY) {
  console.log(`  ${missing.length} missing SPDX header:`);
  for (const m of missing) console.log(`    ${path.relative(repoRoot, m.path)}`);
  process.exit(missing.length > 0 ? 1 : 0);
} else {
  for (const a of added.slice(0, 10)) console.log(`    + ${path.relative(repoRoot, a.path)}`);
  if (added.length > 10) console.log(`    ... +${added.length - 10} more`);
}
