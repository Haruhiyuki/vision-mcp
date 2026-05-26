# @vision-mcp/server

Vision-MCP 的 MCP Server。基于 `@modelcontextprotocol/sdk@1.29`，把 `@vision-mcp/core` 封装为可被 Claude / Cursor / Codex 等 MCP host 直接调用的工具与资源。

## 安装与启动

```bash
npm install @vision-mcp/server
npx vision-mcp-server          # 启动 stdio server
```

或在代码中：

```ts
import {
  createServerContext,
  createVisionMcpServer,
  runStdio,
} from "@vision-mcp/server";

const ctx = await createServerContext({
  appsRoot: process.env.VISION_MCP_APPS_ROOT ?? "./apps",
  platformOptions: { platform: "auto", fallbackToMock: false },
});
const server = createVisionMcpServer(ctx);
await runStdio(server);
```

## 提供的工具（与设计文档 §13.2 对齐）

- `capsule.ensure_display`
- `capsule.attach_window`
- `capsule.migrate_window`
- `capsule.restore_window`
- `capsule.capture`
- `capsule.validate_geometry`
- `vision_map.list_apps`
- `vision_map.init`
- `vision_map.describe`
- `vision_map.detect_state`
- `vision_map.list_actions`
- `vision_map.describe_action`
- `vision_map.perform_action`
- `vision_map.run_workflow`
- `vision_map.verify`
- `vision_map.repair_minimal`
- `vision_map.apply_patch`
- `vision_map.export_trace`
- `vision_map.propose_controls`
- `vision_map.commit_state`

每个工具的 inputSchema 都是 zod 形态，host 通过 `listTools` 能获得标准 JSON schema。

## 提供的资源（§13.3）

- `vision-mcp://apps`
- `vision-mcp://apps/{app_id}/map`
- `vision-mcp://apps/{app_id}/states/{state_id}`
- `vision-mcp://apps/{app_id}/actions/{action_id}`
- `vision-mcp://apps/{app_id}/workflows/{workflow_id}`
- `vision-mcp://apps/{app_id}/patches`
- `vision-mcp://apps/{app_id}/traces/latest`

## 集成审批通道

`createServerContext` 接受 `approvalCallback`：

```ts
const ctx = await createServerContext({
  appsRoot: "./apps",
  approvalCallback: async (req) => {
    // 把 req.message 通过 UI 提示给用户；返回 granted / denied / expired
    return "granted";
  },
});
```

MCP host 若实现 elicitation，可在 callback 里把它接进来。
