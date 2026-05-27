#!/usr/bin/env node
import path from "node:path";
import { promises as fs } from "node:fs";
import { createServerContext } from "./context.js";
import { createVisionMcpServer } from "./server.js";
import { runStdio } from "./transport.js";

async function checkHelper(helperPath?: string): Promise<void> {
  const platform = process.platform;
  if (platform !== "darwin" && platform !== "win32") return; // 其他平台仅 mock

  // 尝试解析 helper 路径
  let resolved: string | undefined = helperPath;
  if (!resolved) {
    // 默认搜索 native/<platform>/vision-mcp-helper(.exe)
    const cliRoot = path.resolve(
      path.dirname(new URL(import.meta.url).pathname),
      "..", "..", "..",
    );
    const guesses = platform === "darwin"
      ? [
          path.join(cliRoot, "native", "macos", "vision-mcp-helper"),
          path.join(cliRoot, "..", "native", "macos", "vision-mcp-helper"),
        ]
      : [
          path.join(cliRoot, "native", "windows", "vision-mcp-helper.exe"),
          path.join(cliRoot, "..", "native", "windows", "vision-mcp-helper.exe"),
        ];
    for (const g of guesses) {
      try {
        await fs.access(g, fs.constants.X_OK);
        resolved = g;
        break;
      } catch { /* try next */ }
    }
  }

  if (!resolved) {
    process.stderr.write(
      `[vision-mcp-server] ⚠️  native helper 未找到。capsule.* / input.* / capture.* 将失败。\n` +
        `   首次运行请执行：vision-mcp install-helper\n` +
        `   或设置 VISION_MCP_NATIVE_HELPER 指向已有 helper 路径。\n`,
    );
    return;
  }

  try {
    await fs.access(resolved, fs.constants.X_OK);
  } catch {
    process.stderr.write(
      `[vision-mcp-server] ⚠️  native helper "${resolved}" 不存在或不可执行。\n` +
        `   重新编译：vision-mcp install-helper --force\n`,
    );
  }
}

async function main() {
  const appsRoot =
    process.env.VISION_MCP_APPS_ROOT ?? path.resolve(process.cwd(), "apps");
  const traceDir =
    process.env.VISION_MCP_TRACE_DIR ?? path.join(appsRoot, ".traces");
  const fallback = process.env.VISION_MCP_FALLBACK_MOCK === "1";
  const helperPath = process.env.VISION_MCP_NATIVE_HELPER;

  await checkHelper(helperPath);

  const ctx = await createServerContext({
    appsRoot,
    traceDir,
    platformOptions: {
      platform: (process.env.VISION_MCP_PLATFORM as "auto" | "windows" | "macos" | "mock") ?? "auto",
      fallbackToMock: fallback,
      helperPath,
    },
  });
  const server = createVisionMcpServer(ctx);
  await runStdio(server);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[vision-mcp-server] fatal:", err);
  process.exit(1);
});
