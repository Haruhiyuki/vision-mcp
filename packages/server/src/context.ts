// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Vision-MCP Authors
import path from "node:path";
import { promises as fs } from "node:fs";
import {
  Capsule,
  CallbackApprovalResolver,
  FileTraceStore,
  LocatorProviders,
  MapBuilder,
  MapLoadResult,
  PlatformAdapter,
  RuntimeExecutor,
  VisionMap,
  applyPatches,
  createPlatformAdapter,
  dumpMap,
  loadMap,
  saveMap,
  writePatch,
} from "@vision-mcp/core";
import type {
  CreatePlatformOptions,
} from "@vision-mcp/core";
import { VisionMcpError } from "@vision-mcp/core";

export interface ServerContext {
  /** 当前主 app（按 app id 索引）。 */
  apps: Map<string, AppHandle>;
  /** 默认 trace 目录。 */
  traceDir: string;
  /** 默认 patches 目录（也可以由 map baseDir/patches 覆盖）。 */
  appsRoot: string;
  /** 共享 locator providers（OCR/visual hash 等）。 */
  providers: LocatorProviders;
  /** 平台适配器配置默认值。 */
  platformOptions: CreatePlatformOptions;
  /** 已存在的审批通道（CLI/UI 可注入）。 */
  approvalCallback?: (req: import("@vision-mcp/core").ApprovalRequest) => Promise<"granted" | "denied" | "expired">;
}

/** Session 内 perform_action 调用历史，让 harvest_session 一键沉淀。 */
export interface SessionActionRecord {
  action_id: string;
  params?: Record<string, unknown>;
  ts: number;
  /** 失败的不算（commit_workflow 只串成功步骤）。 */
  succeeded: boolean;
  /** 动作后 detect_state 推断的 state_id，让 harvest_session 自动加 state_should_be postcondition。 */
  state_after?: string;
}

export interface AppHandle {
  app_id: string;
  baseDir: string;
  mapPath: string;
  map: VisionMap;
  patches: MapLoadResult["patches"];
  effective: VisionMap;
  /**
   * quick-look 临时会话：磁盘上没有 vision-mcp.yaml，map 是内存骨架。
   * patches 不落盘；vision_map.init 同 app_id 后自动升级为持久 map。
   */
  ephemeral?: boolean;
  capsule?: Capsule;
  adapter?: PlatformAdapter;
  /** 本 server 进程内此 app 上的 perform_action 历史，供 harvest_session 使用。 */
  sessionHistory?: SessionActionRecord[];
  trace?: FileTraceStore;
  runtime?: RuntimeExecutor;
  builder?: MapBuilder;
  /**
   * 原始 yaml Document 实例（loadMap 时保留），writeEffective 用它作为基底走增量 save，
   * 避免每次 commit 把手编 yaml 的注释 / 格式 / 字段顺序破坏。
   */
  baselineDoc?: MapLoadResult["baselineDoc"];
}

export async function createServerContext(opts: {
  appsRoot: string;
  traceDir?: string;
  providers?: LocatorProviders;
  platformOptions?: CreatePlatformOptions;
}): Promise<ServerContext> {
  await fs.mkdir(opts.appsRoot, { recursive: true });
  return {
    apps: new Map(),
    appsRoot: path.resolve(opts.appsRoot),
    traceDir: path.resolve(opts.traceDir ?? path.join(opts.appsRoot, ".traces")),
    providers: opts.providers ?? {},
    platformOptions: opts.platformOptions ?? { platform: "auto", fallbackToMock: false },
  };
}

export async function loadApp(
  ctx: ServerContext,
  appId: string,
  opts: { allowEphemeral?: boolean } = {},
): Promise<AppHandle> {
  const existing = ctx.apps.get(appId);
  if (existing) return existing;
  const candidates = [
    path.join(ctx.appsRoot, appId, "vision-mcp.yaml"),
    path.join(ctx.appsRoot, appId, "vision-mcp.yml"),
  ];
  let mapPath: string | undefined;
  for (const c of candidates) {
    try {
      await fs.access(c);
      mapPath = c;
      break;
    } catch {}
  }
  if (!mapPath) {
    if (opts.allowEphemeral) return createEphemeralApp(ctx, appId);
    throw new VisionMcpError(
      "MAP_VALIDATION_FAILED",
      `未找到 app "${appId}" 的 vision-mcp.yaml（搜索：${candidates.join(", ")}）`,
    );
  }
  const result = await loadMap(mapPath);
  const handle: AppHandle = {
    app_id: appId,
    baseDir: result.baseDir,
    mapPath: result.baselinePath,
    map: result.baseline,
    patches: result.patches,
    effective: result.effective,
    baselineDoc: result.baselineDoc,
  };
  ctx.apps.set(appId, handle);
  return handle;
}

/**
 * quick-look 临时会话：不要求磁盘上有 vision-mcp.yaml。
 * 「吸附窗口看一眼」不该先走 init 建骨架的仪式——contract 不约束尺寸，
 * 探索完想沉淀再 vision_map.init 升级为持久 map。
 */
function createEphemeralApp(ctx: ServerContext, appId: string): AppHandle {
  const platform =
    process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "any";
  const map = VisionMap.parse({
    version: "0.1",
    app: { id: appId, name: appId, platform },
    visual_box: {
      id: `${appId}-capsule`,
      mode: platform === "macos" ? "real_window" : "same_session_virtual_display",
      platform,
      coordinate_space: "normalized_client_rect",
      display: { width_px: 1280, height_px: 800 },
      // 不写 require_client_size_px：quick-look 不约束窗口尺寸
      contract: {},
    },
  });
  const baseDir = path.join(ctx.appsRoot, appId);
  const handle: AppHandle = {
    app_id: appId,
    baseDir,
    mapPath: path.join(baseDir, "vision-mcp.yaml"),
    map,
    patches: [],
    effective: map,
    ephemeral: true,
  };
  ctx.apps.set(appId, handle);
  return handle;
}

