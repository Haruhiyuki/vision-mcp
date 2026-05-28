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
      title: "可用 app maps 列表（含 metadata + workflows 摘要）",
      description:
        "扫描 apps_root 下所有 vision-mcp.yaml。每个 app 返回 name/platform/description + " +
        "workflows 摘要（id+description+destructive 标志）。agent 启动时第一调；" +
        "决定 app 后调 vision-mcp://apps/{id}/summary 拿 state/region 摘要。",
      mimeType: MIME_JSON,
    },
    async (uri) => {
      const apps = await listApps(ctx);
      const enriched: unknown[] = [];
      for (const a of apps) {
        try {
          const app = await loadApp(ctx, a.app_id);
          enriched.push({
            app_id: a.app_id,
            name: app.effective.app.name,
            platform: app.effective.app.platform,
            description: app.effective.app.description?.split("\n")[0],
            states_count: app.effective.states.length,
            workflows: app.effective.workflows.map((w) => ({
              id: w.id,
              description: w.description,
            })),
          });
        } catch (err) {
          enriched.push({ app_id: a.app_id, error: (err as Error).message.split("\n")[0] });
        }
      }
      return {
        contents: [
          { uri: uri.href, mimeType: MIME_JSON, text: JSON.stringify(enriched, null, 2) },
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
      title: "vision-mcp.yaml 全文（context bomb 警告：500+ 行）",
      description:
        "返回 baseline + 已应用 patches 的有效 map（YAML 全文）。" +
        "**只在确实需要看全 locator 细节时拉**；日常用 .../summary 或 vision_map.describe 工具。",
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

  // 紧凑 summary：app description + regions/states/workflows 摘要，
  // 不含 controls / locator_priority / postcondition 等细节。
  // agent 看完决定调哪个 workflow 后用 describe_workflow / describe_action 拿细节。
  server.registerResource(
    "app_summary",
    new ResourceTemplate("vision-mcp://apps/{app_id}/summary", {
      list: async () => {
        const apps = await listApps(ctx);
        return {
          resources: apps.map((a) => ({
            uri: `vision-mcp://apps/${a.app_id}/summary`,
            name: `summary(${a.app_id})`,
            mimeType: MIME_JSON,
          })),
        };
      },
    }),
    {
      title: "app 紧凑摘要（推荐 agent 入口）",
      description:
        "返回 app 元数据 + regions/states/workflows 摘要（每项 id+description+计数），" +
        "不含 controls / locator 细节。比拉全 yaml 节省 ~80% context。",
      mimeType: MIME_JSON,
    },
    async (uri, vars) => {
      const app = await loadApp(ctx, String(vars.app_id));
      const m = app.effective;
      const summary = {
        app: {
          id: m.app.id,
          name: m.app.name,
          platform: m.app.platform,
          description: m.app.description,
        },
        visual_box: { id: m.visual_box.id, mode: m.visual_box.mode, display: m.visual_box.display },
        regions: (m.regions ?? []).map((r) => ({
          id: r.id,
          description: r.description,
          controls_count: r.controls.length,
        })),
        states: m.states.map((s) => ({
          id: s.id,
          kind: s.kind,
          description: s.description,
          controls_count: s.controls.length,
          inherit_regions: s.inherit_regions,
          parent_state_id: s.parent_state_id,
        })),
        workflows: m.workflows.map((w) => ({
          id: w.id,
          description: w.description,
          steps_count: w.steps.length,
          inputs: w.inputs?.map((i) => i.name),
          timeout_ms: w.timeout_ms,
        })),
        patches_count: app.patches.length,
        next_steps: [
          `调 vision_map.describe_workflow(${m.app.id}, <workflow_id>) 看具体步骤`,
          `调 vision_map.list_actions(${m.app.id}, state_id) 看 state 的可用 actions`,
          `调 vision_map.run_workflow(${m.app.id}, <workflow_id>, inputs) 直接执行`,
        ],
      };
      return {
        contents: [
          { uri: uri.href, mimeType: MIME_JSON, text: JSON.stringify(summary, null, 2) },
        ],
      };
    },
  );

  // workflows 索引：list 所有 workflow 概览，每个有 id + description + destructive + inputs
  server.registerResource(
    "app_workflows_index",
    new ResourceTemplate("vision-mcp://apps/{app_id}/workflows", {
      list: async () => {
        const apps = await listApps(ctx);
        return {
          resources: apps.map((a) => ({
            uri: `vision-mcp://apps/${a.app_id}/workflows`,
            name: `workflows(${a.app_id})`,
            mimeType: MIME_JSON,
          })),
        };
      },
    }),
    {
      title: "app 的 workflows 索引",
      description: "列出 app 所有 workflow 的 id+description+inputs+destructive 标志；不含 steps 细节。",
      mimeType: MIME_JSON,
    },
    async (uri, vars) => {
      const app = await loadApp(ctx, String(vars.app_id));
      const items = app.effective.workflows.map((w) => ({
        id: w.id,
        description: w.description,
        inputs: w.inputs,
        steps_count: w.steps.length,
        timeout_ms: w.timeout_ms,
      }));
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: MIME_JSON,
            text: JSON.stringify({ count: items.length, workflows: items }, null, 2),
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
      title: "单个 state 完整 JSON（含 controls + anchors）",
      description:
        "返回 state.id/kind/description/anchors/controls/inherit_regions/parent_state_id 完整结构。"
        + "用 vision_map.list_actions 列 action_id 后想看某个 control 的 locator 细节时调。",
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
      title: "单个 action 详情（control + locator + 风险）",
      description:
        "返回 action_id 对应的 control 详情（locator_priority / postcondition / risk_level / action_types）"
        + " 加上其所在 state 的 kind。perform_action 失败时 / 写 patch 前调。"
        + "等价于 vision_map.describe_action 工具，但走 resource 通道。",
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
      title: "单个 workflow 完整 JSON（含 steps）",
      description:
        "返回 workflow 完整定义含 steps[] / inputs / timeout_ms。"
        + "用 vision_map.describe_workflow 工具拿同样数据 + 每步 control 附带描述（更易读）。",
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
