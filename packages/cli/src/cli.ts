import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  VisionMap,
  applyPatches,
  Capsule,
  CallbackApprovalResolver,
  createPlatformAdapter,
  DarwinAccessibilityProvider,
  DarwinHelperAdapter,
  DarwinOsascriptAdapter,
  dumpMap,
  ERROR_CODES,
  FileTraceStore,
  formatIssues,
  hasErrors,
  isVisionMcpError,
  lintMap,
  loadMap,
  RuntimeExecutor,
  saveMap,
  writePatch,
} from "@vision-mcp/core";
import type { PlatformAdapter } from "@vision-mcp/core";

function isDarwinAdapter(a: PlatformAdapter): a is DarwinOsascriptAdapter | DarwinHelperAdapter {
  return a instanceof DarwinOsascriptAdapter || a instanceof DarwinHelperAdapter;
}
import {
  createServerContext,
  createVisionMcpServer,
  runStdio,
} from "@vision-mcp/server";

interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = rest[i + 1];
      if (next === undefined || next.startsWith("--")) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      positional.push(a);
    }
  }
  return { command: command ?? "help", positional, flags };
}

function usage(): string {
  return [
    "vision-mcp <command> [...args] [--flags]",
    "",
    "命令：",
    "  init <app_id> --name <human-name> [--platform windows|macos|any] [--width 1280] [--height 800]",
    "       在当前目录的 apps/<app_id>/vision-mcp.yaml 创建骨架",
    "  validate <app_id>",
    "       lint vision-mcp.yaml + 已应用 patches",
    "  describe <app_id>",
    "       打印 app 摘要",
    "  build <app_id> [--platform mock|auto] [--mock-window]",
    "       绑定 capsule，捕获当前 state 并把控件写入 baseline",
    "  run <app_id> --action <action_id> [--params '{\"text\":\"...\"}'] [--approve-all]",
    "       通过 runtime 执行单个 action",
    "  workflow <app_id> --id <workflow_id> [--inputs '{\"key\":\"...\"}'] [--approve-all]",
    "       运行 workflow",
    "  repair <app_id> [--max-level 3]",
    "       触发 repair L0-Lmax 自动修复",
    "  trace <app_id> [--session <id>] [--limit 100]",
    "       打印最近 trace 事件",
    "  trace-viewer <app_id> [--out trace.html] [--session <id>]",
    "       生成 HTML 时间线（每个 action 含前后截图、locator、postcondition）",
    "  explore <app_id> [--out <dir>] [--no-migrate]",
    "       绑定 capsule 后截图 + dump AX 树到目录，便于人类审阅与建图",
    "  record <app_id> --plan <plan.json> [--out <dir>]",
    "       按计划脚本逐步操作，每步前后都截图+dump AX，建图前预先摸清所有页面",
    "  discover <app_id> [--out <dir>] [--max-clicks 20] [--max-depth 2]",
    "       自动 BFS 探索 UI 拓扑：每个可交互节点 click → 截图比较 → 自动找返回路径 → 生成 draft map",
    "  snapshot <app_id> [--out frame.png] [--no-image] [--max-candidates 60]",
    "       Agent 视角：一次拿截图 + AX 候选 + state match。等同于 MCP tool vision_map.snapshot",
    "  annotated <app_id> [--out frame.png] [--grid-step 0.1]",
    "       叠加网格 + 候选框 + 序号的截图：agent 看图后能说『click #7』而非估坐标",
    "  click <app_id> --norm <x,y> [--button left|right|middle] [--count 1]",
    "       直接 click 归一化坐标。等同于 MCP tool vision_map.click_at",
    "  type <app_id> --text <s> [--clear-first]",
    "       直接 type 文本（支持中文）。等同于 MCP tool vision_map.type_text",
    "  key <app_id> --combo <combo>",
    "       直接发键盘组合（return / cmd+f / Escape）。等同于 MCP tool vision_map.press_key",
    "  click-text <app_id> --text <s> [--region x,y,w,h] [--match exact|contains|regex]",
    "       用 OCR 找文字位置 click（视觉为主流程的核心工具）",
    "  hover <app_id> --norm <x,y> [--hold-ms 300]",
    "       hover 到归一化坐标（用于触发 hover-only ▶ 按钮）",
    "  click-fuzzy <app_id> --norm <x,y> [--jitter-px 8] [--attempts 5]",
    "       click 失败时自动 ±jitter 多次重试（小按钮兜底）",
    "  serve [--apps-root ./apps] [--trace-dir ./.traces] [--fallback-mock]",
    "       启动 MCP server (stdio)",
    "  schema export [--out ./schema]",
    "       导出 vision-mcp.schema.json / vision-mcp-patch.schema.json",
    "",
    "环境变量：VISION_MCP_APPS_ROOT, VISION_MCP_TRACE_DIR, VISION_MCP_NATIVE_HELPER, VISION_MCP_PLATFORM, VISION_MCP_FALLBACK_MOCK=1",
  ].join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  try {
    switch (args.command) {
      case "help":
      case "-h":
      case "--help":
        console.log(usage());
        return;
      case "init":
        await cmdInit(args);
        return;
      case "validate":
        await cmdValidate(args);
        return;
      case "describe":
        await cmdDescribe(args);
        return;
      case "build":
        await cmdBuild(args);
        return;
      case "run":
        await cmdRun(args);
        return;
      case "workflow":
        await cmdWorkflow(args);
        return;
      case "repair":
        await cmdRepair(args);
        return;
      case "trace":
        await cmdTrace(args);
        return;
      case "trace-viewer":
        await cmdTraceViewer(args);
        return;
      case "explore":
        await cmdExplore(args);
        return;
      case "record":
        await cmdRecord(args);
        return;
      case "discover":
        await cmdDiscover(args);
        return;
      case "snapshot":
        await cmdSnapshot(args);
        return;
      case "annotated":
        await cmdAnnotated(args);
        return;
      case "click":
        await cmdRawClick(args);
        return;
      case "type":
        await cmdRawType(args);
        return;
      case "key":
        await cmdRawKey(args);
        return;
      case "click-text":
        await cmdClickText(args);
        return;
      case "hover":
        await cmdHover(args);
        return;
      case "click-fuzzy":
        await cmdClickFuzzy(args);
        return;
      case "serve":
        await cmdServe(args);
        return;
      case "schema":
        await cmdSchema(args);
        return;
      default:
        console.error(`unknown command: ${args.command}\n\n${usage()}`);
        process.exit(2);
    }
  } catch (err) {
    if (isVisionMcpError(err)) {
      console.error(`[${err.code}] ${err.message}`);
      if (err.details) console.error(JSON.stringify(err.details, null, 2));
    } else {
      console.error(err);
    }
    process.exit(1);
  }
}

