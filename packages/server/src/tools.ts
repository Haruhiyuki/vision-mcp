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
  Control as ControlSchema,
  Workflow as WorkflowSchema,
  hasErrors,
} from "@vision-mcp/core";
import type { AccessibilityNode, Frame } from "@vision-mcp/core";
import { downscaleRgba, encodeRgbaToPng } from "@vision-mcp/core";

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
 * 把 Frame 编成 PNG bytes；maxWidth > 0 且帧更宽时先等比降采样。
 */
function encodeFramePng(frame: Frame, maxWidth = 0): { png: Buffer; width: number; height: number } {
  const scaled = downscaleRgba(frame.width_px, frame.height_px, frame.pixels, maxWidth);
  return {
    png: encodeRgbaToPng(scaled.width, scaled.height, scaled.pixels),
    width: scaled.width,
    height: scaled.height,
  };
}

/**
 * 截图落盘：写进 traceDir/<app_id>/captures/，返回绝对路径。
 * 截图动辄 300KB–数 MB，内联 base64 会把 host 的 token 上限打爆——默认全部走文件。
 */
async function writeFramePng(
  ctx: ServerContext,
  appId: string,
  frame: Frame,
  maxWidth = 0,
): Promise<{ path: string; width: number; height: number; bytes: number }> {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const { png, width, height } = encodeFramePng(frame, maxWidth);
  const dir = path.join(ctx.traceDir, appId, "captures");
  await fs.mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(dir, `${stamp}-${frame.source}.png`);
  await fs.writeFile(file, png);
  return { path: file, width, height, bytes: png.length };
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
    "用 vision_map.list_apps 看可用 app_id。只是想吸附窗口看一眼：capsule.attach_window / vision_map.snapshot 等探索工具对未知 app_id 自动建临时会话，不用先 init；要沉淀 map 才用 vision_map.init",
  STATE_UNKNOWN:
    "用 vision_map.snapshot(app_id) 拿 PNG + candidates；可能是新页面 → vision_map.commit_state 写入；或现有 state 偏差 → vision-mcp patch",
  LOCATOR_FAILED:
    "用 vision_map.snapshot 看现状 + vision_map.describe_action 看 locator 详情；偏差 → vision-mcp patch 修正",
  GEOMETRY_MISMATCH:
    "看 details.reason：(1) foreground_timeout → 目标窗口切不到前台。可能是 host (Claude Code 等) 持续 frontmost 触发了 macOS 焦点窃取保护。让用户手动 cmd+tab 一次，或 host 自身让出焦点后重试。这种情况 repair_minimal 救不了；(2) 尺寸/位置不对 → vision_map.repair_minimal --max-level 3 自动修；(3) 窗口被拖出 → capsule.migrate_window 重排",
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
  opts?: { allowEphemeral?: boolean },
): Promise<T> {
  const app = await loadApp(ctx, appId, opts);
  return fn(app);
}

/**
 * capsule.* 与 raw 探索工具（snapshot/click_at/type/key/scroll）走这个：
 * app_id 没有 map 时自动建 quick-look 临时会话，免 vision_map.init 仪式。
 * map 语义工具（perform_action/list_actions/commit_* 等）仍要求真实 map。
 */
