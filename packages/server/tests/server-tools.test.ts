// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Vision-MCP Authors
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

async function setupServerAndClient(
  appsRoot: string,
  mockInit?: { windows?: Array<{ title: string; process_name: string; bounds: { x: number; y: number; width: number; height: number } }> },
) {
  const ctx = await createServerContext({
    appsRoot,
    platformOptions: { platform: "mock", fallbackToMock: true, mockInit },
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
    const dStruct = describe.structuredContent as {
      states: number;
      states_summary: unknown[];
      workflows_summary: unknown[];
      app: { id: string; name: string; platform: string };
    };
    // 向后兼容：states/workflows 仍是数量
    expect(dStruct.states).toBe(0);
    // 新增：app metadata + 详细 summary 字段
    expect(dStruct.app.id).toBe("demo");
    expect(dStruct.app.name).toBe("Demo App");
    expect(Array.isArray(dStruct.states_summary)).toBe(true);
    expect(Array.isArray(dStruct.workflows_summary)).toBe(true);
  });

  it("list_workflows / describe_workflow 暴露 workflow 摘要 + 步骤详情", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vmcp-srv-"));
    const { client } = await setupServerAndClient(dir);
    // init 一个空 map（无 workflow）
    await client.callTool({
      name: "vision_map.init",
      arguments: { app_id: "wf-demo", name: "WF Demo", platform: "any" },
    });
    // list_workflows 应返回空数组（不报错）
    const list = await client.callTool({
      name: "vision_map.list_workflows",
      arguments: { app_id: "wf-demo" },
    });
    expect(list.isError).toBeFalsy();
    const ls = list.structuredContent as { workflows: unknown[] };
    expect(Array.isArray(ls.workflows)).toBe(true);
    expect(ls.workflows.length).toBe(0);
    // describe_workflow 不存在的 workflow 应该返回 isError
    const desc = await client.callTool({
      name: "vision_map.describe_workflow",
      arguments: { app_id: "wf-demo", workflow_id: "nonexistent" },
    });
    expect(desc.isError).toBe(true);
  });

  it("list_apps 含 name/platform/workflows 摘要（不是只 [{app_id, map_path}]）", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vmcp-srv-"));
    const { client } = await setupServerAndClient(dir);
    await client.callTool({
      name: "vision_map.init",
      arguments: { app_id: "rich-app", name: "Rich App", platform: "windows" },
    });
    const list = await client.callTool({ name: "vision_map.list_apps", arguments: {} });
    const ls = list.structuredContent as {
      apps: Array<{ app_id: string; name?: string; platform?: string; workflows?: unknown[] }>;
    };
    const rich = ls.apps.find((a) => a.app_id === "rich-app");
    expect(rich).toBeDefined();
    expect(rich!.name).toBe("Rich App");
    expect(rich!.platform).toBe("windows");
    expect(Array.isArray(rich!.workflows)).toBe(true);
  });

  it("quick-look：未 init 的 app_id 直接 attach → snapshot → restore → 再 attach", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vmcp-srv-"));
    const { client } = await setupServerAndClient(dir, {
      windows: [
        {
          title: "Quick Window",
          process_name: "quick.exe",
          bounds: { x: 50, y: 50, width: 800, height: 600 },
        },
      ],
    });

    // 没跑过 vision_map.init —— attach_window 应自动建临时会话并顺手 ensure display
    const attach = await client.callTool({
      name: "capsule.attach_window",
      arguments: { app_id: "quick", target_override: { process_name: "quick.exe" } },
    });
    expect(attach.isError).toBeFalsy();
    expect((attach.structuredContent as { ephemeral?: boolean }).ephemeral).toBe(true);

    const snap = await client.callTool({
      name: "vision_map.snapshot",
      arguments: { app_id: "quick", include_image: false, include_ocr: false },
    });
    expect(snap.isError).toBeFalsy();

    // restore 后缓存失效，重新 attach 一步到位（不必再 ensure_display）
    const restore = await client.callTool({
      name: "capsule.restore_window",
      arguments: { app_id: "quick" },
    });
    expect(restore.isError).toBeFalsy();
    const again = await client.callTool({
      name: "capsule.attach_window",
      arguments: { app_id: "quick", target_override: { process_name: "quick.exe" } },
    });
    expect(again.isError).toBeFalsy();

    // map 语义工具仍要求真实 map：ephemeral 会话上 perform_action 报 ACTION_NOT_FOUND
    const act = await client.callTool({
      name: "vision_map.perform_action",
      arguments: { app_id: "quick", action_id: "no.such" },
    });
    expect(act.isError).toBeTruthy();
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

  it("attach_window 失败不缓存坏句柄：quick-look 直接重试即可，无需 init", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vmcp-srv-"));
    const { client, ctx } = await setupServerAndClient(dir, {
      windows: [
        {
          title: "iPhone 17 Pro – iOS 26.1",
          process_name: "Simulator",
          bounds: { x: 0, y: 0, width: 442, height: 943 },
        },
      ],
    });

    // 无 map 的 app_id + 不匹配的 target → WINDOW_NOT_FOUND，
    // 且错误信息带「可枚举到窗口的进程」提示
    const fail = await client.callTool({
      name: "capsule.attach_window",
      arguments: { app_id: "ios-sim", target_override: { process_name: "NoSuchApp" } },
    });
    expect(fail.isError).toBeTruthy();
    expect(JSON.stringify(fail.content)).toContain("Simulator");

    // 失败后 quick-look 句柄（连同平台适配器）应被丢弃，而不是永久缓存坏适配器
    expect(ctx.apps.get("ios-sim")).toBeUndefined();

    // 不走 vision_map.init，直接改 target 重试就能吸附成功
    const ok = await client.callTool({
      name: "capsule.attach_window",
      arguments: { app_id: "ios-sim", target_override: { process_name: "Simulator" } },
    });
    expect(ok.isError).toBeFalsy();
    const structured = ok.structuredContent as {
      window: { process_name: string };
      ephemeral?: boolean;
    };
    expect(structured.window.process_name).toBe("Simulator");
    expect(structured.ephemeral).toBe(true);
  });
});