function appsRoot(args: ParsedArgs): string {
  return String(
    args.flags["apps-root"] ?? process.env.VISION_MCP_APPS_ROOT ?? path.join(process.cwd(), "apps"),
  );
}

async function cmdInit(args: ParsedArgs) {
  const [appId] = args.positional;
  if (!appId) throw new Error("init 需要 <app_id>");
  const name = String(args.flags.name ?? appId);
  const platform = String(args.flags.platform ?? "any") as "windows" | "macos" | "any";
  const width = Number(args.flags.width ?? 1280);
  const height = Number(args.flags.height ?? 800);
  const dir = path.join(appsRoot(args), appId);
  await fs.mkdir(dir, { recursive: true });
  const mapPath = path.join(dir, "vision-mcp.yaml");
  const map = VisionMap.parse({
    version: "0.1",
    app: { id: appId, name, platform },
    visual_box: {
      id: `${appId}-capsule`,
      mode: platform === "macos" ? "real_window" : "same_session_virtual_display",
      platform,
      coordinate_space: "normalized_client_rect",
      display: { width_px: width, height_px: height },
      contract: { require_client_size_px: [width, height] },
    },
  });
  await saveMap(mapPath, map);
  console.log(`wrote ${mapPath}`);
}

async function cmdValidate(args: ParsedArgs) {
  const [appId] = args.positional;
  if (!appId) throw new Error("validate 需要 <app_id>");
  const mapPath = path.join(appsRoot(args), appId, "vision-mcp.yaml");
  const result = await loadMap(mapPath);
  const issues = lintMap(result.effective);
  if (issues.length === 0) {
    console.log(`OK: ${mapPath}（${result.patches.length} patches）`);
    return;
  }
  console.log(formatIssues(issues));
  if (hasErrors(issues)) process.exit(1);
}

async function cmdDescribe(args: ParsedArgs) {
  const [appId] = args.positional;
  if (!appId) throw new Error("describe 需要 <app_id>");
  const mapPath = path.join(appsRoot(args), appId, "vision-mcp.yaml");
  const result = await loadMap(mapPath);
  const summary = {
    app_id: result.effective.app.id,
    name: result.effective.app.name,
    platform: result.effective.app.platform,
    visual_box: result.effective.visual_box.id,
    mode: result.effective.visual_box.mode,
    states: result.effective.states.map((s) => ({
      id: s.id,
      kind: s.kind,
      controls: s.controls.length,
    })),
    workflows: result.effective.workflows.map((w) => ({
      id: w.id,
      steps: w.steps.length,
    })),
    patches: result.patches.length,
  };
  console.log(JSON.stringify(summary, null, 2));
}

interface OpenAppOptions {
  approveAll?: boolean;
  fallbackMock?: boolean;
  platform?: "auto" | "windows" | "macos" | "mock";
  /** 默认 true：在创建 runtime 之前，自动 ensureDisplay + attach + migrate。 */
  autoAttach?: boolean;
}

async function openAppRuntime(
  appId: string,
  args: ParsedArgs,
  opts: OpenAppOptions = {},
) {
  const mapPath = path.join(appsRoot(args), appId, "vision-mcp.yaml");
  const loaded = await loadMap(mapPath);
  const adapter = await createPlatformAdapter({
    platform: opts.platform ?? "auto",
    fallbackToMock: opts.fallbackMock ?? Boolean(args.flags["fallback-mock"]),
    helperPath: process.env.VISION_MCP_NATIVE_HELPER,
  });
  const capsule = new Capsule(loaded.effective.visual_box, adapter, loaded.effective.input_lease_policy);
  const traceDir = path.join(appsRoot(args), ".traces", appId);
  const trace = new FileTraceStore(traceDir);
  await trace.ensure();
  // 在 macOS 上自动注入 accessibility provider（helper 或 osascript adapter 都支持）
  const providers: import("@vision-mcp/core").LocatorProviders = {};
  if (isDarwinAdapter(adapter)) {
    providers.accessibility = new DarwinAccessibilityProvider(adapter);
  }
  // 默认 auto-attach：用户运行 `vision-mcp run apple-music --action ...` 时不应被迫
  // 先手动 attach。如不需要，可显式传 autoAttach=false。
  if ((opts.autoAttach ?? true) && loaded.effective.visual_box.target_window) {
    const display = await capsule.ensureDisplay({
      geometry: loaded.effective.visual_box.display,
      mode: loaded.effective.visual_box.mode,
      fallbacks: loaded.effective.visual_box.fallbacks,
    });
    try {
      await capsule.attach({ target: loaded.effective.visual_box.target_window });
      await capsule.migrate(display.id);
    } catch (err) {
      console.error(
        `[vision-mcp] auto-attach 失败：${(err as Error).message}。可手动调用 'vision-mcp explore <app>' 检查窗口是否打开。`,
      );
      throw err;
    }
  }
  // 每次 openAppRuntime 启新 session，让 trace-viewer 默认指向本次操作
  const session = await trace.startSession({
    app_id: appId,
    visual_box_id: loaded.effective.visual_box.id,
    mode: loaded.effective.visual_box.mode,
  });
  const runtime = new RuntimeExecutor({
    map: loaded.effective,
    mapBaseDir: loaded.baseDir,
    capsule,
    providers,
    trace,
    sessionId: session.id,
    approval: opts.approveAll
      ? new CallbackApprovalResolver(async () => "granted")
      : new CallbackApprovalResolver(askApprovalViaStdin),
    onPatch: async (patch) => {
      await writePatch(loaded.baseDir, patch);
      loaded.patches.push(patch);
      loaded.effective = applyPatches(loaded.baseline, loaded.patches);
    },
  });
  return { runtime, capsule, loaded, trace, adapter, session };
}

