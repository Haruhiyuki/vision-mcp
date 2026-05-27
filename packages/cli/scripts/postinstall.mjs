#!/usr/bin/env node
// 跨平台 postinstall wrapper：
// - 不能让任何错误把 `npm install` 染红（用户体验差）
// - silent 模式跑 install-helper；不论成功 / 失败 / 异常都 exit 0

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cli = path.resolve(__dirname, "..", "dist", "index.js");

const child = spawn(process.execPath, [cli, "install-helper", "--silent"], {
  stdio: "inherit",
});

child.on("error", () => process.exit(0));
child.on("exit", () => process.exit(0)); // 永远 0
