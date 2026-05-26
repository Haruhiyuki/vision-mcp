import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { dumpMap } from "@vision-mcp/core";
import type { ServerContext } from "./context.js";
import { listApps, loadApp } from "./context.js";

const MIME_YAML = "application/yaml";
const MIME_JSON = "application/json";

/**
 * 注册 §13.3 描述的 vision-mcp:// 资源族。
 */
export function registerResources(server: McpServer, ctx: ServerContext): void {
  server.registerResource(
    "apps_index",
    "vision-mcp://apps",
    {
      title: "可用 app maps 列表",
      description: "扫描 apps_root 下所有 vision-mcp.yaml。",
      mimeType: MIME_JSON,
    },
    async (uri) => {
      const apps = await listApps(ctx);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: MIME_JSON,
            text: JSON.stringify(apps, null, 2),
          },
        ],
      };
    },
  );

  server.registerResource(
    "app_map",
    new ResourceTemplate("vision-mcp://apps/{app_id}/map", {
      list: async () => {
        const apps = await listApps(ctx);
        return {
          resources: apps.map((a) => ({
            uri: `vision-mcp://apps/${a.app_id}/map`,
            name: `map(${a.app_id})`,
            mimeType: MIME_YAML,
          })),
        };
      },
    }),
    {
      title: "vision-mcp.yaml 内容",
      description: "返回 baseline + 已应用 patches 的有效 map（YAML）。",
      mimeType: MIME_YAML,
    },
    async (uri, vars) => {
      const appId = String(vars.app_id);
      const app = await loadApp(ctx, appId);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: MIME_YAML,
            text: dumpMap(app.effective),
          },
        ],
      };
    },
  );

  server.registerResource(
    "app_state",
    new ResourceTemplate("vision-mcp://apps/{app_id}/states/{state_id}", {
      list: async () => {
        const apps = await listApps(ctx);
        const resources: { uri: string; name: string; mimeType: string }[] = [];
        for (const a of apps) {
          const app = await loadApp(ctx, a.app_id);
          for (const s of app.effective.states) {
            resources.push({
              uri: `vision-mcp://apps/${a.app_id}/states/${s.id}`,
              name: `${a.app_id}:${s.id}`,
              mimeType: MIME_JSON,
            });
          }
        }
        return { resources };
      },
    }),
    {
      title: "单个 state JSON",
      mimeType: MIME_JSON,
    },
    async (uri, vars) => {
      const app = await loadApp(ctx, String(vars.app_id));
      const state = app.effective.states.find((s) => s.id === String(vars.state_id));
      if (!state) {
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: MIME_JSON,
              text: JSON.stringify({ error: "state_not_found" }),
            },
          ],
        };
      }
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: MIME_JSON,
            text: JSON.stringify(state, null, 2),
          },
        ],
      };
    },
  );

  server.registerResource(
    "app_action",
    new ResourceTemplate("vision-mcp://apps/{app_id}/actions/{action_id}", {
      list: undefined,
    }),
    {
      title: "单个 action 描述",
      mimeType: MIME_JSON,
    },
    async (uri, vars) => {
      const app = await loadApp(ctx, String(vars.app_id));
      const actionId = String(vars.action_id);
      const lastDot = actionId.indexOf(".");
      const stateId = actionId.slice(0, lastDot);
      const controlId = actionId.slice(lastDot + 1).split(":", 1)[0];
      const state = app.effective.states.find((s) => s.id === stateId);
      const control = state?.controls.find((c) => c.id === controlId);
      if (!state || !control) {
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: MIME_JSON,
              text: JSON.stringify({ error: "action_not_found" }),
            },
          ],
        };
      }
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: MIME_JSON,
            text: JSON.stringify(
              {
                action_id: actionId,
                state: { id: state.id, kind: state.kind },
                control,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerResource(
    "app_workflow",
    new ResourceTemplate("vision-mcp://apps/{app_id}/workflows/{workflow_id}", {
      list: async () => {
        const apps = await listApps(ctx);
        const resources: { uri: string; name: string; mimeType: string }[] = [];
        for (const a of apps) {
          const app = await loadApp(ctx, a.app_id);
          for (const w of app.effective.workflows) {
            resources.push({
              uri: `vision-mcp://apps/${a.app_id}/workflows/${w.id}`,
              name: `${a.app_id}:${w.id}`,
              mimeType: MIME_JSON,
            });
          }
        }
        return { resources };
      },
    }),
    {
      title: "单个 workflow JSON",
      mimeType: MIME_JSON,
    },
    async (uri, vars) => {
      const app = await loadApp(ctx, String(vars.app_id));
      const wf = app.effective.workflows.find((w) => w.id === String(vars.workflow_id));
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: MIME_JSON,
            text: JSON.stringify(wf ?? { error: "workflow_not_found" }, null, 2),
          },
        ],
      };
    },
  );

  server.registerResource(
    "app_patches",
    new ResourceTemplate("vision-mcp://apps/{app_id}/patches", {
      list: undefined,
    }),
    {
      title: "已应用 patches 列表",
      mimeType: MIME_JSON,
    },
    async (uri, vars) => {
      const app = await loadApp(ctx, String(vars.app_id));
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: MIME_JSON,
            text: JSON.stringify({ count: app.patches.length, patches: app.patches }, null, 2),
          },
        ],
      };
    },
  );

  server.registerResource(
    "app_trace_latest",
    new ResourceTemplate("vision-mcp://apps/{app_id}/traces/latest", {
      list: undefined,
    }),
    {
      title: "最近一次会话的 trace 事件",
      mimeType: MIME_JSON,
    },
    async (uri, vars) => {
      const app = await loadApp(ctx, String(vars.app_id));
      if (!app.trace) {
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: MIME_JSON,
              text: JSON.stringify({ count: 0, sessions: [], events: [] }),
            },
          ],
        };
      }
      const sessions = await app.trace.listSessions();
      const latest = sessions[sessions.length - 1];
      const events = latest ? await app.trace.query({ sessionId: latest.id }) : [];
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: MIME_JSON,
            text: JSON.stringify({ session: latest, events }, null, 2),
          },
        ],
      };
    },
  );
}