async function cmdBuild(args: ParsedArgs) {
  const [appId] = args.positional;
  if (!appId) throw new Error("build 需要 <app_id>");
  const { capsule, loaded } = await openAppRuntime(appId, args, {
    fallbackMock: true,
    platform: args.flags.platform === "mock" ? "mock" : "auto",
  });
  if (args.flags["mock-window"]) {
    const { MockPlatformAdapter } = await import("@vision-mcp/core");
    if (capsule.adapter instanceof MockPlatformAdapter) {
      capsule.adapter.addWindow({
        title: "Mock Capsule Window",
        process_name: loaded.effective.app.id + ".mock",
        bounds: {
          x: 0,
          y: 0,
          width: loaded.effective.visual_box.display.width_px,
          height: loaded.effective.visual_box.display.height_px,
        },
        is_foreground: true,
      });
    }
  }
  const display = await capsule.ensureDisplay({
    geometry: loaded.effective.visual_box.display,
    mode: loaded.effective.visual_box.mode,
    fallbacks: loaded.effective.visual_box.fallbacks,
  });
  if (loaded.effective.visual_box.target_window) {
    await capsule.attach({ target: loaded.effective.visual_box.target_window });
  } else {
    // 对 mock：用任意窗口
    const wins = await capsule.adapter.listWindows();
    if (wins.length) {
      await capsule.attach({ target: { title_regex: wins[0].title.slice(0, 4) } });
    }
  }
  await capsule.migrate(display.id);
  const { MapBuilder } = await import("@vision-mcp/core");
  const builder = new MapBuilder({
    app: loaded.effective.app,
    visualBoxId: loaded.effective.visual_box.id,
    capsule,
    providers: {},
    outDir: loaded.baseDir,
  });
  const captured = await builder.captureCurrent({
    id: String(args.flags["state"] ?? "auto_capture"),
    description: "auto captured via cli build",
  });
  const state = builder.appendStateFromCapture(captured);
  await saveMap(loaded.baselinePath, builder.current());
  console.log(
    `wrote ${loaded.baselinePath}: state=${state.id} controls=${state.controls.length} anchors=${state.anchors.length}`,
  );
}

async function cmdRun(args: ParsedArgs) {
  const [appId] = args.positional;
  if (!appId) throw new Error("run 需要 <app_id>");
  const actionId = String(args.flags.action ?? "");
  if (!actionId) throw new Error("run 需要 --action <action_id>");
  const params = args.flags.params ? JSON.parse(String(args.flags.params)) : {};
  const { runtime, capsule } = await openAppRuntime(appId, args, {
    approveAll: Boolean(args.flags["approve-all"]),
    fallbackMock: true,
  });
  const result = await runtime.performAction(actionId, params);
  console.log(JSON.stringify(result, null, 2));
  await capsule.adapter.dispose?.();
}

async function cmdWorkflow(args: ParsedArgs) {
  const [appId] = args.positional;
  if (!appId) throw new Error("workflow 需要 <app_id>");
  const wfId = String(args.flags.id ?? "");
  if (!wfId) throw new Error("workflow 需要 --id <workflow_id>");
  const inputs = args.flags.inputs ? JSON.parse(String(args.flags.inputs)) : {};
  const { runtime, capsule } = await openAppRuntime(appId, args, {
    approveAll: Boolean(args.flags["approve-all"]),
    fallbackMock: true,
  });
  const result = await runtime.runWorkflow(wfId, inputs);
  console.log(JSON.stringify(result, null, 2));
  await capsule.adapter.dispose?.();
}

async function cmdRepair(args: ParsedArgs) {
  const [appId] = args.positional;
  if (!appId) throw new Error("repair 需要 <app_id>");
  const max = Number(args.flags["max-level"] ?? 3);
  const { runtime, capsule } = await openAppRuntime(appId, args, { fallbackMock: true });
  const r = await runtime.repairAttempt(max);
  console.log(JSON.stringify(r, null, 2));
  await capsule.adapter.dispose?.();
}

async function cmdTrace(args: ParsedArgs) {
  const [appId] = args.positional;
  if (!appId) throw new Error("trace 需要 <app_id>");
  const dir = path.join(appsRoot(args), ".traces", appId);
  const trace = new FileTraceStore(dir);
  await trace.ensure();
  const sessions = await trace.listSessions();
  const limit = Number(args.flags.limit ?? 100);
  const sessionId = args.flags.session ? String(args.flags.session) : undefined;
  const events = await trace.query({ sessionId, limit });
  console.log(
    JSON.stringify(
      {
        sessions: sessions.slice(-5),
        events,
      },
      null,
      2,
    ),
  );
}

async function cmdExplore(args: ParsedArgs) {
  const [appId] = args.positional;
  if (!appId) throw new Error("explore 需要 <app_id>");
  const mapPath = path.join(appsRoot(args), appId, "vision-mcp.yaml");
  const loaded = await loadMap(mapPath);
  const outDir = String(args.flags.out ?? path.join(appsRoot(args), appId, ".explore"));
  await fs.mkdir(outDir, { recursive: true });
  const adapter = await createPlatformAdapter({
    platform: (args.flags.platform as never) ?? "auto",
    fallbackToMock: Boolean(args.flags["fallback-mock"]),
  });
  const { Capsule, DarwinAccessibilityProvider, DarwinOsascriptAdapter } = await import(
    "@vision-mcp/core"
  );
  const capsule = new Capsule(loaded.effective.visual_box, adapter, loaded.effective.input_lease_policy);
  const display = await capsule.ensureDisplay({
    geometry: loaded.effective.visual_box.display,
    mode: loaded.effective.visual_box.mode,
    fallbacks: loaded.effective.visual_box.fallbacks,
  });
  if (loaded.effective.visual_box.target_window) {
    await capsule.attach({ target: loaded.effective.visual_box.target_window });
  }
  if (!args.flags["no-migrate"]) {
    await capsule.migrate(display.id);
  }
  await new Promise((r) => setTimeout(r, 600));
  const status = await capsule.status();
  const frame = await capsule.capture();
  // 也单独 screencapture 出一份 PNG 便于人类肉眼审阅
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileP = promisify(execFile);
  const pngPath = path.join(outDir, "frame.png");
  const cr = status.geometry?.client_rect_px;
  if (cr && adapter.platform === "macos") {
    await execFileP("/usr/sbin/screencapture", [
      "-x",
      "-t",
      "png",
      "-R",
      `${cr.x},${cr.y},${cr.width},${cr.height}`,
      pngPath,
    ]).catch(() => {});
  }
  const metaPath = path.join(outDir, "meta.json");
  await fs.writeFile(
    metaPath,
    JSON.stringify(
      {
        app_id: appId,
        status,
        frame: {
          width_px: frame.width_px,
          height_px: frame.height_px,
          captured_at: frame.captured_at,
          source: frame.source,
        },
      },
      null,
      2,
    ),
  );
  // 如果是 darwin，dump AX
  let axNodes: unknown[] = [];
  if (status.attached_window && isDarwinAdapter(adapter)) {
    const provider = new DarwinAccessibilityProvider(adapter);
    axNodes = await provider.snapshot(status.attached_window.native_handle);
    await fs.writeFile(path.join(outDir, "ax.json"), JSON.stringify(axNodes, null, 2));
  }
  // 输出汇总
  console.log(
    JSON.stringify(
      {
        out_dir: outDir,
        frame_path: pngPath,
        meta_path: metaPath,
        ax_node_count: axNodes.length,
        attached_window: status.attached_window?.title,
      },
      null,
      2,
    ),
  );
  await adapter.dispose?.();
}

