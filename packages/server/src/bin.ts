#!/usr/bin/env node
import path from "node:path";
import { createServerContext } from "./context.js";
import { createVisionMcpServer } from "./server.js";
import { runStdio } from "./transport.js";

async function main() {
  const appsRoot =
    process.env.VISION_MCP_APPS_ROOT ?? path.resolve(process.cwd(), "apps");
  const traceDir =
    process.env.VISION_MCP_TRACE_DIR ?? path.join(appsRoot, ".traces");
  const fallback = process.env.VISION_MCP_FALLBACK_MOCK === "1";
  const helperPath = process.env.VISION_MCP_NATIVE_HELPER;
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
