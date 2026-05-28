// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Vision-MCP Authors
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "./tools.js";
import { registerResources } from "./resources.js";
import type { ServerContext } from "./context.js";

export interface VisionMcpServerInfo {
  name?: string;
  version?: string;
  description?: string;
}

export function createVisionMcpServer(
  ctx: ServerContext,
  info: VisionMcpServerInfo = {},
): McpServer {
  const server = new McpServer(
    {
      name: info.name ?? "vision-mcp",
      version: info.version ?? "0.1.0",
    },
    {
      capabilities: {
        tools: {},
        resources: { subscribe: false, listChanged: true },
        logging: {},
      },
      instructions:
        info.description ??
        [
          "Vision-MCP server：把 GUI 应用吸入视觉胶囊后通过 action_id 操作。",
          "首选用法：",
          "  1) vision_map.list_apps → 找到目标 app_id。",
          "  2) capsule.ensure_display + capsule.attach_window + capsule.migrate_window 建立胶囊。",
          "  3) vision_map.detect_state → vision_map.list_actions → vision_map.perform_action。",
          "  4) 失败时优先调用 vision_map.repair_minimal 走 repair ladder。",
          "高风险动作 (risk_level=requires_confirmation/destructive) 会要求 host 在审批通道中确认。",
        ].join("\n"),
    },
  );
  registerTools(server, ctx);
  registerResources(server, ctx);
  return server;
}