/**
 * `vision-mcp record <app_id> --plan plan.json`
 *
 * plan.json 形式：
 * {
 *   "name": "apple-music-search-play",
 *   "steps": [
 *     { "label": "home" },                                       // 初始状态：仅 dump 当前页
 *     { "label": "after-sidebar-search", "click_norm": [0.085, 0.085] },
 *     { "label": "after-type", "type": "张学友", "clear_first": true,
 *       "click_norm": [0.481, 0.033], "click_first": true },
 *     { "label": "after-return", "key": "return" },
 *     { "label": "after-play",  "double_click_norm": [0.341, 0.134], "wait_ms": 2000 }
 *   ]
 * }
 *
 * 每步执行后会在 out/<label>/{frame.png, ax.json, meta.json} 输出，
 * 同时打印一份汇总，便于用户照着写 vision-mcp.yaml。
 */
async function cmdRecord(args: ParsedArgs) {
  const [appId] = args.positional;
  if (!appId) throw new Error("record 需要 <app_id>");
  const planFile = String(args.flags.plan ?? "");
  if (!planFile) throw new Error("record 需要 --plan <plan.json>");
  const plan = JSON.parse(await fs.readFile(planFile, "utf8")) as {
    name?: string;
    steps: Array<{
      label: string;
      click_norm?: [number, number];
      double_click_norm?: [number, number];
      click_first?: boolean;
      type?: string;
      clear_first?: boolean;
      key?: string;
      wait_ms?: number;
      raise?: boolean;
    }>;
  };
  const outRoot = String(
    args.flags.out ?? path.join(appsRoot(args), appId, ".record", plan.name ?? Date.now().toString()),
  );
  await fs.mkdir(outRoot, { recursive: true });

  const mapPath = path.join(appsRoot(args), appId, "vision-mcp.yaml");
  const loaded = await loadMap(mapPath);
  const adapter = await createPlatformAdapter({
    platform: (args.flags.platform as never) ?? "auto",
  });
  const { Capsule, DarwinAccessibilityProvider } = await import("@vision-mcp/core");
  const capsule = new Capsule(loaded.effective.visual_box, adapter, loaded.effective.input_lease_policy);
  const display = await capsule.ensureDisplay({
    geometry: loaded.effective.visual_box.display,
    mode: loaded.effective.visual_box.mode,
    fallbacks: loaded.effective.visual_box.fallbacks,
  });
  if (loaded.effective.visual_box.target_window) {
    await capsule.attach({ target: loaded.effective.visual_box.target_window });
  }
  await capsule.migrate(display.id);
  await new Promise((r) => setTimeout(r, 500));

  const provider = isDarwinAdapter(adapter) ? new DarwinAccessibilityProvider(adapter) : undefined;

  const summary: Array<{ label: string; out_dir: string; ax_count: number; key_nodes: unknown }> = [];

  async function dumpStep(label: string): Promise<void> {
    const dir = path.join(outRoot, label.replace(/[^a-zA-Z0-9_.\-]/g, "_"));
    await fs.mkdir(dir, { recursive: true });
    const status = await capsule.status();
    const cr = status.geometry?.client_rect_px;
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileP = promisify(execFile);
    if (cr && adapter.platform === "macos") {
      await execFileP("/usr/sbin/screencapture", [
        "-x",
        "-t",
        "png",
        "-R",
        `${cr.x},${cr.y},${cr.width},${cr.height}`,
        path.join(dir, "frame.png"),
      ]).catch(() => {});
    }
    let axNodes: import("@vision-mcp/core").AccessibilityNode[] = [];
    if (provider && status.attached_window) {
      provider.invalidate(status.attached_window.native_handle);
      axNodes = await provider.snapshot(status.attached_window.native_handle);
      await fs.writeFile(path.join(dir, "ax.json"), JSON.stringify(axNodes, null, 2));
    }
    // 精简到关键候选：可交互节点 + 顶部独有节点
    const keys = axNodes
      .filter((n) =>
        /(AXButton|AXTextField|AXSearchField|AXPopUpButton|AXCell|AXRow|AXList|AXRadioButton|AXSlider|AXMenuItem|AXLink|AXHeading)/.test(
          n.role ?? "",
        ),
      )
      .map((n) => ({
        role: n.role,
        name: n.name,
        description: n.description,
        bbox: n.bbox_norm.map((v) => Number(v.toFixed(3))),
      }));
    await fs.writeFile(
      path.join(dir, "interactive.json"),
      JSON.stringify(keys, null, 2),
    );
    await fs.writeFile(
      path.join(dir, "meta.json"),
      JSON.stringify(
        {
          label,
          attached_window: status.attached_window,
          geometry_ok: status.geometry?.ok,
        },
        null,
        2,
      ),
    );
    summary.push({ label, out_dir: dir, ax_count: axNodes.length, key_nodes: keys.length });
  }

  // 第一步：dump 当前页（home）
  await dumpStep(plan.steps[0]?.label ?? "step-0");

  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i];
    if (i === 0) continue; // already dumped
    const status = await capsule.status();
    const cr = status.geometry?.client_rect_px;
    if (!cr) throw new Error("client_rect missing");
    if (step.raise !== false) await capsule.raise().catch(() => {});
    if (step.click_first && step.click_norm) {
      const pt = {
        x: Math.round(cr.x + step.click_norm[0] * cr.width),
        y: Math.round(cr.y + step.click_norm[1] * cr.height),
      };
      await adapter.click(pt);
      await new Promise((r) => setTimeout(r, 200));
    }
    if (step.click_norm && !step.click_first) {
      const pt = {
        x: Math.round(cr.x + step.click_norm[0] * cr.width),
        y: Math.round(cr.y + step.click_norm[1] * cr.height),
      };
      await adapter.click(pt);
      await new Promise((r) => setTimeout(r, 200));
    }
    if (step.double_click_norm) {
      const pt = {
        x: Math.round(cr.x + step.double_click_norm[0] * cr.width),
        y: Math.round(cr.y + step.double_click_norm[1] * cr.height),
      };
      await adapter.click(pt, { click_count: 2 });
      await new Promise((r) => setTimeout(r, 200));
    }
    if (step.type !== undefined) {
      await adapter.typeText({ text: step.type, clear_first: step.clear_first ?? false });
    }
    if (step.key) {
      await adapter.pressKey({ combo: step.key });
    }
    if (step.wait_ms) {
      await new Promise((r) => setTimeout(r, step.wait_ms));
    }
    await dumpStep(step.label);
  }

  console.log(JSON.stringify({ out_root: outRoot, steps: summary }, null, 2));
  await adapter.dispose?.();
}

