// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Vision-MCP Authors
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ERROR_CODES,
  VisionMcpError,
  isVisionMcpError,
  lintMap,
  parseActionId,
  formatActionId,
  findControl,
  findState,
  findWorkflow,
  listActions as listActionsForMap,
  Patch as PatchSchema,
  hasErrors,
} from "@vision-mcp/core";
import type { AccessibilityNode, Frame } from "@vision-mcp/core";

function isInteractiveCandidate(n: AccessibilityNode): boolean {
  const r = n.role ?? "";
  if (
    /(AXButton|AXTextField|AXSearchField|AXPopUpButton|AXMenuItem|AXTab|AXLink|AXSlider|AXCheckBox|AXRadioButton|AXList)/.test(
      r,
    )
  )
    return true;
  // AXCell：sidebar cell name="主页"/"搜索" desc="单元格"；搜索结果 cell name=null desc="张学友"
  // 只要 name 或 description 任一非空即视为可点。
  if (r === "AXCell" && (n.name || n.description)) return true;
  return false;
}

/**
 * 极简 PNG 编码：8-bit RGBA，无压缩 fallback。
 * Frame 是从 capsule.capture 来的 RGBA buffer。
 */
async function encodeFramePng(frame: Frame): Promise<Uint8Array> {
  const zlib = await import("node:zlib");
  const { width_px: width, height_px: height, pixels } = frame;
  const sig = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 6; // color type RGBA
  ihdrData[10] = 0;
  ihdrData[11] = 0;
  ihdrData[12] = 0;
  const ihdr = chunk("IHDR", ihdrData);
  // 加上每行 filter 字节（0 = None）
  const stride = width * 4;
  const filtered = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    filtered[y * (stride + 1)] = 0;
    Buffer.from(pixels.buffer, pixels.byteOffset + y * stride, stride).copy(
      filtered,
      y * (stride + 1) + 1,
    );
  }
  const idatData = zlib.deflateSync(filtered);
  const idat = chunk("IDAT", idatData);
  const iend = chunk("IEND", Buffer.alloc(0));
  return Buffer.concat([sig, ihdr, idat, iend]);
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([len, body, crc]);
}