async function withAppQuickLook<T>(
  ctx: ServerContext,
  appId: string,
  fn: (handle: Awaited<ReturnType<typeof loadApp>>) => Promise<T>,
): Promise<T> {
  return withApp(ctx, appId, fn, { allowEphemeral: true });
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
        return await withAppQuickLook(ctx, app_id, async (app) => {
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
        "按 visual_box.target_window 寻找窗口；可指定 pick 策略。" +
        "display 未就绪时自动 ensure_display（无需单独调用）；" +
        "app_id 没有 map 时自动建 quick-look 临时会话——吸附看一眼不用先 init。",
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
        return await withAppQuickLook(ctx, app_id, async (app) => {
          const capsule = await ensureCapsule(ctx, app);
          const target = target_override ?? app.effective.visual_box.target_window;
          if (!target) {
            throw new VisionMcpError(
              "WINDOW_NOT_FOUND",
              `visual_box.target_window 未配置且未传 target_override`,
            );
          }
          // display 未就绪时顺手 ensure（幂等、只是挑稳定 display）——
          // restore 后重新吸附不必再走一遍 capsule.ensure_display
          const status = await capsule.status();
          if (!status.display) {
            await capsule.ensureDisplay({
              geometry: app.effective.visual_box.display,
              mode: app.effective.visual_box.mode,
              fallbacks: app.effective.visual_box.fallbacks,
            });
          }
          const win = await capsule.attach({ target, pick });
          return StructuredOk(
            { window: win, ephemeral: app.ephemeral || undefined },
            `attached window ${win.title}${app.ephemeral ? "（quick-look 临时会话，沉淀用 vision_map.init）" : ""}`,
          );
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
        return await withAppQuickLook(ctx, app_id, async (app) => {
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
        return await withAppQuickLook(ctx, app_id, async (app) => {
          const capsule = await ensureCapsule(ctx, app);
          await capsule.restore();
          // capsule 内部 window/display 已清零，缓存对象不再与实际状态一致；
          // 丢掉 capsule/runtime/builder，adapter（helper 进程）保留复用。
          app.capsule = undefined;
          app.runtime = undefined;
          app.builder = undefined;
          return StructuredOk({ ok: true }, "restored（重新吸附直接 attach_window 即可）");
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "capsule.capture",
    {
      title: "截图当前 capsule 内容（PNG 落盘，返回文件路径）",
      description:
        "默认捕获目标窗口；source=display 则捕获整个 capsule 显示器。" +
        "PNG 写入磁盘并返回 image_path——不内联 base64，避免大图打爆 host 的 token 上限。" +
        "max_image_width > 0 时等比降采样到该宽度（0 = 保留原始分辨率）。",
      inputSchema: {
        app_id: z.string(),
        source: z.enum(["window", "display"]).optional(),
        max_image_width: z.number().int().min(0).max(8192).default(0),
      },
    },
    async ({ app_id, source, max_image_width }) => {
      try {
        return await withAppQuickLook(ctx, app_id, async (app) => {
          const capsule = await ensureCapsule(ctx, app);
          const frame = await capsule.capture({ source });
          const file = await writeFramePng(ctx, app_id, frame, max_image_width);
          return StructuredOk(
            {
              image_path: file.path,
              image_mime: "image/png",
              image_width_px: file.width,
              image_height_px: file.height,
              image_bytes: file.bytes,
              capture_width_px: frame.width_px,
              capture_height_px: frame.height_px,
              captured_at: frame.captured_at,
              source: frame.source,
              capture_via: frame.via,
              client_rect: frame.client_rect_in_frame,
            },
            `${frame.source} ${frame.width_px}x${frame.height_px}${frame.via ? ` via=${frame.via}` : ""} → ${file.path} (${file.width}x${file.height}, ${Math.round(file.bytes / 1024)}KB)`,
          );
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
        return await withAppQuickLook(ctx, app_id, async (app) => {
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
        return await withAppQuickLook(ctx, app_id, async (app) => {
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
      title: "返回当前 capsule 的截图 + AX 候选 + OCR token + 已知 state 匹配",
      description:
        "Agent 探索的核心工具：一次拿到 PNG（默认落盘返回 image_path）、可交互 AX 节点、OCR 文字 token + bbox、" +
        "与 map.states 的最佳匹配；后续 commit_state 时一并写入 vision-mcp。" +
        "AX 优先（最便宜最准），OCR 作辅助定位（AX 树空 / CEF / 自绘 UI 时主力）；" +
        "视觉（PNG）只在 agent 真要看图时用——多数情况只看 candidates + ocr_tokens 足够。",
      inputSchema: {
        app_id: z.string(),
        include_image: z.boolean().default(true),
        image_output: z
          .enum(["file", "inline"])
          .default("file")
          .describe(
            "file（默认）：PNG 写盘返回 image_path，host 直接读文件，不占 token；" +
              "inline：返回 image_base64（仅小图/特殊场景用，大图会超 host token 上限）",
          ),
        max_image_width: z
          .number()
          .int()
          .min(0)
          .max(8192)
          .default(1280)
          .describe("等比降采样到该宽度（Retina 原始帧常 >2500px 宽）；0 = 保留原始分辨率"),
        include_ax: z.boolean().default(true),
        include_ocr: z
          .boolean()
          .default(true)
          .describe("是否返回 OCR token（按 confidence 排序，top N，含 bbox_norm 让 agent 直接拿到位置）"),
        max_candidates: z.number().int().min(1).max(500).default(80),
        max_ocr_tokens: z
          .number()
          .int()
          .min(1)
          .max(500)
          .default(50)
          .describe("OCR token 数量上限。confidence < 0.5 的自动过滤"),
      },
    },
    async ({ app_id, include_image, image_output, max_image_width, include_ax, include_ocr, max_candidates, max_ocr_tokens }) => {
      try {
        return await withAppQuickLook(ctx, app_id, async (app) => {
          const rt = await ensureRuntime(ctx, app);
          const { state, insights } = await rt.detectState();
          const status = await (await ensureCapsule(ctx, app)).status();
          // DarwinOcrProvider.recognize(frame) 永远返回 [] — 它需要 screen rect 才能
          // 跑 Vision framework。真 OCR 走 recognizeRect(client_rect_px)。
          // detectState → analyze 走的 recognize 这条路填不到 OCR；这里主动调一次。
          if (include_ocr && ctx.providers.ocr && status.geometry?.client_rect_px) {
            const maybeRectOcr = ctx.providers.ocr as {
              recognizeRect?: (rect: import("@vision-mcp/core").RectPx) => Promise<import("@vision-mcp/core").OcrToken[]>;
            };
            if (maybeRectOcr.recognizeRect) {
              try {
                insights.ocr = await maybeRectOcr.recognizeRect(status.geometry.client_rect_px);
              } catch { /* OCR best-effort */ }
            }
          }
          let image_base64: string | undefined;
          let image_path: string | undefined;
          let image_width_px: number | undefined;
          let image_height_px: number | undefined;
          if (include_image) {
            if (image_output === "inline") {
              const encoded = encodeFramePng(insights.frame, max_image_width);
              image_base64 = encoded.png.toString("base64");
              image_width_px = encoded.width;
              image_height_px = encoded.height;
            } else {
              const file = await writeFramePng(ctx, app_id, insights.frame, max_image_width);
              image_path = file.path;
              image_width_px = file.width;
              image_height_px = file.height;
            }
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
          // OCR token：辅助定位 — 让 agent 直接看到"屏幕上文字 + 精确 bbox"
          // 比从 PNG 视觉理解便宜得多。AX 完整时通常不用看 ocr_tokens；
          // 自绘 UI / CEF / canvas-rendering 场景 candidates 空，agent 应优先看 ocr_tokens
          const ocr_tokens = include_ocr
            ? insights.ocr
                .filter((t) => t.confidence >= 0.5)
                .sort((a, b) => b.confidence - a.confidence)
                .slice(0, max_ocr_tokens)
                .map((t) => ({
                  text: t.text,
                  confidence: Number(t.confidence.toFixed(3)),
                  bbox_norm: t.bbox_norm
                    ? (t.bbox_norm.map((v) => Number(v.toFixed(4))) as [number, number, number, number])
                    : undefined,
                }))
            : [];
          return StructuredOk(
            {
              state_match: state,
              window: status.attached_window,
              geometry: status.geometry,
              candidates,
              candidates_total: insights.accessibility.length,
              ocr_tokens,
              ocr_tokens_total: insights.ocr.length,
              image_path,
              image_base64,
              image_mime: image_path || image_base64 ? "image/png" : undefined,
              image_width_px,
              image_height_px,
              capture_via: insights.frame.via,
              visual_hash: insights.visual_hash,
            },
            `state=${state?.state_id ?? "none"} ax=${candidates.length}/${insights.accessibility.length} ocr=${ocr_tokens.length}/${insights.ocr.length}${insights.frame.via ? ` via=${insights.frame.via}` : ""}${image_path ? ` image=${image_path}` : ""}`,
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
        return await withAppQuickLook(ctx, app_id, async (app) => {
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
        return await withAppQuickLook(ctx, app_id, async (app) => {
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
        return await withAppQuickLook(ctx, app_id, async (app) => {
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
        return await withAppQuickLook(ctx, app_id, async (app) => {
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
        const { VisionMap, saveMap, createPlatformAdapter } = await import("@vision-mcp/core");
        // 期望 scale/dpi 写实际主显示器的值（Retina scale=2/dpi=144），
        // 否则 schema 默认 1.0/96 会让每次几何校验都报 warning。
        let displayProfile: Record<string, number> = {};
        try {
          const adapter = await createPlatformAdapter(ctx.platformOptions);
          try {
            const displays = await adapter.listDisplays();
            const primary = displays.find((d) => d.is_primary) ?? displays[0];
            if (primary) {
              displayProfile = {
                scale: primary.scale,
                dpi_x: primary.dpi_x,
                dpi_y: primary.dpi_y,
                refresh_rate_hz: primary.refresh_rate_hz,
              };
            }
          } finally {
            await adapter.dispose?.();
          }
        } catch {
          // helper 不可用（CI / 未安装）：落 schema 默认值
        }
        const map = VisionMap.parse({
          version: "0.1",
          app: { id: app_id, name, platform },
          visual_box: {
            id: `${app_id}-capsule`,
            mode: platform === "macos" ? "real_window" : "same_session_virtual_display",
            platform,
            coordinate_space: "normalized_client_rect",
            display: { width_px, height_px, ...displayProfile },
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
          // 记录到 session history 供 harvest_session 一键沉淀。
          // 只在 perform_action 这一层记，raw 工具（click_at / type_text）不记
          // ——它们没有 action_id，无法直接 commit_workflow。
          app.sessionHistory ??= [];
          app.sessionHistory.push({
            action_id,
            params,
            ts: Date.now(),
            succeeded: result.succeeded,
            state_after: (result as { state_after?: { state_id?: string } }).state_after?.state_id,
          });
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

  server.registerTool(
    "vision_map.add_control",
    {
      title: "往现有 state 或 region 加新 control（走 patch overlay）",
      description:
        "agent 探索时发现 baseline 缺一个可交互元素时调。" +
        "走 ControlAddPatch 渐进沉淀（默认 trust=session_only，验证后升级 trusted），" +
        "不污染手编 baseline。state_id 既可以是 state.id 也可以是 region.id（往共享 region 加）。" +
        "已存在同 id control 时幂等忽略；要替换走 vision-mcp patch / apply_patch 的 control_locator。",
      inputSchema: {
        app_id: z.string(),
        state_id: z.string().describe("state.id 或 region.id"),
        control: ControlSchema.describe("完整 control 定义，含 id / role / action_types / locator_priority"),
        trust: z
          .enum(["session_only", "trusted", "untrusted_proposal"])
          .default("session_only"),
        reason: z.string().optional().describe("加 control 的依据，便于 patches 列表里 review"),
      },
    },
    async ({ app_id, state_id, control, trust, reason }) => {
      try {
        return await withApp(ctx, app_id, async (app) => {
          // 验证 state_id 存在（state 或 region）
          const stateExists = app.effective.states.some((s) => s.id === state_id);
          const regionExists = app.effective.regions.some((r) => r.id === state_id);
          if (!stateExists && !regionExists) {
            throw new VisionMcpError(
              ERROR_CODES.STATE_UNKNOWN,
              `state_id ${state_id} 不在 map 里（既不是 state.id 也不是 region.id）`,
            );
          }
          const { writePatch, applyPatches } = await import("@vision-mcp/core");
          const patch = PatchSchema.parse({
            kind: "control_add",
            id: `add-${state_id}-${control.id}-${Date.now().toString(36)}`,
            trust,
            state_id,
            control,
            reason,
            created_at: new Date().toISOString(),
            created_by: "vision_map.add_control",
            confidence: 1,
            requires_review: trust === "untrusted_proposal",
          });
          const filePath = await writePatch(app.baseDir, patch);
          app.patches.push(patch);
          app.effective = applyPatches(app.map, app.patches);
          return StructuredOk(
            {
              patch_file: filePath,
              state_id,
              control_id: control.id,
              trust: patch.trust,
            },
            `added control ${control.id} → ${state_id} (trust=${trust})`,
          );
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "vision_map.commit_workflow",
    {
      title: "把一段验证过的操作序列沉淀为 workflow 写入 baseline",
      description:
        "agent 在没有现成 workflow 时用 perform_action 渐进试错、跑通后调本工具沉淀。" +
        "走 baseline（与 commit_state 一致；workflow 无部分覆盖语义，commit 意味着已验证）。" +
        "已存在同 id workflow 时直接覆盖。每个 step 引用必须是 map 里现有的 action_id；" +
        "如果引用了不存在的 action，先用 vision_map.add_control 把 control 加进 map。",
      inputSchema: {
        app_id: z.string(),
        workflow_id: z.string(),
        steps: z
          .array(
            z.object({
              action_id: z.string().describe("形如 state.control_id 或 region.control_id[N]:action_type"),
              params: z.record(z.unknown()).optional(),
              approval_required: z.boolean().optional(),
              on_failure: z
                .enum(["abort", "ask_user", "repair", "skip"])
                .default("abort")
                .optional(),
              notes: z.string().optional(),
            }),
          )
          .min(1),
        description: z.string().optional(),
        inputs: z
          .array(
            z.object({
              name: z.string(),
              type: z.enum(["string", "number", "boolean"]),
              description: z.string().optional(),
              required: z.boolean().optional(),
            }),
          )
          .optional(),
        timeout_ms: z.number().int().positive().default(120_000),
        overwrite: z
          .boolean()
          .default(false)
          .describe("默认 false：已存在同 id workflow 时报错；true 则覆盖"),
      },
    },
    async ({ app_id, workflow_id, steps, description, inputs, timeout_ms, overwrite }) => {
      try {
        return await withApp(ctx, app_id, async (app) => {
          // 1. 验证所有 step.action_id 在 effective map 里能找到
          const missing: string[] = [];
          for (const s of steps) {
            try {
              const parsed = parseActionId(s.action_id);
              const found = findControl(app.effective, parsed.ownerId, parsed.controlId);
              if (!found) missing.push(s.action_id);
            } catch {
              missing.push(s.action_id);
            }
          }
          if (missing.length > 0) {
            throw new VisionMcpError(
              ERROR_CODES.ACTION_NOT_FOUND,
              `steps 引用了 ${missing.length} 个不存在的 action_id：${missing.slice(0, 5).join(", ")}` +
                (missing.length > 5 ? ` (+${missing.length - 5} more)` : "") +
                "。先用 vision_map.add_control 加 control 或检查 step.action_id 拼写。",
            );
          }
          // 2. 检查重复 workflow_id
          const existingIdx = app.map.workflows.findIndex((w) => w.id === workflow_id);
          if (existingIdx >= 0 && !overwrite) {
            throw new VisionMcpError(
              ERROR_CODES.MAP_VALIDATION_FAILED,
              `workflow ${workflow_id} 已存在；要覆盖请传 overwrite=true，或换 workflow_id`,
            );
          }
          // 3. 构 Workflow + validate
          const workflow = WorkflowSchema.parse({
            id: workflow_id,
            description,
            inputs: inputs ?? [],
            steps: steps.map((s) => ({
              action_id: s.action_id,
              params: s.params,
              approval_required: s.approval_required ?? false,
              on_failure: s.on_failure ?? "abort",
              notes: s.notes,
            })),
            timeout_ms,
          });
          // 4. 写 baseline
          if (existingIdx >= 0) app.map.workflows[existingIdx] = workflow;
          else app.map.workflows.push(workflow);
          const { applyPatches } = await import("@vision-mcp/core");
          app.effective = applyPatches(app.map, app.patches);
          await writeEffective(app);
          return StructuredOk(
            {
              workflow_id,
              steps_count: steps.length,
              overwritten: existingIdx >= 0,
            },
            `committed workflow ${workflow_id} (${steps.length} steps)`,
          );
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "vision_map.harvest_session",
    {
      title: "一键沉淀本 session 内的 perform_action 序列为新 workflow",
      description:
        "比 commit_workflow 更省事：server 自动用本 session 内此 app 上跑过的（默认只取 succeeded 的）" +
        " perform_action 历史串成 steps，agent 只给 workflow_id + description 即可。" +
        "适合 agent 跑通一段操作后直接沉淀，不必重述每步 action_id / params。" +
        "若想只沉淀最近 N 步用 last_n；若想只沉淀某时间点之后用 since_ms。" +
        "对 raw click_at / type_text / press_key 等无 action_id 的工具调用不记录——" +
        "想沉淀那些请先用 add_control 把它们对应的 control 加进 map 再走 perform_action。",
      inputSchema: {
        app_id: z.string(),
        workflow_id: z.string(),
        description: z.string().optional(),
        last_n: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("只取 history 末尾 N 步；不传则取全部"),
        since_ms: z
          .number()
          .int()
          .optional()
          .describe("只取 ts ≥ since_ms 的步；不传则不按时间过滤"),
        include_failed: z
          .boolean()
          .default(false)
          .describe("默认 false 只串成功步；true 则连失败步也串进 workflow（一般不推荐）"),
        overwrite: z
          .boolean()
          .default(false)
          .describe("已存在同 id workflow 时是否覆盖；默认 false 报错"),
        timeout_ms: z.number().int().positive().default(120_000),
      },
    },
    async ({ app_id, workflow_id, description, last_n, since_ms, include_failed, overwrite, timeout_ms }) => {
      try {
        return await withApp(ctx, app_id, async (app) => {
          const all = app.sessionHistory ?? [];
          if (all.length === 0) {
            throw new VisionMcpError(
              ERROR_CODES.ACTION_NOT_FOUND,
              "本 session 内此 app 还没有 perform_action 调用记录。先用 perform_action 跑通一段操作再 harvest_session。",
            );
          }
          let filtered = include_failed ? all : all.filter((r) => r.succeeded);
          if (since_ms !== undefined) filtered = filtered.filter((r) => r.ts >= since_ms);
          if (last_n !== undefined) filtered = filtered.slice(-last_n);
          if (filtered.length === 0) {
            throw new VisionMcpError(
              ERROR_CODES.ACTION_NOT_FOUND,
              `按 last_n=${last_n} / since_ms=${since_ms} / include_failed=${include_failed} 过滤后无可沉淀的 action`,
            );
          }
          // 验证每个 action_id 在 effective map 里仍能找到
          const missing: string[] = [];
          for (const r of filtered) {
            try {
              const parsed = parseActionId(r.action_id);
              const found = findControl(app.effective, parsed.ownerId, parsed.controlId);
              if (!found) missing.push(r.action_id);
            } catch {
              missing.push(r.action_id);
            }
          }
          if (missing.length > 0) {
            throw new VisionMcpError(
              ERROR_CODES.ACTION_NOT_FOUND,
              `session history 引用了 ${missing.length} 个不存在的 action_id：${missing.slice(0, 5).join(", ")}` +
                (missing.length > 5 ? ` (+${missing.length - 5} more)` : "") +
                "。可能 map 被人工编辑过；可手动 commit_workflow 显式列 steps，或先 add_control 把这些加回来。",
            );
          }
          // 检查 workflow_id 冲突
          const existingIdx = app.map.workflows.findIndex((w) => w.id === workflow_id);
          if (existingIdx >= 0 && !overwrite) {
            throw new VisionMcpError(
              ERROR_CODES.MAP_VALIDATION_FAILED,
              `workflow ${workflow_id} 已存在；要覆盖请传 overwrite=true，或换 workflow_id`,
            );
          }
          // 构 Workflow
          const workflow = WorkflowSchema.parse({
            id: workflow_id,
            description: description ?? `harvested from session at ${new Date().toISOString()} (${filtered.length} steps)`,
            inputs: [],
            steps: filtered.map((r) => ({
              action_id: r.action_id,
              params: r.params,
              approval_required: false,
              on_failure: "abort" as const,
              // 自动加 state_should_be postcondition 让 workflow 复用时有视觉/AX 验证
              // 而不只是看 input RPC ok。如果 detect_state 没拿到 state_after 就不加。
              ...(r.state_after
                ? {
                    postcondition: {
                      type: "state_should_be" as const,
                      state_id: r.state_after,
                    },
                  }
                : {}),
            })),
            timeout_ms,
          });
          if (existingIdx >= 0) app.map.workflows[existingIdx] = workflow;
          else app.map.workflows.push(workflow);
          const { applyPatches } = await import("@vision-mcp/core");
          app.effective = applyPatches(app.map, app.patches);
          await writeEffective(app);
          return StructuredOk(
            {
              workflow_id,
              steps_count: filtered.length,
              overwritten: existingIdx >= 0,
              source: "session_history",
              total_history: all.length,
            },
            `harvested workflow ${workflow_id} from ${filtered.length} session step(s)`,
          );
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