async function cmdDiscover(args: ParsedArgs) {
  const [appId] = args.positional;
  if (!appId) throw new Error("discover 需要 <app_id>");
  const mapPath = path.join(appsRoot(args), appId, "vision-mcp.yaml");
  const loaded = await loadMap(mapPath);
  const outDir = String(
    args.flags.out ?? path.join(appsRoot(args), appId, ".discover", String(Date.now())),
  );
  await fs.mkdir(outDir, { recursive: true });
  const adapter = await createPlatformAdapter({
    platform: (args.flags.platform as never) ?? "auto",
  });
  const { Capsule, DarwinAccessibilityProvider, Discoverer } = await import("@vision-mcp/core");
  const capsule = new Capsule(loaded.effective.visual_box, adapter, loaded.effective.input_lease_policy);
  const display = await capsule.ensureDisplay({
    geometry: loaded.effective.visual_box.display,
    mode: loaded.effective.visual_box.mode,
    fallbacks: loaded.effective.visual_box.fallbacks,
  });
  if (loaded.effective.visual_box.target_window) {
    await capsule.attach({ target: loaded.effective.visual_box.target_window });
  }
  await capsule.migrate(display.id);
  await new Promise((r) => setTimeout(r, 500));

  if (!isDarwinAdapter(adapter)) {
    throw new Error("discover 当前仅在 macOS 上实现");
  }
  const provider = new DarwinAccessibilityProvider(adapter);
  const discoverer = new Discoverer(capsule, adapter, provider, {
    out_dir: outDir,
    max_clicks: Number(args.flags["max-clicks"] ?? 12),
    max_depth: Number(args.flags["max-depth"] ?? 2),
    click_wait_ms: Number(args.flags["click-wait-ms"] ?? 1500),
    on_progress: (msg) => console.error(`[discover] ${msg}`),
  });
  const result = await discoverer.run();
  console.log(
    JSON.stringify(
      {
        out_dir: outDir,
        pages: result.pages.length,
        transitions: result.transitions.length,
        page_ids: result.pages.map((p) => p.id),
      },
      null,
      2,
    ),
  );
  await adapter.dispose?.();
}

// ---- agent-friendly raw subcommands（与 MCP tools 等价）-------------------

async function openCapsuleForRaw(args: ParsedArgs) {
  const [appId] = args.positional;
  if (!appId) throw new Error("需要 <app_id>");
  const mapPath = path.join(appsRoot(args), appId, "vision-mcp.yaml");
  const loaded = await loadMap(mapPath);
  const adapter = await createPlatformAdapter({ platform: (args.flags.platform as never) ?? "auto" });
  const { Capsule } = await import("@vision-mcp/core");
  const capsule = new Capsule(loaded.effective.visual_box, adapter, loaded.effective.input_lease_policy);
  const display = await capsule.ensureDisplay({
    geometry: loaded.effective.visual_box.display,
    mode: loaded.effective.visual_box.mode,
  });
  if (loaded.effective.visual_box.target_window) {
    await capsule.attach({ target: loaded.effective.visual_box.target_window });
    if (!args.flags["no-migrate"]) {
      await capsule.migrate(display.id);
    }
  }
  return { adapter, capsule, loaded };
}

/**
 * 用 swift helper 的 capture.rect_annotated 生成带网格 + 候选框 + 序号的 PNG。
 * 优先用 AX 候选（无 AX 时退化用 OCR token）作为候选 boxes。
 */