export async function listApps(ctx: ServerContext): Promise<{ app_id: string; map_path: string }[]> {
  const out: { app_id: string; map_path: string }[] = [];
  const entries = await fs.readdir(ctx.appsRoot, { withFileTypes: true });
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const yaml = path.join(ctx.appsRoot, e.name, "vision-mcp.yaml");
    try {
      await fs.access(yaml);
      out.push({ app_id: e.name, map_path: yaml });
    } catch {}
  }
  return out;
}

export async function ensureCapsule(
  ctx: ServerContext,
  app: AppHandle,
): Promise<Capsule> {
  if (app.capsule && app.adapter) return app.capsule;
  // restore_window 后 capsule 会被清掉重建，但 adapter（native helper 进程）复用
  const adapter = app.adapter ?? (await createPlatformAdapter(ctx.platformOptions));
  const capsule = new Capsule(app.effective.visual_box, adapter, app.effective.input_lease_policy);
  app.adapter = adapter;
  app.capsule = capsule;
  // 自动注入平台默认 providers（macOS：AX + OCR；Windows：UIA + OCR）。
  // Agent 探索时 snapshot 拿 OCR token 辅助定位、postcondition 评估 OCR-class
  // condition、locator_priority 走 OCR 兜底，都依赖这里注入的 provider。
  const {
    DarwinOsascriptAdapter,
    DarwinHelperAdapter,
    DarwinAccessibilityProvider,
    DarwinOcrProvider,
    WindowsPlatformAdapter,
    WindowsAccessibilityProvider,
    WindowsOcrProvider,
  } = await import("@vision-mcp/core");
  if (
    (adapter instanceof DarwinOsascriptAdapter || adapter instanceof DarwinHelperAdapter) &&
    !ctx.providers.accessibility
  ) {
    ctx.providers.accessibility = new DarwinAccessibilityProvider(adapter);
  }
  if (adapter instanceof DarwinHelperAdapter && !ctx.providers.ocr) {
    ctx.providers.ocr = new DarwinOcrProvider(adapter);
  }
  if (adapter instanceof WindowsPlatformAdapter && !ctx.providers.accessibility) {
    ctx.providers.accessibility = new WindowsAccessibilityProvider(adapter);
  }
  if (adapter instanceof WindowsPlatformAdapter && !ctx.providers.ocr) {
    ctx.providers.ocr = new WindowsOcrProvider(adapter);
  }
  return capsule;
}

export async function ensureRuntime(
  ctx: ServerContext,
  app: AppHandle,
): Promise<RuntimeExecutor> {
  if (app.runtime) return app.runtime;
  const capsule = await ensureCapsule(ctx, app);
  app.trace ??= new FileTraceStore(path.join(ctx.traceDir, app.app_id));
  await app.trace.ensure();
  // 每次 ensureRuntime 启一个新 session，方便 trace-viewer 看最近一次操作
  const session = await app.trace.startSession({
    app_id: app.app_id,
    visual_box_id: app.effective.visual_box.id,
    mode: app.effective.visual_box.mode,
  });
  const runtime = new RuntimeExecutor({
    map: app.effective,
    mapBaseDir: app.baseDir,
    capsule,
    providers: ctx.providers,
    trace: app.trace,
    sessionId: session.id,
    approval: ctx.approvalCallback
      ? new CallbackApprovalResolver(ctx.approvalCallback)
      : undefined,
    onPatch: async (patch) => {
      // ephemeral 会话没有磁盘 map 目录，patch 只在内存生效
      if (!app.ephemeral) await writePatch(app.baseDir, patch);
      app.patches.push(patch);
      app.effective = applyPatches(app.map, app.patches);
    },
  });
  app.runtime = runtime;
  return runtime;
}

export async function ensureBuilder(
  ctx: ServerContext,
  app: AppHandle,
): Promise<MapBuilder> {
  if (app.builder) return app.builder;
  const capsule = await ensureCapsule(ctx, app);
  app.builder = new MapBuilder({
    app: app.effective.app,
    visualBoxId: app.effective.visual_box.id,
    capsule,
    providers: ctx.providers,
    outDir: app.baseDir,
  });
  return app.builder;
}

export async function writeEffective(app: AppHandle): Promise<void> {
  // ephemeral 会话首次沉淀（commit_state 等）= 隐式 init：建目录后转持久 map
  if (app.ephemeral) {
    await fs.mkdir(app.baseDir, { recursive: true });
    app.ephemeral = false;
  }
  // 走增量改路径（如果有原 baselineDoc）：保留注释 + 字段顺序 + 手编 yaml 格式。
  // 没有 baselineDoc 的 fallback（如 init 首次写）走完整 dumpMap。
  await saveMap(app.mapPath, app.map, { baselineDoc: app.baselineDoc });
}

export function snapshotApp(app: AppHandle): Record<string, unknown> {
  return {
    app_id: app.app_id,
    map_path: app.mapPath,
    base_dir: app.baseDir,
    states: app.effective.states.length,
    workflows: app.effective.workflows.length,
    visual_box: app.effective.visual_box.id,
    patches: app.patches.length,
  };
}

export { dumpMap };
