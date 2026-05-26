import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createServerContext,
  createVisionMcpServer,
} from "@vision-mcp/server";
import {
  Client,
} from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

async function setupServerAndClient(appsRoot: string) {
  const ctx = await createServerContext({
    appsRoot,
    platformOptions: { platform: "mock", fallbackToMock: true },
  });
  const server = createVisionMcpServer(ctx);
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.1" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server, ctx };
}

describe("MCP server end-to-end (mock platform)", () => {
  it("list_apps → init → describe → list_actions", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vmcp-srv-"));
    const { client } = await setupServerAndClient(dir);

    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    expect(names).toContain("vision_map.list_apps");
    expect(names).toContain("vision_map.perform_action");

    const init = await client.callTool({
      name: "vision_map.init",
      arguments: { app_id: "demo", name: "Demo App", platform: "any" },
    });
    expect(init.isError).toBeFalsy();

    const list = await client.callTool({
      name: "vision_map.list_apps",
      arguments: {},
    });
    const structured = list.structuredContent as { apps: Array<{ app_id: string }> };
    expect(structured.apps.some((a) => a.app_id === "demo")).toBe(true);

    const describe = await client.callTool({
      name: "vision_map.describe",
      arguments: { app_id: "demo" },
    });
    expect(describe.isError).toBeFalsy();
    const dStruct = describe.structuredContent as { states: number };
    expect(dStruct.states).toBe(0);
  });

  it("perform_action 在没有可匹配 state 时返回 LOCATOR_FAILED 或 STATE_UNKNOWN", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vmcp-srv-"));
    const { client } = await setupServerAndClient(dir);

    await client.callTool({
      name: "vision_map.init",
      arguments: { app_id: "demo2", name: "Demo App", platform: "any" },
    });
    // 没有 attach window → capsule.validate_geometry 会失败；perform_action 也会返回 error
    const r = await client.callTool({
      name: "vision_map.perform_action",
      arguments: { app_id: "demo2", action_id: "no.such" },
    });
    expect(r.isError).toBeTruthy();
  });
});