async function cmdAnnotated(args: ParsedArgs) {
  const { adapter, capsule, loaded } = await openCapsuleForRaw(args);
  const outPath = String(args.flags.out ?? "/tmp/annotated.png");
  const gridStep = Number(args.flags["grid-step"] ?? 0.1);
  const status = await capsule.status();
  const cr = status.geometry?.client_rect_px;
  if (!cr) throw new Error("client_rect missing");
  if (!isDarwinAdapter(adapter)) throw new Error("annotated 当前仅支持 macOS helper");

  // 收集候选 boxes：优先 AX，其次 OCR
  let boxes: { bbox_norm: [number, number, number, number]; label?: string }[] = [];
  let source = "none";
  const ax = new DarwinAccessibilityProvider(adapter);
  if (status.attached_window) {
    const nodes = await ax.snapshot(status.attached_window.native_handle);
    const interactive = nodes
      .filter((n) => {
        const r = n.role ?? "";
        return /(AXButton|AXTextField|AXSearchField|AXPopUpButton|AXMenuItem|AXTab|AXLink|AXCheckBox|AXRadioButton)/.test(r)
          || (r === "AXCell" && (n.name || n.description));
      })
      .slice(0, 40);
    boxes = interactive.map((n) => ({
      bbox_norm: n.bbox_norm,
      label: (n.name || n.description || n.role || "?").slice(0, 12),
    }));
    source = `ax (${boxes.length})`;
  }
  // helper 调 annotated
  const { DarwinHelperAdapter: HA } = await import("@vision-mcp/core");
  if (!(adapter instanceof HA)) {
    throw new Error("annotated 需要 swift helper（VISION_MCP_FORCE_OSASCRIPT 未设）");
  }
  const r = await adapter.helperRequest<{ png_base64: string; width: number; height: number; box_count: number }>(
    "capture.rect_annotated",
    {
      rect: { x: cr.x, y: cr.y, width: cr.width, height: cr.height },
      grid_step: gridStep,
      boxes: boxes,
    },
    20_000,
  );
  await fs.writeFile(outPath, Buffer.from(r.png_base64, "base64"));
  console.log(
    JSON.stringify(
      {
        out_path: outPath,
        width: r.width,
        height: r.height,
        box_count: r.box_count,
        candidate_source: source,
        grid_step: gridStep,
      },
      null,
      2,
    ),
  );
  await adapter.dispose?.();
}

async function cmdSnapshot(args: ParsedArgs) {
  const { adapter, capsule, loaded } = await openCapsuleForRaw(args);
  const { LocatorResolver } = await import("@vision-mcp/core");
  const provider = isDarwinAdapter(adapter) ? new DarwinAccessibilityProvider(adapter) : undefined;
  const resolver = new LocatorResolver(provider ? { accessibility: provider } : {});
  const frame = await capsule.capture();
  const insights = await resolver.analyze(frame);
  const status = await capsule.status();
  if (status.attached_window) {
    insights.window_title = status.attached_window.title;
    await resolver.setAccessibility(insights, status.attached_window.native_handle);
  }
  const stateMatch = resolver.detectState(loaded.effective, insights);
  const maxCands = Number(args.flags["max-candidates"] ?? 60);
  const candidates = insights.accessibility
    .filter((n) => {
      const r = n.role ?? "";
      return /(AXButton|AXTextField|AXSearchField|AXPopUpButton|AXMenuItem|AXTab|AXLink|AXSlider|AXCheckBox|AXRadioButton|AXList)/.test(r)
        || (r === "AXCell" && (n.name || n.description));
    })
    .slice(0, maxCands)
    .map((n) => ({
      role: n.role,
      name: n.name,
      description: n.description,
      bbox: n.bbox_norm.map((v) => Number(v.toFixed(3))),
    }));
  // --out 写 PNG 总是生效（--no-image 只是不在 JSON 里返回 base64）
  const outPath = args.flags.out ? String(args.flags.out) : undefined;
  if (outPath) {
    const cr = status.geometry?.client_rect_px;
    if (cr) {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execFileP = promisify(execFile);
      await execFileP("/usr/sbin/screencapture", [
        "-x", "-t", "png", "-R",
        `${cr.x},${cr.y},${cr.width},${cr.height}`,
        outPath,
      ]).catch(() => {});
    }
  }
  console.log(JSON.stringify({
    window: status.attached_window?.title,
    geometry_ok: status.geometry?.ok,
    state_match: stateMatch,
    candidates_total: insights.accessibility.length,
    candidates,
    visual_hash: insights.visual_hash,
    image_saved_to: outPath,
  }, null, 2));
  await adapter.dispose?.();
}

async function cmdRawClick(args: ParsedArgs) {
  const { adapter, capsule } = await openCapsuleForRaw(args);
  const normStr = String(args.flags.norm ?? "");
  const [nxs, nys] = normStr.split(",");
  const nx = Number(nxs), ny = Number(nys);
  if (!Number.isFinite(nx) || !Number.isFinite(ny)) throw new Error("--norm 形式：x,y（归一化 0-1）");
  const button = (args.flags.button as never) ?? "left";
  const count = Number(args.flags.count ?? 1);
  await capsule.raise().catch(() => {});
  const geom = await capsule.validateGeometry();
  const cr = geom.client_rect_px;
  const pt = {
    x: Math.round(cr.x + nx * cr.width),
    y: Math.round(cr.y + ny * cr.height),
  };
  await adapter.click(pt, { button, click_count: count });
  console.log(JSON.stringify({ ok: true, point: pt, point_norm: [nx, ny] }));
  await adapter.dispose?.();
}

async function cmdRawType(args: ParsedArgs) {
  const { adapter, capsule } = await openCapsuleForRaw(args);
  const text = String(args.flags.text ?? "");
  if (!text) throw new Error("type 需要 --text");
  await capsule.raise().catch(() => {});
  await adapter.typeText({ text, clear_first: Boolean(args.flags["clear-first"]) });
  console.log(JSON.stringify({ ok: true, length: text.length }));
  await adapter.dispose?.();
}

async function cmdRawKey(args: ParsedArgs) {
  const { adapter, capsule } = await openCapsuleForRaw(args);
  const combo = String(args.flags.combo ?? "");
  if (!combo) throw new Error("key 需要 --combo");
  await capsule.raise().catch(() => {});
  await adapter.pressKey({ combo });
  console.log(JSON.stringify({ ok: true, combo }));
  await adapter.dispose?.();
}

async function cmdTraceViewer(args: ParsedArgs) {
  const [appId] = args.positional;
  if (!appId) throw new Error("trace-viewer 需要 <app_id>");
  const traceDir = path.join(appsRoot(args), ".traces", appId);
  const trace = new FileTraceStore(traceDir);
  await trace.ensure();
  const sessions = await trace.listSessions();
  const sessionId = args.flags.session
    ? String(args.flags.session)
    : sessions[sessions.length - 1]?.id;
  if (!sessionId) {
    console.error("没有 trace session 可渲染");
    process.exit(1);
  }
  const events = await trace.query({ sessionId });
  const session = sessions.find((s) => s.id === sessionId);
  const outPath = String(args.flags.out ?? path.join(traceDir, `trace-${sessionId}.html`));
  const html = renderTraceHtml(appId, session, events);
  await fs.writeFile(outPath, html, "utf8");
  console.log(
    JSON.stringify(
      {
        out: outPath,
        session_id: sessionId,
        event_count: events.length,
        events_with_screenshot: events.filter((e) => (e.asset_refs?.length ?? 0) > 0).length,
      },
      null,
      2,
    ),
  );
}