const CRC_TABLE: number[] = (() => {
  const t: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t.push(c >>> 0);
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}
import type { ServerContext } from "./context.js";
import {
  ensureBuilder,
  ensureCapsule,
  ensureRuntime,
  listApps,
  loadApp,
  snapshotApp,
  writeEffective,
} from "./context.js";

const TextOnly = (text: string) => ({
  content: [{ type: "text" as const, text }],
});

const StructuredOk = (data: Record<string, unknown>, summary?: string) => ({
  content: [
    {
      type: "text" as const,
      text: summary ?? JSON.stringify(data, null, 2),
    },
  ],
  structuredContent: data,
});

/** 错误码 → 下一步提示，让 agent 看错误就知道调哪个工具排查。 */
const ERROR_HINTS: Partial<Record<string, string>> = {
  ACTION_NOT_FOUND:
    "用 vision_map.list_actions(app_id, state_id?) 看可用 action_id；或 vision_map.list_workflows(app_id) 看 workflows",
  MAP_VALIDATION_FAILED:
    "用 vision_map.list_apps 看可用 app_id；新建 map 用 vision_map.init",
  STATE_UNKNOWN:
    "用 vision_map.snapshot(app_id) 拿 PNG + candidates；可能是新页面 → vision_map.commit_state 写入；或现有 state 偏差 → vision-mcp patch",
  LOCATOR_FAILED:
    "用 vision_map.snapshot 看现状 + vision_map.describe_action 看 locator 详情；偏差 → vision-mcp patch 修正",
  GEOMETRY_MISMATCH:
    "用 vision_map.repair_minimal --max-level 3 自动修复；不行用 capsule.migrate_window 重排窗口",
  POSTCONDITION_FAILED:
    "用 vision_map.snapshot 看实际状态；可能 postcondition 太严 → patch；或动作真的没生效 → 重试",
  PRECONDITION_FAILED:
    "前置 state 不满足。用 vision_map.detect_state 确认当前 state；可能需要先 perform_action 切到正确 state",
  INPUT_LEASE_DENIED:
    "Windows UIPI 拒绝输入（任务管理器/反作弊 app）。vision-mcp 进程需 elevated；或目标 app 不支持自动化",
  PERMISSION_DENIED:
    "系统权限缺失。macOS：系统设置→隐私→屏幕录制 + 辅助功能；Windows：见 vision-mcp doctor",
  CAPSULE_DISPLAY_MISSING:
    "用 vision-mcp displays 看可用显示器；指定 visual_box.display 尺寸适配实际屏幕",
  CAPSULE_PLATFORM_UNAVAILABLE:
    "native helper 未装。跑 vision-mcp install-helper 或 vision-mcp doctor 看诊断",
  SAFETY_POLICY_BLOCKED:
    "动作被 safety_policy.forbidden_action_categories 拦截。不绕过——告诉用户为什么",
  ACTION_RISK_REQUIRES_CONFIRMATION:
    "destructive 动作需 approval。perform_action / run_workflow 加 approve_all 或经审批通道",
};

function errorResult(err: unknown): { content: { type: "text"; text: string }[]; isError: true; structuredContent: Record<string, unknown> } {
  if (isVisionMcpError(err)) {
    const hint = ERROR_HINTS[err.code];
    const text = hint ? `[${err.code}] ${err.message}\n→ ${hint}` : `[${err.code}] ${err.message}`;
    return {
      isError: true,
      content: [{ type: "text", text }],
      structuredContent: { ...(err.toJSON() as Record<string, unknown>), hint },
    };
  }
  const e = err as Error;
  return {
    isError: true,
    content: [{ type: "text", text: e?.message ?? String(err) }],
    structuredContent: { code: ERROR_CODES.UNKNOWN, message: e?.message, stack: e?.stack },
  };
}

async function withApp<T>(
  ctx: ServerContext,
  appId: string,
  fn: (handle: Awaited<ReturnType<typeof loadApp>>) => Promise<T>,
): Promise<T> {
  const app = await loadApp(ctx, appId);
  return fn(app);
}

export function registerTools(server: McpServer, ctx: ServerContext): void {
  // —— capsule.* ——————————————————————————————————————————————————

  server.registerTool(
    "capsule.ensure_display",
    {
      title: "创建或检测 capsule 显示器",
      description:
        "按 visual_box.display 在 OS 中创建虚拟显示器；macOS 默认走 fallback 到 real_window/existing_display。",
      inputSchema: {
        app_id: z.string(),
      },
    },
    async ({ app_id }) => {
      try {
        return await withApp(ctx, app_id, async (app) => {
          const capsule = await ensureCapsule(ctx, app);
          const display = await capsule.ensureDisplay({
            geometry: app.effective.visual_box.display,
            mode: app.effective.visual_box.mode,
            fallbacks: app.effective.visual_box.fallbacks,
          });
          return StructuredOk({ display }, `display ready: ${display.id}`);
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "capsule.attach_window",
    {
      title: "绑定目标窗口",
      description:
        "按 visual_box.target_window 寻找窗口；可指定 pick 策略。",
      inputSchema: {
        app_id: z.string(),
        pick: z.enum(["first", "most_recent", "largest"]).optional(),
        target_override: z
          .object({
            process_name: z.string().optional(),
            title_regex: z.string().optional(),
            class_name: z.string().optional(),
            bundle_id: z.string().optional(),
          })
          .optional(),
      },
    },
    async ({ app_id, pick, target_override }) => {
      try {
        return await withApp(ctx, app_id, async (app) => {
          const capsule = await ensureCapsule(ctx, app);
          const target = target_override ?? app.effective.visual_box.target_window;
          if (!target) {
            throw new VisionMcpError(
              "WINDOW_NOT_FOUND",
              `visual_box.target_window 未配置且未传 target_override`,
            );
          }
          const win = await capsule.attach({ target, pick });
          return StructuredOk({ window: win }, `attached window ${win.title}`);
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "capsule.migrate_window",
    {
      title: "迁移窗口到 capsule",
      description: "将已绑定窗口移动到 capsule display 的 work area。",
      inputSchema: {
        app_id: z.string(),
        display_id: z.string().optional(),
      },
    },
    async ({ app_id, display_id }) => {
      try {
        return await withApp(ctx, app_id, async (app) => {
          const capsule = await ensureCapsule(ctx, app);
          const status = await capsule.status();
          const targetId = display_id ?? status.display?.id;
          if (!targetId) {
            throw new VisionMcpError(
              "CAPSULE_DISPLAY_MISSING",
              `没有可用 display，请先调用 capsule.ensure_display`,
            );
          }
          const win = await capsule.migrate(targetId);
          const after = await capsule.validateGeometry();
          return StructuredOk(
            { window: win, geometry: after },
            after.ok ? "migrated and geometry OK" : `migrated but violations=${after.violations.join("; ")}`,
          );
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "capsule.restore_window",
    {
      title: "恢复窗口至原 placement",
      description: "释放 capsule 绑定，并将窗口移回原显示器/原状态。",
      inputSchema: { app_id: z.string() },
    },
    async ({ app_id }) => {
      try {
        return await withApp(ctx, app_id, async (app) => {
          const capsule = await ensureCapsule(ctx, app);
          await capsule.restore();
          return StructuredOk({ ok: true }, "restored");
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "capsule.capture",
    {
      title: "截图当前 capsule 内容",
      description:
        "默认捕获目标窗口；source=display 则捕获整个 capsule 显示器。返回 base64 PNG。",
      inputSchema: {
        app_id: z.string(),
        source: z.enum(["window", "display"]).optional(),
      },
    },
    async ({ app_id, source }) => {
      try {
        return await withApp(ctx, app_id, async (app) => {
          const capsule = await ensureCapsule(ctx, app);
          const frame = await capsule.capture({ source });
          const summary = `${frame.source} ${frame.width_px}x${frame.height_px} @ ${frame.captured_at}`;
          return {
            content: [
              { type: "text" as const, text: summary },
            ],
            structuredContent: {
              width_px: frame.width_px,
              height_px: frame.height_px,
              captured_at: frame.captured_at,
              source: frame.source,
              client_rect: frame.client_rect_in_frame,
              pixels_base64_truncated: Buffer.from(
                frame.pixels.slice(0, Math.min(frame.pixels.length, 64)),
              ).toString("base64"),
              pixels_length: frame.pixels.length,
            },
          };
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "capsule.validate_geometry",
    {
      title: "校验当前几何契约",
      description: "返回 client size / DPI / scale / 显示器 / foreground 等检查结果。",
      inputSchema: { app_id: z.string() },
    },
    async ({ app_id }) => {
      try {
        return await withApp(ctx, app_id, async (app) => {
          const capsule = await ensureCapsule(ctx, app);
          const geom = await capsule.validateGeometry();
          return StructuredOk(
            { geometry: geom },
            geom.ok ? "geometry OK" : `violations: ${geom.violations.join("; ")}`,
          );
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "capsule.raise",
    {
      title: "把窗口拉回前台",
      description: "macOS 焦点切换是异步的；agent 在 type/key 前可主动调用。",
      inputSchema: { app_id: z.string() },
    },
    async ({ app_id }) => {
      try {
        return await withApp(ctx, app_id, async (app) => {
          const capsule = await ensureCapsule(ctx, app);
          await capsule.raise();
          return StructuredOk({ ok: true }, "raised");
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // ---------- agent-friendly raw operations + snapshot ----------

  server.registerTool(
    "vision_map.snapshot",
    {
      title: "返回当前 capsule 的截图 + AX 候选 + 已知 state 匹配",
      description:
        "Agent 探索的核心工具：一次拿到 PNG（base64）、可交互节点列表、与 map.states 的最佳匹配；后续 commit_state 时一并写入 vision-mcp。",
      inputSchema: {
        app_id: z.string(),
        include_image: z.boolean().default(true),
        include_ax: z.boolean().default(true),
        max_candidates: z.number().int().min(1).max(500).default(80),
      },
    },
    async ({ app_id, include_image, include_ax, max_candidates }) => {
      try {
        return await withApp(ctx, app_id, async (app) => {
          const rt = await ensureRuntime(ctx, app);
          const { state, insights } = await rt.detectState();
          const status = await (await ensureCapsule(ctx, app)).status();
          let image_base64: string | undefined;
          if (include_image) {
            const { Buffer } = await import("node:buffer");
            const png = await encodeFramePng(insights.frame);
            image_base64 = Buffer.from(png).toString("base64");
          }
          const candidates = include_ax
            ? insights.accessibility
                .filter((n) => isInteractiveCandidate(n))
                .slice(0, max_candidates)
                .map((n) => ({
                  role: n.role,
                  name: n.name,
                  description: n.description,
                  bbox_norm: n.bbox_norm.map((v) => Number(v.toFixed(4))),
                  id: n.id,
                }))
            : [];
          return StructuredOk(
            {
              state_match: state,
              window: status.attached_window,
              geometry: status.geometry,
              candidates,
              candidates_total: insights.accessibility.length,
              image_base64,
              image_mime: image_base64 ? "image/png" : undefined,
              visual_hash: insights.visual_hash,
            },
            `state=${state?.state_id ?? "none"} candidates=${candidates.length}/${insights.accessibility.length}`,
          );
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "vision_map.click_at",
    {
      title: "在 capsule 内按归一化坐标 click（探索原始动作）",
      description:
        "Agent 看完 snapshot 后直接传 [x, y] norm 触发 click，不需要预先定义 control。",
      inputSchema: {
        app_id: z.string(),
        point_norm: z.tuple([z.number().min(0).max(1.5), z.number().min(0).max(1.5)]),
        button: z.enum(["left", "right", "middle"]).optional(),
        click_count: z.number().int().min(1).max(3).optional(),
      },
    },
    async ({ app_id, point_norm, button, click_count }) => {
      try {
        return await withApp(ctx, app_id, async (app) => {
          const capsule = await ensureCapsule(ctx, app);
          const geom = await capsule.validateGeometry();
          const cr = geom.client_rect_px;
          const pt = {
            x: Math.round(cr.x + point_norm[0] * cr.width),
            y: Math.round(cr.y + point_norm[1] * cr.height),
          };
          await capsule.raise().catch(() => {});
          await capsule.adapter.click(pt, { button, click_count });
          return StructuredOk(
            { point_screen: pt, point_norm },
            `clicked ${button ?? "left"} x${click_count ?? 1} @ (${pt.x},${pt.y})`,
          );
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "vision_map.type_text",
    {
      title: "在当前焦点 type 文本",
      description:
        "在 capsule 目标窗口的当前焦点位置输入文本。支持中文 / Unicode（macOS 走 NSPasteboard，Windows 走 SendInput VK_PACKET 绕过 IME）。" +
        "调用前会自动 capsule.raise()。clear_first=true 时先 Cmd/Ctrl+A → Delete 清掉再输。",
      inputSchema: {
        app_id: z.string(),
        text: z.string(),
        clear_first: z.boolean().default(false),
      },
    },
    async ({ app_id, text, clear_first }) => {
      try {
        return await withApp(ctx, app_id, async (app) => {
          const capsule = await ensureCapsule(ctx, app);
          await capsule.raise().catch(() => {});
          await capsule.adapter.typeText({ text, clear_first });
          return StructuredOk({ ok: true, length: text.length });
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "vision_map.press_key",
    {
      title: "按下键盘组合",
      description:
        "发键盘组合到 capsule 目标窗口（自动 raise）。combo 格式："
        + "单键 'return' / 'escape' / 'tab' / 'space' / 'f5' / 'pageup' 等；"
        + "组合 'cmd+s' (macOS) / 'ctrl+s' (Windows) / 'shift+tab' / 'alt+left'。"
        + "modifier 别名：cmd=win=meta / ctrl=control / alt=option。",
      inputSchema: { app_id: z.string(), combo: z.string() },
    },
    async ({ app_id, combo }) => {
      try {
        return await withApp(ctx, app_id, async (app) => {
          const capsule = await ensureCapsule(ctx, app);
          await capsule.raise().catch(() => {});
          await capsule.adapter.pressKey({ combo });
          return StructuredOk({ ok: true, combo });
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "vision_map.scroll",
    {
      title: "在归一化点滚动",
      description:
        "在 capsule 客户区 [nx, ny] 位置发滚轮事件。dy 正值=向下滚（屏幕内容上移），与 macOS 一致；一格 ≈ 120（Windows WHEEL_DELTA）。"
        + "若要按 OCR 文本边滚边找停下来，用 scroll-until-text（CLI）/ recipe 而非这个 raw 工具。",
      inputSchema: {
        app_id: z.string(),
        point_norm: z.tuple([z.number().min(0).max(1.5), z.number().min(0).max(1.5)]),
        dx_px: z.number().default(0),
        dy_px: z.number().default(0),
      },
    },
    async ({ app_id, point_norm, dx_px, dy_px }) => {
      try {
        return await withApp(ctx, app_id, async (app) => {
          const capsule = await ensureCapsule(ctx, app);
          const geom = await capsule.validateGeometry();
          const cr = geom.client_rect_px;
          await capsule.adapter.scroll(
            {
              x: Math.round(cr.x + point_norm[0] * cr.width),
              y: Math.round(cr.y + point_norm[1] * cr.height),
            },
            { dx_px, dy_px },
          );
          return StructuredOk({ ok: true });
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // —— vision_map.* ——————————————————————————————————————————————

  server.registerTool(
    "vision_map.list_apps",
    {
      title: "列出可用 app maps（含 metadata + workflow 摘要）",
      description:
        "扫描 apps 根目录下所有包含 vision-mcp.yaml 的子目录，每个 app 返回 " +
        "name/platform/description/states 数/workflows 摘要（id+description+destructive 标志）。" +
        "agent 启动时第一步：通过这个判断'用哪个 app + 跑哪个 workflow'，避免拉全 map yaml。",
    },
    async () => {
      try {
        const apps = await listApps(ctx);
        const out: unknown[] = [];
        for (const a of apps) {
          try {
            const app = await loadApp(ctx, a.app_id);
            const wfs = app.effective.workflows.map((w) => ({
              id: w.id,
              description: w.description,
              inputs: w.inputs?.map((i) => i.name),
              destructive: w.steps?.some(
                (s) =>
                  s.approval_required === true ||
                  // 间接信号：步骤指向的 control 是否带 destructive risk_level
                  (() => {
                    const parsed = parseActionId(s.action_id);
                    const hit = findControl(app.effective, parsed.ownerId, parsed.controlId);
                    return hit?.control.risk_level === "destructive";
                  })(),
              ) ?? false,
            }));
            out.push({
              app_id: a.app_id,
              name: app.effective.app.name,
              platform: app.effective.app.platform,
              description: app.effective.app.description?.split("\n")[0],
              states_count: app.effective.states.length,
              regions_count: app.effective.regions?.length ?? 0,
              workflows: wfs,
            });
          } catch (err) {
            // 损坏的 app：不阻断 list，返回 error tag
            out.push({ app_id: a.app_id, error: (err as Error).message.split("\n")[0] });
          }
        }
        return StructuredOk({ apps: out }, `${out.length} app(s)`);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "vision_map.list_workflows",
    {
      title: "列出指定 app 的 workflows（摘要，不含 steps 细节）",
      description:
        "返回每个 workflow 的 id/description/inputs/timeout_ms/steps_count/destructive。" +
        "若要看 workflow steps 细节（什么 action 顺序），用 vision_map.describe_workflow。" +
        "若要执行，直接 vision_map.run_workflow。",
      inputSchema: { app_id: z.string() },
    },
    async ({ app_id }) => {
      try {
        return await withApp(ctx, app_id, (app) => {
          const wfs = app.effective.workflows.map((w) => ({
            id: w.id,
            description: w.description,
            inputs: w.inputs?.map((i) => ({ name: i.name, description: i.description })),
            timeout_ms: w.timeout_ms,
            steps_count: w.steps.length,
            destructive: w.steps.some(
              (s) =>
                s.approval_required === true ||
                (() => {
                  const parsed = parseActionId(s.action_id);
                  const hit = findControl(app.effective, parsed.ownerId, parsed.controlId);
                  return hit?.control.risk_level === "destructive";
                })(),
            ),
          }));
          return Promise.resolve(StructuredOk({ workflows: wfs }, `${wfs.length} workflows`));
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "vision_map.describe_workflow",
    {
      title: "返回单个 workflow 的完整步骤与每步详情",
      description:
        "返回 steps 列表，每步含 action_id + control description + risk_level + " +
        "on_failure + approval_required。agent 决定要不要 run_workflow 前的最后一步检查。",
      inputSchema: { app_id: z.string(), workflow_id: z.string() },
    },
    async ({ app_id, workflow_id }) => {
      try {
        return await withApp(ctx, app_id, (app) => {
          const wf = app.effective.workflows.find((w) => w.id === workflow_id);
          if (!wf) {
            // 没有专门的 WORKFLOW_NOT_FOUND 错误码；语义等价 ACTION_NOT_FOUND
            throw new VisionMcpError(
              "ACTION_NOT_FOUND",
              `workflow "${workflow_id}" 未在 app "${app_id}" 找到`,
            );
          }
          const stepsDetail = wf.steps.map((s) => {
            const parsed = parseActionId(s.action_id);
            const hit = findControl(app.effective, parsed.ownerId, parsed.controlId);
            return {
              action_id: s.action_id,
              params: s.params,
              approval_required: s.approval_required,
              on_failure: s.on_failure,
              control: hit
                ? {
                    label: hit.control.label,
                    role: hit.control.role,
                    action_types: hit.control.action_types,
                    risk_level: hit.control.risk_level,
                    has_postcondition: Boolean(hit.control.postcondition),
                  }
                : { error: "control_not_found" },
            };
          });
          return Promise.resolve(
            StructuredOk(
              {
                workflow_id,
                description: wf.description,
                inputs: wf.inputs,
                timeout_ms: wf.timeout_ms,
                steps: stepsDetail,
              },
              `${workflow_id}: ${stepsDetail.length} steps`,
            ),
          );
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "vision_map.init",
    {
      title: "初始化新 map 项目",
      description: "在 apps_root/<app_id>/vision-mcp.yaml 写入最小骨架。",
      inputSchema: {
        app_id: z.string(),
        name: z.string(),
        platform: z.enum(["windows", "macos", "any"]).default("any"),
        width_px: z.number().int().positive().default(1280),
        height_px: z.number().int().positive().default(800),
      },
    },
    async ({ app_id, name, platform, width_px, height_px }) => {
      try {
        const fs = await import("node:fs/promises");
        const path = await import("node:path");
        const dir = path.join(ctx.appsRoot, app_id);
        await fs.mkdir(dir, { recursive: true });
        const mapPath = path.join(dir, "vision-mcp.yaml");
        const { VisionMap, saveMap } = await import("@vision-mcp/core");
        const map = VisionMap.parse({
          version: "0.1",
          app: { id: app_id, name, platform },
          visual_box: {
            id: `${app_id}-capsule`,
            mode: platform === "macos" ? "real_window" : "same_session_virtual_display",
            platform,
            coordinate_space: "normalized_client_rect",
            display: { width_px, height_px },
            contract: { require_client_size_px: [width_px, height_px] },
          },
        });
        await saveMap(mapPath, map);
        ctx.apps.delete(app_id);
        return StructuredOk({ app_id, map_path: mapPath }, `created ${mapPath}`);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "vision_map.describe",
    {
      title: "返回 map 概要（含 description + state/workflow 摘要）",
      description:
        "比 list_apps 更详细一层：含 app description / 每个 state 的 id+kind+description / " +
        "每个 region 的 id+description / 每个 workflow 的 id+description+inputs。" +
        "不含 controls 细节（用 vision_map.list_actions / describe_action）或 workflow steps（用 describe_workflow）。" +
        "agent 选定 app 后第二步调，决定要 run_workflow 还是先 detect_state。",
      inputSchema: { app_id: z.string() },
    },
    async ({ app_id }) => {
      try {
        return await withApp(ctx, app_id, (app) => {
          const issues = lintMap(app.effective);
          const snapshot = snapshotApp(app);
          const m = app.effective;
          return Promise.resolve(
            StructuredOk(
              {
                ...snapshot,
                app: {
                  id: m.app.id,
                  name: m.app.name,
                  platform: m.app.platform,
                  description: m.app.description,
                },
                // states / workflows 仍是数量（向后兼容）；详细 summary 用下面 _summary 字段
                regions_summary: (m.regions ?? []).map((r) => ({
                  id: r.id,
                  description: r.description,
                  controls_count: r.controls.length,
                })),
                states_summary: m.states.map((s) => ({
                  id: s.id,
                  kind: s.kind,
                  description: s.description,
                  controls_count: s.controls.length,
                  inherit_regions: s.inherit_regions,
                  parent_state_id: s.parent_state_id,
                })),
                workflows_summary: m.workflows.map((w) => ({
                  id: w.id,
                  description: w.description,
                  steps_count: w.steps.length,
                  inputs: w.inputs?.map((i) => i.name),
                })),
                issues,
                has_errors: hasErrors(issues),
              },
              `${snapshot.states} states / ${snapshot.workflows} workflows / ${issues.length} issues`,
            ),
          );
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "vision_map.detect_state",
    {
      title: "识别当前 capsule 中的 state",
      description: "捕获一帧 → 分析 OCR/Accessibility/visual hash → 在 map.states 中查找最佳匹配。",
      inputSchema: { app_id: z.string() },
    },
    async ({ app_id }) => {
      try {
        return await withApp(ctx, app_id, async (app) => {
          const rt = await ensureRuntime(ctx, app);
          const { state, insights } = await rt.detectState();
          return StructuredOk(
            {
              state,
              ocr_tokens: insights.ocr.length,
              accessibility_nodes: insights.accessibility.length,
              visual_hash: insights.visual_hash,
            },
            state ? `matched ${state.state_id}` : "no state matched",
          );
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "vision_map.list_actions",
    {
      title: "列出可执行 action_id",
      description: "可选 state_id 过滤；返回包括默认动作和按 action_type 命名的变种。",
      inputSchema: {
        app_id: z.string(),
        state_id: z.string().optional(),
      },
    },
    async ({ app_id, state_id }) => {
      try {
        return await withApp(ctx, app_id, (app) => {
          const actions = state_id
            ? listActionsForMap(app.effective, state_id)
            : app.effective.states.flatMap((s) => listActionsForMap(app.effective, s.id));
          return Promise.resolve(StructuredOk({ actions }, `${actions.length} actions`));
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "vision_map.describe_action",
    {
      title: "返回单个 action 的详细信息",
      description:
        "返回 action_id 对应的 control 完整定义：role / action_types / locator_priority / "
        + "visual / precondition / postcondition / risk_level。"
        + "用于 perform_action 失败后排查 / 写 patch 前看现状 / 学习一个 map 的具体 control 设计。"
        + "action_id 形式 '<state|region>.<control>[:action_type]'，如 'sidebar.search' / 'music.app.result_card[2]:double_click'。",
      inputSchema: {
        app_id: z.string(),
        action_id: z.string(),
      },
    },
    async ({ app_id, action_id }) => {
      try {
        return await withApp(ctx, app_id, (app) => {
          const parsed = parseActionId(action_id);
          const hit = findControl(app.effective, parsed.ownerId, parsed.controlId);
          if (!hit) {
            throw new VisionMcpError(
              "ACTION_NOT_FOUND",
              `action_id "${action_id}" 未找到`,
            );
          }
          const owner = hit.kind === "state"
            ? { kind: "state", id: hit.state.id, state_kind: hit.state.kind }
            : { kind: "region", id: hit.region.id };
          return Promise.resolve(
            StructuredOk(
              {
                action_id,
                owner,
                control: hit.control,
              },
              `${action_id} → ${hit.control.role}/${hit.control.label ?? hit.control.id}`,
            ),
          );
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "vision_map.perform_action",
    {
      title: "执行单个 action",
      description:
        "完整 runtime 流程：geometry → 审批 → 状态检测 → locator → 输入 → postcondition。",
      inputSchema: {
        app_id: z.string(),
        action_id: z.string(),
        params: z
          .object({
            text: z.string().optional(),
            combo: z.string().optional(),
            dy_px: z.number().optional(),
            dx_px: z.number().optional(),
            to_norm: z.tuple([z.number(), z.number()]).optional(),
            wait_ms: z.number().optional(),
            modifiers: z.array(z.enum(["ctrl", "shift", "alt", "meta"])).optional(),
            click_count: z.number().int().min(1).max(3).optional(),
          })
          .optional(),
      },
    },
    async ({ app_id, action_id, params }) => {
      try {
        return await withApp(ctx, app_id, async (app) => {
          const rt = await ensureRuntime(ctx, app);
          const result = await rt.performAction(action_id, params ?? {});
          return StructuredOk(
            {
              ...result,
              events: result.events.map((e) => ({ kind: e.kind, message: e.message })),
            },
            result.succeeded ? `${action_id} OK` : `${action_id} failed: ${result.message}`,
          );
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "vision_map.run_workflow",
    {
      title: "运行 workflow",
      description: "按 workflow.steps 顺序执行 action，并支持 inputs 模板插值。",
      inputSchema: {
        app_id: z.string(),
        workflow_id: z.string(),
        inputs: z.record(z.unknown()).optional(),
      },
    },
    async ({ app_id, workflow_id, inputs }) => {
      try {
        return await withApp(ctx, app_id, async (app) => {
          if (!findWorkflow(app.effective, workflow_id)) {
            throw new VisionMcpError(
              "ACTION_NOT_FOUND",
              `workflow ${workflow_id} 不存在`,
            );
          }
          const rt = await ensureRuntime(ctx, app);
          const result = await rt.runWorkflow(workflow_id, inputs ?? {});
          return StructuredOk(
            result as unknown as Record<string, unknown>,
            result.succeeded
              ? `workflow ${workflow_id} OK`
              : `workflow ${workflow_id} failed at step ${result.steps.findIndex((s) => !s.succeeded)}`,
          );
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "vision_map.verify",
    {
      title: "重新验证当前 state 是否满足某个 condition",
      description:
        "运行 detect_state 后对单个 condition 求值。condition schema 同 control.postcondition："
        + "{ type: 'state_should_be', state_id: '...' } / { type: 'text_should_appear', text: '...' } / "
        + "{ type: 'modal_should_close' } / { type: 'visual_diff_should_be', min: 0.15 } 等。"
        + "用于 agent 手动验证 perform_action 后状态是否符合预期（runtime 自动 postcondition 不够时）。",
      inputSchema: {
        app_id: z.string(),
        condition: z.record(z.unknown()),
      },
    },
    async ({ app_id, condition }) => {
      try {
        return await withApp(ctx, app_id, async (app) => {
          const rt = await ensureRuntime(ctx, app);
          const { state, insights } = await rt.detectState();
          const { Condition } = await import("@vision-mcp/core");
          const parsed = Condition.parse(condition);
          const { evaluateCondition } = await import("@vision-mcp/core");
          const eval2 = await evaluateCondition(parsed, {
            map: app.effective,
            state_match: state,
            insights,
            window_title: (await (await ensureCapsule(ctx, app)).status()).attached_window?.title,
            recent_controls: [],
          });
          return StructuredOk(
            { ok: eval2.ok, reasons: eval2.reasons, state_match: state },
            eval2.ok ? "condition met" : `failed: ${eval2.reasons.join(" | ")}`,
          );
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "vision_map.repair_minimal",
    {
      title: "执行 L0-L3 自动修复",
      description: "默认尝试到 L3；max_level 可降级。",
      inputSchema: {
        app_id: z.string(),
        max_level: z.number().int().min(0).max(6).default(3),
      },
    },
    async ({ app_id, max_level }) => {
      try {
        return await withApp(ctx, app_id, async (app) => {
          const rt = await ensureRuntime(ctx, app);
          const r = await rt.repairAttempt(max_level);
          return StructuredOk(
            r as unknown as Record<string, unknown>,
            r.ok ? `repair OK: ${r.message}` : `repair failed: ${r.message}`,
          );
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "vision_map.apply_patch",
    {
      title: "手动追加一个 patch 到 patches/ 目录",
      description: "适用于 agent 提议的修复建议被人类批准后写入。",
      inputSchema: {
        app_id: z.string(),
        patch: z.record(z.unknown()),
      },
    },
    async ({ app_id, patch }) => {
      try {
        return await withApp(ctx, app_id, async (app) => {
          const parsed = PatchSchema.parse(patch);
          const { writePatch, applyPatches } = await import("@vision-mcp/core");
          const filePath = await writePatch(app.baseDir, parsed);
          app.patches.push(parsed);
          app.effective = applyPatches(app.map, app.patches);
          return StructuredOk(
            { patch_file: filePath, patch: parsed },
            `patch ${parsed.id} written`,
          );
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "vision_map.export_trace",
    {
      title: "导出 trace 事件",
      description: "按 session id 过滤；默认返回最近 100 条。",
      inputSchema: {
        app_id: z.string(),
        session_id: z.string().optional(),
        limit: z.number().int().positive().max(1000).default(100),
        kinds: z.array(z.string()).optional(),
      },
    },
    async ({ app_id, session_id, limit, kinds }) => {
      try {
        return await withApp(ctx, app_id, async (app) => {
          if (!app.trace) {
            await ensureRuntime(ctx, app); // 触发 trace 初始化
          }
          const events = await app.trace!.query({
            sessionId: session_id,
            limit,
            kinds: kinds as never,
          });
          return StructuredOk(
            { count: events.length, events },
            `exported ${events.length} events`,
          );
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "vision_map.propose_controls",
    {
      title: "从当前 capsule 提取候选控件（builder 辅助）",
      description: "捕获 frame，运行 builder 自动控件抽取，但不写入 map。",
      inputSchema: {
        app_id: z.string(),
        state_id: z.string(),
      },
    },
    async ({ app_id, state_id }) => {
      try {
        return await withApp(ctx, app_id, async (app) => {
          const builder = await ensureBuilder(ctx, app);
          const captured = await builder.captureCurrent({ id: state_id });
          // 不直接 append；返回 controls 供 agent/UI 决策
          const draft = await import("@vision-mcp/core").then((m) =>
            new m.MapBuilder({
              app: app.effective.app,
              visualBoxId: app.effective.visual_box.id,
              capsule: app.capsule!,
              providers: ctx.providers,
              outDir: app.baseDir,
            }),
          );
          const state = draft.appendStateFromCapture(captured);
          return StructuredOk(
            {
              state_id: state.id,
              controls: state.controls,
              anchors: state.anchors,
            },
            `${state.controls.length} candidate controls`,
          );
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "vision_map.commit_state",
    {
      title: "把 builder 捕获的 state 写入 map baseline",
      description: "调用前应通过 propose_controls 评估候选；本工具会覆盖同名 state。",
      inputSchema: {
        app_id: z.string(),
        state_id: z.string(),
        description: z.string().optional(),
      },
    },
    async ({ app_id, state_id, description }) => {
      try {
        return await withApp(ctx, app_id, async (app) => {
          const builder = await ensureBuilder(ctx, app);
          const captured = await builder.captureCurrent({ id: state_id, description });
          const state = builder.appendStateFromCapture(captured);
          // 合并写回 baseline
          const baseline = builder.current();
          app.map = baseline;
          app.effective = baseline;
          await writeEffective(app);
          return StructuredOk(
            { state_id: state.id, controls: state.controls.length },
            `committed state ${state.id}`,
          );
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
