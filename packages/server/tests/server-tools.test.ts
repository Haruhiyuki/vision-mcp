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

  it("capsule.capture：region 裁剪 + jpeg 默认 + only_if_changed 短路 + uniform 提示", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vmcp-srv-"));
    const { client } = await setupServerAndClient(dir, {
      windows: [
        {
          title: "Cap Window",
          process_name: "cap.exe",
          bounds: { x: 0, y: 0, width: 800, height: 600 },
        },
      ],
    });
    await client.callTool({
      name: "capsule.attach_window",
      arguments: { app_id: "cap", target_override: { process_name: "cap.exe" } },
    });

    // 1) 整帧捕获：默认 jpeg + visual_hash；mock 纯白帧 → frame_uniform 提示
    const first = await client.callTool({
      name: "capsule.capture",
      arguments: { app_id: "cap" },
    });
    expect(first.isError).toBeFalsy();
    const f = first.structuredContent as {
      image_path: string;
      image_mime: string;
      image_width_px: number;
      visual_hash: string;
      frame_uniform?: boolean;
      unchanged?: boolean;
    };
    expect(f.image_mime).toBe("image/jpeg");
    expect(f.image_path.endsWith(".jpg")).toBe(true);
    expect(f.image_width_px).toBe(800);
    expect(f.visual_hash).toBeTruthy();
    expect(f.frame_uniform).toBe(true); // mock 合成帧为纯色
    expect(f.unchanged).toBeUndefined();

    // 2) region_norm 裁剪：右下四分之一 → 400x300
    const region = await client.callTool({
      name: "capsule.capture",
      arguments: { app_id: "cap", region_norm: [0.5, 0.5, 0.5, 0.5], format: "png" },
    });
    expect(region.isError).toBeFalsy();
    const r = region.structuredContent as {
      image_width_px: number;
      image_height_px: number;
      image_mime: string;
      changed_since_last?: boolean;
    };
    expect(r.image_width_px).toBe(400);
    expect(r.image_height_px).toBe(300);
    expect(r.image_mime).toBe("image/png");
    // mock 帧内容恒定 → 与上次一致
    expect(r.changed_since_last).toBe(false);

    // 3) only_if_changed：内容未变 → 不产新图
    const skip = await client.callTool({
      name: "capsule.capture",
      arguments: { app_id: "cap", only_if_changed: true },
    });
    expect(skip.isError).toBeFalsy();
    const s = skip.structuredContent as { unchanged?: boolean; last_image_path?: string; image_path?: string };
    expect(s.unchanged).toBe(true);
    expect(s.image_path).toBeUndefined();
    expect(s.last_image_path).toBeTruthy();

    // 4) max_image_width 降采样
    const scaled = await client.callTool({
      name: "capsule.capture",
      arguments: { app_id: "cap", max_image_width: 200 },
    });
    expect((scaled.structuredContent as { image_width_px: number }).image_width_px).toBe(200);
  });

  it("snapshot region_norm：图像裁剪到指定区域", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vmcp-srv-"));
    const { client } = await setupServerAndClient(dir, {
      windows: [
        {
          title: "Snap Window",
          process_name: "snap.exe",
          bounds: { x: 0, y: 0, width: 800, height: 600 },
        },
      ],
    });
    await client.callTool({
      name: "capsule.attach_window",
      arguments: { app_id: "snap", target_override: { process_name: "snap.exe" } },
    });
    const snap = await client.callTool({
      name: "vision_map.snapshot",
      arguments: {
        app_id: "snap",
        include_ocr: false,
        region_norm: [0, 0, 0.25, 0.5],
      },
    });
    expect(snap.isError).toBeFalsy();
    const s = snap.structuredContent as {
      image_width_px?: number;
      image_height_px?: number;
      region_norm?: number[];
    };
    expect(s.image_width_px).toBe(200);
    expect(s.image_height_px).toBe(300);
    expect(s.region_norm).toEqual([0, 0, 0.25, 0.5]);
  });

  it("raw 动作反馈：click/scroll 返回 content_changed；feedback=false 跳过", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vmcp-srv-"));
    const { client } = await setupServerAndClient(dir, {
      windows: [
        {
          title: "Act Window",
          process_name: "act.exe",
          bounds: { x: 0, y: 0, width: 800, height: 600 },
        },
      ],
    });
    await client.callTool({
      name: "capsule.attach_window",
      arguments: { app_id: "act", target_override: { process_name: "act.exe" } },
    });

    // mock 帧内容恒定 → 点击后画面无变化，反馈应明确说出来
    const click = await client.callTool({
      name: "vision_map.click_at",
      arguments: { app_id: "act", point_norm: [0.5, 0.5], settle_ms: 0 },
    });
    expect(click.isError).toBeFalsy();
    const c = click.structuredContent as {
      content_changed?: boolean;
      visual_similarity?: number;
    };
    expect(c.content_changed).toBe(false);
    expect(c.visual_similarity).toBe(1);
    expect(JSON.stringify(click.content)).toContain("画面无变化");

    const scroll = await client.callTool({
      name: "vision_map.scroll",
      arguments: { app_id: "act", point_norm: [0.5, 0.5], dy_px: 240, settle_ms: 0 },
    });
    expect(scroll.isError).toBeFalsy();
    expect((scroll.structuredContent as { content_changed?: boolean }).content_changed).toBe(false);

    // feedback=false：不产生对比字段、无额外捕获
    const fast = await client.callTool({
      name: "vision_map.click_at",
      arguments: { app_id: "act", point_norm: [0.5, 0.5], feedback: false },
    });
    expect(fast.isError).toBeFalsy();
    const f = fast.structuredContent as { content_changed?: boolean };
    expect(f.content_changed).toBeUndefined();

    // press_key / type_text 同样带反馈字段
    const key = await client.callTool({
      name: "vision_map.press_key",
      arguments: { app_id: "act", combo: "return", settle_ms: 0 },
    });
    expect((key.structuredContent as { content_changed?: boolean }).content_changed).toBe(false);
    const type = await client.callTool({
      name: "vision_map.type_text",
      arguments: { app_id: "act", text: "hello", settle_ms: 0 },
    });
    expect((type.structuredContent as { content_changed?: boolean }).content_changed).toBe(false);
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