function renderTraceHtml(
  appId: string,
  session: import("@vision-mcp/core").TraceSession | undefined,
  events: import("@vision-mcp/core").TraceEventBase[],
): string {
  const kindColors: Record<string, string> = {
    action_started: "#3b82f6",
    action_succeeded: "#10b981",
    action_failed: "#ef4444",
    state_detected: "#8b5cf6",
    repair_attempted: "#f59e0b",
    repair_succeeded: "#10b981",
    postcondition_failed: "#f97316",
    approval_requested: "#a855f7",
    approval_granted: "#10b981",
    approval_denied: "#ef4444",
    lease_acquired: "#64748b",
    lease_broken: "#64748b",
    warning: "#f59e0b",
    error: "#ef4444",
  };
  const rows = events.map((e, i) => {
    const color = kindColors[e.kind] ?? "#64748b";
    const screenshots = (e.asset_refs ?? [])
      .map((p) => {
        // path 是绝对路径；HTML 里用 file:// URI
        const uri = p.startsWith("/") ? `file://${p}` : p;
        return `<a href="${uri}" target="_blank"><img src="${uri}" loading="lazy" /></a>`;
      })
      .join("");
    const detail = e.detail ? `<pre>${escapeHtml(JSON.stringify(e.detail, null, 2))}</pre>` : "";
    return `<tr>
      <td class="i">${i + 1}</td>
      <td class="ts">${e.ts.slice(11, 19)}</td>
      <td><span class="kind" style="background:${color}">${e.kind}</span></td>
      <td class="msg">${escapeHtml(e.message)}${detail}</td>
      <td class="ax">${e.action_id ?? ""}${e.state_id ? `<br><span class="state">${e.state_id}</span>` : ""}</td>
      <td class="shots">${screenshots}</td>
    </tr>`;
  }).join("");
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>vision-mcp trace ${appId}</title>
<style>
  body { font: 13px/1.5 -apple-system, system-ui, sans-serif; margin: 16px; background: #f7f7f8; color: #1a1a1a; }
  h1 { margin: 0 0 4px; }
  .meta { color: #666; font-size: 12px; margin-bottom: 16px; }
  table { border-collapse: collapse; width: 100%; background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
  th, td { padding: 8px 10px; border-bottom: 1px solid #eee; vertical-align: top; }
  th { background: #f1f3f5; text-align: left; font-weight: 600; }
  td.i { color: #888; width: 36px; text-align: right; }
  td.ts { color: #888; width: 72px; font-variant-numeric: tabular-nums; }
  .kind { display: inline-block; padding: 2px 8px; border-radius: 4px; color: #fff; font-size: 11px; font-weight: 600; }
  td.msg { max-width: 480px; }
  td.msg pre { margin: 4px 0 0; padding: 6px 8px; background: #f6f8fa; border-radius: 4px; font-size: 11px; max-height: 120px; overflow: auto; }
  td.ax { font-family: ui-monospace, monospace; font-size: 12px; color: #444; }
  td.ax .state { color: #8b5cf6; font-size: 11px; }
  td.shots { width: 320px; }
  td.shots img { width: 150px; height: auto; margin: 2px; border: 1px solid #ddd; border-radius: 4px; cursor: zoom-in; }
</style></head>
<body>
<h1>vision-mcp trace · ${appId}</h1>
<div class="meta">session: <code>${session?.id ?? "?"}</code> · status: ${session?.status ?? "?"} · started: ${session?.started_at ?? "?"} · events: ${events.length}</div>
<table>
  <thead><tr><th>#</th><th>time</th><th>kind</th><th>message / detail</th><th>action / state</th><th>screenshots (before · after)</th></tr></thead>
  <tbody>${rows}</tbody>
</table>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** click-text：OCR 找文字 → click 其中心。视觉路线的关键工具。 */
async function cmdClickText(args: ParsedArgs) {
  const { adapter, capsule } = await openCapsuleForRaw(args);
  const text = String(args.flags.text ?? "");
  if (!text) throw new Error("click-text 需要 --text");
  const match = (args.flags.match as "exact" | "contains" | "regex") ?? "contains";
  const { DarwinHelperAdapter: HA, DarwinOcrProvider } = await import("@vision-mcp/core");
  if (!(adapter instanceof HA)) throw new Error("click-text 当前需要 swift helper（含 Vision OCR）");
  const ocr = new DarwinOcrProvider(adapter);
  const status = await capsule.status();
  const cr = status.geometry?.client_rect_px;
  if (!cr) throw new Error("client_rect missing");
  let region = cr;
  if (args.flags.region) {
    const [nx, ny, nw, nh] = String(args.flags.region).split(",").map(Number);
    region = {
      x: Math.round(cr.x + nx * cr.width),
      y: Math.round(cr.y + ny * cr.height),
      width: Math.round(nw * cr.width),
      height: Math.round(nh * cr.height),
    };
  }
  const tokens = await ocr.recognizeRect(region);
  const compare = (a: string, b: string) => {
    if (match === "regex") {
      try { return new RegExp(b).test(a); } catch { return false; }
    }
    const A = a.replace(/\s+/g, "").toLowerCase();
    const B = b.replace(/\s+/g, "").toLowerCase();
    return match === "exact" ? A === B : A.includes(B);
  };
  // tokens 单 token 或拼接连续 token
  let hit = tokens.find((t) => compare(t.text, text));
  if (!hit) {
    for (let i = 0; i < tokens.length; i++) {
      let combined = tokens[i].text;
      for (let j = i + 1; j < tokens.length && combined.length < text.length + 8; j++) {
        combined += tokens[j].text;
        if (compare(combined, text)) {
          hit = { ...tokens[i], text: combined };
          break;
        }
      }
      if (hit) break;
    }
  }
  if (!hit) {
    console.log(JSON.stringify({ ok: false, reason: "text not found", tokens_seen: tokens.length }));
    process.exit(2);
  }
  // bbox_norm 是相对 region 的；转屏幕坐标
  const [bx, by, bw, bh] = hit.bbox_norm;
  const pt = {
    x: Math.round(region.x + (bx + bw / 2) * region.width),
    y: Math.round(region.y + (by + bh / 2) * region.height),
  };
  await capsule.raise().catch(() => {});
  await adapter.click(pt);
  console.log(
    JSON.stringify({
      ok: true,
      matched_text: hit.text,
      confidence: hit.confidence,
      point: pt,
    }),
  );
  await adapter.dispose?.();
}

/** hover：移到坐标 + 等待，触发 hover-only 控件（如卡片浮动 ▶）。 */
async function cmdHover(args: ParsedArgs) {
  const { adapter, capsule } = await openCapsuleForRaw(args);
  const [nxs, nys] = String(args.flags.norm ?? "").split(",");
  const nx = Number(nxs), ny = Number(nys);
  if (!Number.isFinite(nx) || !Number.isFinite(ny)) throw new Error("hover 需要 --norm x,y");
  const holdMs = Number(args.flags["hold-ms"] ?? 300);
  await capsule.raise().catch(() => {});
  const cr = (await capsule.validateGeometry()).client_rect_px;
  const pt = { x: Math.round(cr.x + nx * cr.width), y: Math.round(cr.y + ny * cr.height) };
  // 用 drag 0 距离实现 hover（mouseMoved CGEvent）
  await adapter.drag(pt, { to_point_px: pt, steps: 1, duration_ms: holdMs });
  console.log(JSON.stringify({ ok: true, point: pt, hold_ms: holdMs }));
  await adapter.dispose?.();
}

/** click-fuzzy：click 失败时围绕 ±jitter 自动重试（小按钮兜底）。 */
async function cmdClickFuzzy(args: ParsedArgs) {
  const { adapter, capsule } = await openCapsuleForRaw(args);
  const [nxs, nys] = String(args.flags.norm ?? "").split(",");
  const nx = Number(nxs), ny = Number(nys);
  if (!Number.isFinite(nx) || !Number.isFinite(ny)) throw new Error("click-fuzzy 需要 --norm x,y");
  const jitter = Number(args.flags["jitter-px"] ?? 8);
  const attempts = Number(args.flags.attempts ?? 5);
  await capsule.raise().catch(() => {});
  const cr = (await capsule.validateGeometry()).client_rect_px;
  // visual_hash baseline 用 capture frame 算 dHash 判断变化
  const { DHashProvider } = await import("@vision-mcp/core");
  const hasher = new DHashProvider();
  const baselineFrame = await capsule.capture();
  const baselineHash = await hasher.hash(baselineFrame);
  // 候选点：中心 + ±jitter 4 方向 + 4 对角线
  const center = { x: Math.round(cr.x + nx * cr.width), y: Math.round(cr.y + ny * cr.height) };
  const allOffsets: Array<[number, number]> = [
    [0, 0],
    [jitter, 0], [-jitter, 0], [0, jitter], [0, -jitter],
    [jitter, jitter], [jitter, -jitter], [-jitter, jitter], [-jitter, -jitter],
  ];
  const offsets = allOffsets.slice(0, attempts);
  for (const [dx, dy] of offsets) {
    const pt = { x: center.x + dx, y: center.y + dy };
    await adapter.click(pt);
    await new Promise((r) => setTimeout(r, 500));
    const afterFrame = await capsule.capture();
    const afterHash = await hasher.hash(afterFrame);
    const sim = hasher.similarity(baselineHash, afterHash);
    if (sim < 0.97) {
      console.log(
        JSON.stringify({ ok: true, point: pt, offset: [dx, dy], visual_diff: 1 - sim }),
      );
      await adapter.dispose?.();
      return;
    }
  }
  console.log(JSON.stringify({ ok: false, reason: "no visual change after all attempts", attempts }));
  await adapter.dispose?.();
  process.exit(2);
}

async function cmdServe(args: ParsedArgs) {
  const ctx = await createServerContext({
    appsRoot: appsRoot(args),
    traceDir: args.flags["trace-dir"]
      ? String(args.flags["trace-dir"])
      : path.join(appsRoot(args), ".traces"),
    platformOptions: {
      platform: (args.flags.platform as never) ?? "auto",
      fallbackToMock: Boolean(args.flags["fallback-mock"]),
      helperPath: process.env.VISION_MCP_NATIVE_HELPER,
    },
  });
  const server = createVisionMcpServer(ctx);
  await runStdio(server);
}

async function cmdSchema(args: ParsedArgs) {
  const sub = args.positional[0] ?? "export";
  if (sub !== "export") throw new Error("schema 子命令仅支持 export");
  const out = String(args.flags.out ?? path.join(process.cwd(), "schema"));
  await fs.mkdir(out, { recursive: true });
  const { zodToJsonSchema } = await import("zod-to-json-schema");
  const { VisionMap, Patch } = await import("@vision-mcp/core");
  await fs.writeFile(
    path.join(out, "vision-mcp.schema.json"),
    JSON.stringify(zodToJsonSchema(VisionMap, { name: "VisionMap" }), null, 2),
  );
  await fs.writeFile(
    path.join(out, "vision-mcp-patch.schema.json"),
    JSON.stringify(zodToJsonSchema(Patch, { name: "Patch" }), null, 2),
  );
  console.log(`wrote schemas to ${out}`);
}

function askApprovalViaStdin(req: import("@vision-mcp/core").ApprovalRequest): Promise<"granted" | "denied" | "expired"> {
  return new Promise((resolve) => {
    process.stderr.write(
      `\n[审批] ${req.action_id} (${req.risk_level}) — ${req.message}\n输入 y/n 后回车：`,
    );
    process.stdin.setEncoding("utf8");
    const onData = (chunk: string) => {
      const ans = chunk.trim().toLowerCase();
      process.stdin.off("data", onData);
      resolve(ans === "y" || ans === "yes" ? "granted" : "denied");
    };
    process.stdin.on("data", onData);
    setTimeout(() => {
      process.stdin.off("data", onData);
      resolve("expired");
    }, 60_000);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
