import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export async function runStdio(server: McpServer): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // 进程在 stdio 关闭前不退出
  await new Promise<void>((resolve) => {
    process.stdin.on("end", resolve);
    process.on("SIGINT", () => resolve());
    process.on("SIGTERM", () => resolve());
  });
}
