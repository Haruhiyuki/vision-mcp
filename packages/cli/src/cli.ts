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
    "  click <app_id> --norm <x,y> [--button left|right|middle] [--count 1] [--cursor virtual|physical]",
    "       直接 click 归一化坐标。--cursor virtual 在点击后还原鼠标位置（不抢用户主屏光标）",
    "  ax-press <app_id> --norm <x,y>",
    "       用 AX-press 操作 norm 位置元素：完全不动鼠标，能点屏外/半屏外窗口（off-screen workspace 必备）",
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
    "  scroll-until-text <app_id> --text <s> [--region x,y,w,h] [--dy -200] [--max-scrolls 20] [--click]",
    "       在 region 内反复滚动 + OCR 找文字；找到后返回 bbox 或直接 click",
    "  hover-probe <app_id> --norm <x,y> [--hold-ms 600] [--out probe.png]",
    "       hover 后截图与原图 diff，找出 hover 触发的新元素位置",
    "  hover-then-click <app_id> --hover-norm <x,y> [--click-norm <x,y>] [--hold-ms 600] [--auto-find]",
    "       hover 后再 click。--auto-find 时自动 click 到 hover-probe 找到的新元素位置（卡片浮动 ▶ 典型场景）",
    "  snapshot-crop <app_id> --region x,y,w,h --out crop.png",
    "       只截 region 部分；省 agent context（不返回全屏 PNG）",
    "  snapshot-tile <app_id> [--cols 3] [--rows 3] [--out-dir tiles/]",
    "       把当前帧切成 N×M 网格，输出 N×M 张 thumb；agent 用来快速定位感兴趣区域",
    "  verify-map <app_id> --baseline <dir> [--update]",
    "       回归测试：跑 plan 后对比 baseline 截图，visual_diff 超阈值报警；--update 写新 baseline",
    "  displays [--json]",
    "       列出当前所有显示器 + 自动评分推荐 workspace（macOS 兼 Sidecar/AirPlay/虚拟驱动）",
    "  capsule <app_id> [--display <id>] [--off-screen] [--restore-on-exit]",
    "       一键 ensureDisplay + attach + migrate；--off-screen 无副屏时启用屏外工作区",
    "  restore <app_id>",
    "       把窗口迁回 attach 前的原 placement（off-screen workspace 也可用此命令唤回主屏）",
    "  live-view <app_id> [--port 7575] [--interval-ms 500]",
    "       在浏览器实时查看 capsule workspace（http://localhost:port）：含画面 + 接管按钮",
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
      case "ax-press":
        await cmdAxPress(args);
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
      case "scroll-until-text":
        await cmdScrollUntilText(args);
        return;
      case "hover-probe":
        await cmdHoverProbe(args);
        return;
      case "hover-then-click":
        await cmdHoverThenClick(args);
        return;
      case "snapshot-crop":
        await cmdSnapshotCrop(args);
        return;
      case "snapshot-tile":
        await cmdSnapshotTile(args);
        return;
      case "verify-map":
        await cmdVerifyMap(args);
        return;
      case "displays":
        await cmdDisplays(args);
        return;
      case "capsule":
        await cmdCapsule(args);
        return;
      case "restore":
        await cmdRestore(args);
        return;
      case "live-view":
        await cmdLiveView(args);
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
  /** 默认 true：在创建 runtime 之前，自动 attach window（拿 handle）。 */
  autoAttach?: boolean;
  /**
   * 是否在 autoAttach 时同步迁移窗口到 capsule workspace。
   * 默认 false——只 attach 不 migrate。这样后续 CLI 命令不会反复把屏外窗口拉回主屏。
   * 由 `vision-mcp capsule` 显式做迁移；`vision-mcp build` 内部传 true。
   */
  autoMigrate?: boolean;
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
  // 默认 auto-attach：拿 window handle 让后续 click/snapshot 等命令可用。
  // 默认 autoMigrate=false：不重新移动窗口，避免反复把 off-screen workspace 拉回主屏。
  // 由 `vision-mcp capsule` 显式 ensureDisplay + migrate；`vision-mcp build` 显式传 autoMigrate=true。
  if ((opts.autoAttach ?? true) && loaded.effective.visual_box.target_window) {
    try {
      await capsule.attach({ target: loaded.effective.visual_box.target_window });
      if (opts.autoMigrate) {
        const display = await capsule.ensureDisplay({
          geometry: loaded.effective.visual_box.display,
          mode: loaded.effective.visual_box.mode,
          fallbacks: loaded.effective.visual_box.fallbacks,
        });
        await capsule.migrate(display.id);
      }
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
    autoMigrate: true,
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
  // 默认仅 attach 不 migrate，避免反复把窗口拉回主屏。
  // migrate 只在显式传 --migrate 时执行（snapshot/click 等通常不需要）。
  if (loaded.effective.visual_box.target_window) {
    await capsule.attach({ target: loaded.effective.visual_box.target_window });
    if (args.flags.migrate === true) {
      const display = await capsule.ensureDisplay({
        geometry: loaded.effective.visual_box.display,
        mode: loaded.effective.visual_box.mode,
        fallbacks: loaded.effective.visual_box.fallbacks,
      });
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
    // 优先用 capsule.capture() 拿到的 RGBA frame，编码为 PNG（兼容 off-screen workspace）
    // screencapture -R 在屏外失败，必须走 capture frame 路径
    try {
      const { encodeRgbaToPng } = await import("@vision-mcp/core");
      const png = encodeRgbaToPng(frame.width_px, frame.height_px, frame.pixels);
      await fs.writeFile(outPath, png);
    } catch (err) {
      // 兜底用 screencapture（屏内窗口）
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
  const cursorMode = args.flags.cursor ? String(args.flags.cursor) : undefined;
  await capsule.raise().catch(() => {});
  const geom = await capsule.validateGeometry();
  const cr = geom.client_rect_px;
  const pt = {
    x: Math.round(cr.x + nx * cr.width),
    y: Math.round(cr.y + ny * cr.height),
  };
  await adapter.click(pt, {
    button,
    click_count: count,
    cursor_mode: cursorMode as never,
    try_ax_press: cursorMode === "ax_press",
  });
  console.log(JSON.stringify({ ok: true, point: pt, point_norm: [nx, ny], cursor_mode: cursorMode ?? "physical" }));
  await adapter.dispose?.();
}

async function cmdAxPress(args: ParsedArgs) {
  const { adapter, capsule } = await openCapsuleForRaw(args);
  const normStr = String(args.flags.norm ?? "");
  const [nxs, nys] = normStr.split(",");
  const nx = Number(nxs), ny = Number(nys);
  if (!Number.isFinite(nx) || !Number.isFinite(ny)) throw new Error("--norm 形式：x,y（归一化 0-1）");
  const status = await capsule.status();
  const handle = status.attached_window?.native_handle;
  if (!handle) throw new Error("ax-press 需要 attach 窗口");
  if (adapter.platform !== "macos") throw new Error("ax-press 仅支持 macOS（其他平台用 click 即可）");
  // 仅 DarwinHelperAdapter 有 axPressInWindow 方法
  const a = adapter as unknown as { axPressInWindow?: (h: string, n: [number, number]) => Promise<unknown> };
  if (!a.axPressInWindow) throw new Error("当前 macOS adapter 不支持 ax_press（需重新编译 swift helper）");
  const r = await a.axPressInWindow(handle, [nx, ny]);
  console.log(JSON.stringify(r, null, 2));
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

/**
 * scroll-until-text: 在 region 内反复滚动 + OCR 找目标文字。
 *
 * 用法："从播放列表里找'黑色游行'并播放" →
 *   vision-mcp scroll-until-text apple-music --text "黑色游行" --region "0.17,0.05,0.6,0.85" --click
 *
 * 算法：
 *   1. 在 region 内做 OCR；命中目标文本 → 返回 / click（可选）。
 *   2. 没命中 → 在 region 中点 scroll dy；记录该次 OCR token signature。
 *   3. 若连续两次 scroll 后 token signature 不变 → 列表到底，停止。
 *   4. 超过 max-scrolls → 报失败。
 *
 * 对纯视觉路线至关重要：无 AX 的列表元素也能找到。
 */
async function cmdScrollUntilText(args: ParsedArgs) {
  const { adapter, capsule } = await openCapsuleForRaw(args);
  const text = String(args.flags.text ?? "");
  if (!text) throw new Error("scroll-until-text 需要 --text");
  const { DarwinHelperAdapter: HA, DarwinOcrProvider } = await import("@vision-mcp/core");
  if (!(adapter instanceof HA)) throw new Error("scroll-until-text 需要 swift helper (OCR)");
  const ocr = new DarwinOcrProvider(adapter);
  const cr = (await capsule.validateGeometry()).client_rect_px;
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
  const dy = Number(args.flags.dy ?? -200);  // 负值向下滚（屏幕内容上移）
  const maxScrolls = Number(args.flags["max-scrolls"] ?? 20);
  const shouldClick = Boolean(args.flags.click);
  const matchMode = (args.flags.match as "exact" | "contains" | "regex") ?? "contains";

  const compare = (a: string, b: string) => {
    if (matchMode === "regex") {
      try { return new RegExp(b).test(a); } catch { return false; }
    }
    const A = a.replace(/\s+/g, "").toLowerCase();
    const B = b.replace(/\s+/g, "").toLowerCase();
    return matchMode === "exact" ? A === B : A.includes(B);
  };

  const scrollCenter = {
    x: Math.round(region.x + region.width / 2),
    y: Math.round(region.y + region.height / 2),
  };
  // 滚动前先 hover 到 region 中央，避免 scroll 事件被发到错误窗口
  await capsule.raise().catch(() => {});

  let lastSignature = "";
  let stuckCount = 0;
  for (let attempt = 0; attempt <= maxScrolls; attempt++) {
    const tokens = await ocr.recognizeRect(region, { nocache: true });
    let hit = tokens.find((t) => compare(t.text, text));
    if (!hit) {
      // 尝试拼接相邻 token
      for (let i = 0; i < tokens.length; i++) {
        let combined = tokens[i].text;
        for (let j = i + 1; j < Math.min(i + 4, tokens.length); j++) {
          combined += tokens[j].text;
          if (compare(combined, text)) {
            hit = { ...tokens[i], text: combined };
            break;
          }
        }
        if (hit) break;
      }
    }
    if (hit) {
      const [bx, by, bw, bh] = hit.bbox_norm;
      const pt = {
        x: Math.round(region.x + (bx + bw / 2) * region.width),
        y: Math.round(region.y + (by + bh / 2) * region.height),
      };
      if (shouldClick) {
        await capsule.raise().catch(() => {});
        await adapter.click(pt, { click_count: Number(args.flags["click-count"] ?? 1) });
      }
      console.log(
        JSON.stringify({
          ok: true,
          attempts: attempt,
          matched_text: hit.text,
          confidence: hit.confidence,
          point: pt,
          clicked: shouldClick,
        }),
      );
      await adapter.dispose?.();
      return;
    }
    // signature：当前 OCR 看到的前 8 个 token，用于判断列表是否还在变
    const sig = tokens.slice(0, 8).map((t) => t.text).join("|");
    if (sig === lastSignature) {
      stuckCount++;
      if (stuckCount >= 2) {
        console.log(
          JSON.stringify({ ok: false, reason: "scroll stuck (end of list?)", attempts: attempt, last_signature_tokens: 8 }),
        );
        await adapter.dispose?.();
        process.exit(2);
      }
    } else {
      stuckCount = 0;
    }
    lastSignature = sig;
    if (attempt < maxScrolls) {
      await adapter.scroll(scrollCenter, { dy_px: dy, dx_px: 0 });
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  console.log(JSON.stringify({ ok: false, reason: "max-scrolls exceeded", attempts: maxScrolls }));
  await adapter.dispose?.();
  process.exit(2);
}

/**
 * hover-probe: hover 到目标坐标 + 等待，然后截图 vs hover 前对比，
 * 找出 hover 触发出现的新元素（如卡片浮动 ▶ 按钮）。
 *
 * 算法：
 *   1. 截图 baseline。
 *   2. 把鼠标移到目标坐标 + 等 hold-ms。
 *   3. 截图 after。
 *   4. 对 hover 中心附近一定半径内的区域逐块对比像素 diff，找到变化最大的子区域。
 *   5. 输出 {新出现的元素 bbox_norm（相对 client_rect）} 供 agent 决定是否 click。
 */
async function cmdHoverProbe(args: ParsedArgs) {
  const { adapter, capsule } = await openCapsuleForRaw(args);
  const [nxs, nys] = String(args.flags.norm ?? "").split(",");
  const nx = Number(nxs), ny = Number(nys);
  if (!Number.isFinite(nx) || !Number.isFinite(ny)) throw new Error("hover-probe 需要 --norm x,y");
  const holdMs = Number(args.flags["hold-ms"] ?? 600);
  const outPath = args.flags.out ? String(args.flags.out) : undefined;
  await capsule.raise().catch(() => {});
  const cr = (await capsule.validateGeometry()).client_rect_px;
  // baseline frame：先把鼠标移到 region 外（左上角附近）
  const safePt = { x: cr.x + 5, y: cr.y + 5 };
  await adapter.drag(safePt, { to_point_px: safePt, steps: 1, duration_ms: 100 });
  await new Promise((r) => setTimeout(r, 200));
  const baseFrame = await capsule.capture();
  // hover 到目标
  const hoverPt = { x: Math.round(cr.x + nx * cr.width), y: Math.round(cr.y + ny * cr.height) };
  await adapter.drag(hoverPt, { to_point_px: hoverPt, steps: 1, duration_ms: holdMs });
  await new Promise((r) => setTimeout(r, holdMs));
  const afterFrame = await capsule.capture();

  // 像素 diff：在 hover 中心 ±200 norm 范围内分块统计
  const w = baseFrame.width_px;
  const h = baseFrame.height_px;
  const radiusXPx = Math.round(0.15 * cr.width * 2);  // 区域宽
  const radiusYPx = Math.round(0.15 * cr.height * 2);
  // hover 屏幕坐标 → frame 坐标（frame 是 client_rect 内容，origin = client_rect.xy）
  const fx = Math.max(0, Math.round((hoverPt.x - cr.x) / cr.width * w));
  const fy = Math.max(0, Math.round((hoverPt.y - cr.y) / cr.height * h));
  const x0 = Math.max(0, fx - radiusXPx);
  const y0 = Math.max(0, fy - radiusYPx);
  const x1 = Math.min(w, fx + radiusXPx);
  const y1 = Math.min(h, fy + radiusYPx);

  const blockSize = 20;
  let maxDiff = 0;
  let hotBlock = { x: 0, y: 0, score: 0 };
  for (let by = y0; by < y1 - blockSize; by += blockSize) {
    for (let bx = x0; bx < x1 - blockSize; bx += blockSize) {
      let d = 0;
      for (let yy = 0; yy < blockSize; yy++) {
        for (let xx = 0; xx < blockSize; xx++) {
          const idx = ((by + yy) * w + (bx + xx)) * 4;
          const dr = (baseFrame.pixels[idx] ?? 0) - (afterFrame.pixels[idx] ?? 0);
          const dg = (baseFrame.pixels[idx + 1] ?? 0) - (afterFrame.pixels[idx + 1] ?? 0);
          const db = (baseFrame.pixels[idx + 2] ?? 0) - (afterFrame.pixels[idx + 2] ?? 0);
          d += Math.abs(dr) + Math.abs(dg) + Math.abs(db);
        }
      }
      if (d > maxDiff) {
        maxDiff = d;
        hotBlock = { x: bx, y: by, score: d };
      }
    }
  }
  const hotBboxNorm = [
    hotBlock.x / w,
    hotBlock.y / h,
    blockSize / w,
    blockSize / h,
  ];
  // 输出 after 截图，便于 agent 看
  if (outPath) {
    const { encodeRgbaToPng } = await import("@vision-mcp/core");
    await fs.writeFile(outPath, encodeRgbaToPng(w, h, afterFrame.pixels));
  }
  const significantChange = maxDiff > 5000; // 总像素差阈值
  console.log(
    JSON.stringify({
      ok: significantChange,
      hover_point_norm: [nx, ny],
      hot_block_bbox_norm: hotBboxNorm.map((v) => Number(v.toFixed(4))),
      max_block_diff: maxDiff,
      threshold: 5000,
      after_image: outPath,
      hint: significantChange
        ? `hover 触发了新元素出现在 ~(${hotBboxNorm[0].toFixed(3)}, ${hotBboxNorm[1].toFixed(3)})`
        : "hover 后没有明显视觉变化",
    }),
  );
  await adapter.dispose?.();
}

/**
 * hover-then-click: 复合动作
 *   1. 移到 hover-norm 位置 + 持续 hold-ms（触发 hover-only 控件出现）
 *   2. 如果传了 --click-norm，click 该位置；否则跳到 3
 *   3. --auto-find：对 hover 前后做 visual diff，找出新出现的元素，click 它
 *
 * 解决卡片浮动 ▶ 按钮、tooltip 按钮等"必须 hover 才点得到"的场景。
 */
async function cmdHoverThenClick(args: ParsedArgs) {
  const { adapter, capsule } = await openCapsuleForRaw(args);
  const [hxs, hys] = String(args.flags["hover-norm"] ?? "").split(",");
  const hx = Number(hxs), hy = Number(hys);
  if (!Number.isFinite(hx) || !Number.isFinite(hy))
    throw new Error("hover-then-click 需要 --hover-norm x,y");
  const holdMs = Number(args.flags["hold-ms"] ?? 600);
  const autoFind = Boolean(args.flags["auto-find"]);
  const clickNormStr = args.flags["click-norm"] as string | undefined;

  await capsule.raise().catch(() => {});
  const cr = (await capsule.validateGeometry()).client_rect_px;
  const safePt = { x: cr.x + 5, y: cr.y + 5 };
  // baseline：先把鼠标放窗口角，再 capture
  await adapter.drag(safePt, { to_point_px: safePt, steps: 1, duration_ms: 100 });
  await new Promise((r) => setTimeout(r, 200));
  const baseFrame = autoFind ? await capsule.capture() : undefined;

  // 移动并 hover
  const hoverPt = { x: Math.round(cr.x + hx * cr.width), y: Math.round(cr.y + hy * cr.height) };
  await adapter.drag(hoverPt, { to_point_px: hoverPt, steps: 1, duration_ms: holdMs });
  await new Promise((r) => setTimeout(r, holdMs));

  let clickAt: { x: number; y: number };
  if (clickNormStr) {
    const [cnx, cny] = clickNormStr.split(",").map(Number);
    clickAt = { x: Math.round(cr.x + cnx * cr.width), y: Math.round(cr.y + cny * cr.height) };
  } else if (autoFind && baseFrame) {
    // 复用 hover-probe 的 diff 算法找 hot block
    const afterFrame = await capsule.capture();
    const w = baseFrame.width_px;
    const h = baseFrame.height_px;
    const radiusX = Math.round(0.15 * cr.width * 2);
    const radiusY = Math.round(0.15 * cr.height * 2);
    const fx = Math.max(0, Math.round((hoverPt.x - cr.x) / cr.width * w));
    const fy = Math.max(0, Math.round((hoverPt.y - cr.y) / cr.height * h));
    const x0 = Math.max(0, fx - radiusX);
    const y0 = Math.max(0, fy - radiusY);
    const x1 = Math.min(w, fx + radiusX);
    const y1 = Math.min(h, fy + radiusY);
    const block = 20;
    let maxDiff = 0;
    let hotBlock = { x: fx, y: fy };
    for (let by = y0; by < y1 - block; by += block) {
      for (let bx = x0; bx < x1 - block; bx += block) {
        let d = 0;
        for (let yy = 0; yy < block; yy++) {
          for (let xx = 0; xx < block; xx++) {
            const idx = ((by + yy) * w + (bx + xx)) * 4;
            d +=
              Math.abs((baseFrame.pixels[idx] ?? 0) - (afterFrame.pixels[idx] ?? 0)) +
              Math.abs((baseFrame.pixels[idx + 1] ?? 0) - (afterFrame.pixels[idx + 1] ?? 0)) +
              Math.abs((baseFrame.pixels[idx + 2] ?? 0) - (afterFrame.pixels[idx + 2] ?? 0));
          }
        }
        if (d > maxDiff) {
          maxDiff = d;
          hotBlock = { x: bx, y: by };
        }
      }
    }
    if (maxDiff < 5000) {
      console.log(
        JSON.stringify({ ok: false, reason: "hover 后无明显新元素出现", max_diff: maxDiff }),
      );
      await adapter.dispose?.();
      process.exit(2);
    }
    // hot block 像素坐标 → 屏幕坐标
    clickAt = {
      x: cr.x + Math.round(((hotBlock.x + block / 2) / w) * cr.width),
      y: cr.y + Math.round(((hotBlock.y + block / 2) / h) * cr.height),
    };
  } else {
    // 既没显式 click 又没 auto-find：默认 click hover 位置
    clickAt = hoverPt;
  }
  await adapter.click(clickAt, { click_count: Number(args.flags["click-count"] ?? 1) });
  console.log(
    JSON.stringify({
      ok: true,
      hover_point: hoverPt,
      click_point: clickAt,
      auto_find: autoFind,
    }),
  );
  await adapter.dispose?.();
}

/** snapshot-crop: 只截屏幕 region 子部分，省 agent context。 */
async function cmdSnapshotCrop(args: ParsedArgs) {
  const { adapter, capsule } = await openCapsuleForRaw(args);
  const outPath = String(args.flags.out ?? "/tmp/crop.png");
  if (!args.flags.region) throw new Error("snapshot-crop 需要 --region x,y,w,h（归一化）");
  const [nx, ny, nw, nh] = String(args.flags.region).split(",").map(Number);
  const cr = (await capsule.validateGeometry()).client_rect_px;
  const rect = {
    x: Math.round(cr.x + nx * cr.width),
    y: Math.round(cr.y + ny * cr.height),
    width: Math.round(nw * cr.width),
    height: Math.round(nh * cr.height),
  };
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileP = promisify(execFile);
  await execFileP("/usr/sbin/screencapture", [
    "-x", "-t", "png", "-R",
    `${rect.x},${rect.y},${rect.width},${rect.height}`,
    outPath,
  ]);
  console.log(JSON.stringify({ ok: true, out: outPath, region_screen: rect }));
  await adapter.dispose?.();
}

/** snapshot-tile: 把当前帧切成 N×M thumb 网格，输出多张小图。 */
async function cmdSnapshotTile(args: ParsedArgs) {
  const { adapter, capsule } = await openCapsuleForRaw(args);
  const cols = Number(args.flags.cols ?? 3);
  const rows = Number(args.flags.rows ?? 3);
  const outDir = String(args.flags["out-dir"] ?? "/tmp/tiles");
  await fs.mkdir(outDir, { recursive: true });
  const cr = (await capsule.validateGeometry()).client_rect_px;
  const tileW = Math.floor(cr.width / cols);
  const tileH = Math.floor(cr.height / rows);
  const tiles: Array<{ row: number; col: number; out: string; region_norm: [number, number, number, number] }> = [];
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileP = promisify(execFile);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = cr.x + c * tileW;
      const y = cr.y + r * tileH;
      const filename = `tile_r${r}_c${c}.png`;
      const fullPath = path.join(outDir, filename);
      await execFileP("/usr/sbin/screencapture", [
        "-x", "-t", "png", "-R",
        `${x},${y},${tileW},${tileH}`,
        fullPath,
      ]).catch(() => {});
      tiles.push({
        row: r,
        col: c,
        out: fullPath,
        region_norm: [c / cols, r / rows, 1 / cols, 1 / rows],
      });
    }
  }
  console.log(JSON.stringify({ ok: true, cols, rows, tiles }, null, 2));
  await adapter.dispose?.();
}

/**
 * verify-map: 回归测试 map 是否仍然有效。
 *
 * 工作流：
 *   1. 跑 `--plan plan.json` 中定义的 action 序列（与 record 命令同 plan 格式）。
 *   2. 每步执行后，截图 baseline 内对应步骤的 ref.png 做 dHash 对比。
 *   3. similarity < threshold 时 fail，输出 diff 报告。
 *   4. `--update` 模式：把当前 step 截图作为新 baseline 写回。
 *
 * 适合 CI：app 更新后用同一个 plan 跑一遍，发现哪些步骤的 UI 变了。
 */
async function cmdVerifyMap(args: ParsedArgs) {
  const [appId] = args.positional;
  if (!appId) throw new Error("verify-map 需要 <app_id>");
  const baselineDir = String(args.flags.baseline ?? path.join(appsRoot(args), appId, "baseline"));
  const planFile = String(args.flags.plan ?? path.join(appsRoot(args), appId, "plans", "regression.json"));
  const update = Boolean(args.flags.update);
  const threshold = Number(args.flags["min-similarity"] ?? 0.9);

  const plan = JSON.parse(await fs.readFile(planFile, "utf8")) as {
    name?: string;
    steps: Array<{
      label: string;
      click_norm?: [number, number];
      double_click_norm?: [number, number];
      type?: string;
      clear_first?: boolean;
      key?: string;
      wait_ms?: number;
    }>;
  };
  await fs.mkdir(baselineDir, { recursive: true });
  const { adapter, capsule } = await openCapsuleForRaw(args);
  const { DHashProvider, encodeRgbaToPng } = await import("@vision-mcp/core");
  const hasher = new DHashProvider();
  const results: Array<{ label: string; similarity: number; status: "ok" | "fail" | "new"; baseline?: string }> = [];

  for (const step of plan.steps) {
    // 执行 step
    const cr = (await capsule.validateGeometry()).client_rect_px;
    if (step.click_norm) {
      await capsule.raise().catch(() => {});
      await adapter.click({
        x: Math.round(cr.x + step.click_norm[0] * cr.width),
        y: Math.round(cr.y + step.click_norm[1] * cr.height),
      });
      await new Promise((r) => setTimeout(r, 300));
    }
    if (step.double_click_norm) {
      await adapter.click({
        x: Math.round(cr.x + step.double_click_norm[0] * cr.width),
        y: Math.round(cr.y + step.double_click_norm[1] * cr.height),
      }, { click_count: 2 });
      await new Promise((r) => setTimeout(r, 300));
    }
    if (step.type !== undefined) {
      await adapter.typeText({ text: step.type, clear_first: step.clear_first ?? false });
    }
    if (step.key) await adapter.pressKey({ combo: step.key });
    if (step.wait_ms) await new Promise((r) => setTimeout(r, step.wait_ms));
    // 截图与 baseline 对比
    const frame = await capsule.capture();
    const png = encodeRgbaToPng(frame.width_px, frame.height_px, frame.pixels);
    const safeLabel = step.label.replace(/[^a-zA-Z0-9_.\-]/g, "_");
    const baselinePath = path.join(baselineDir, `${safeLabel}.png`);
    const baselineHashPath = path.join(baselineDir, `${safeLabel}.hash`);
    const currentHash = await hasher.hash(frame);
    if (update) {
      await fs.writeFile(baselinePath, png);
      await fs.writeFile(baselineHashPath, currentHash);
      results.push({ label: step.label, similarity: 1, status: "new" });
      continue;
    }
    // 拿历史 hash
    let baseHash: string | undefined;
    try {
      baseHash = (await fs.readFile(baselineHashPath, "utf8")).trim();
    } catch {}
    if (!baseHash) {
      results.push({ label: step.label, similarity: 0, status: "new" });
      continue;
    }
    const sim = hasher.similarity(baseHash, currentHash);
    results.push({
      label: step.label,
      similarity: sim,
      status: sim >= threshold ? "ok" : "fail",
      baseline: baselinePath,
    });
  }
  const failed = results.filter((r) => r.status === "fail");
  console.log(JSON.stringify({
    plan: plan.name,
    update,
    threshold,
    results,
    summary: {
      total: results.length,
      ok: results.filter((r) => r.status === "ok").length,
      fail: failed.length,
      new: results.filter((r) => r.status === "new").length,
    },
  }, null, 2));
  await adapter.dispose?.();
  if (failed.length > 0) process.exit(2);
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

// ============== macOS workspace display 命令族 ==============

async function cmdDisplays(args: ParsedArgs) {
  const adapter = await createPlatformAdapter({
    platform: "auto",
    fallbackToMock: Boolean(args.flags["fallback-mock"]),
    helperPath: process.env.VISION_MCP_NATIVE_HELPER,
  });
  const { describeDisplay, pickWorkspaceDisplay } = await import("@vision-mcp/core");
  const displays = await adapter.listDisplays();
  const pick = pickWorkspaceDisplay(displays, { minClient: { width: 1280, height: 800 } });
  if (args.flags.json) {
    console.log(JSON.stringify({ displays, recommended: pick.display?.id ?? null, scored: pick.scored }, null, 2));
  } else {
    console.log("Displays:");
    for (const d of displays) {
      const isRec = pick.display?.id === d.id ? "  ⇐ recommended workspace" : "";
      console.log("  " + describeDisplay(d) + isRec);
    }
    if (!pick.display) {
      console.log("\n⚠️  没有真实 workspace 显示器。可选方案：");
      console.log("  1. 连接副屏 / 启用 Sidecar / AirPlay");
      console.log("  2. 安装 BetterDisplay / Deskreen 等虚拟显示驱动");
      console.log("  3. 用 `vision-mcp capsule <app> --off-screen` 启用屏外工作区（窗口移到主屏外，配合 live-view 查看）");
    }
  }
  await adapter.dispose?.();
}

async function cmdCapsule(args: ParsedArgs) {
  const [appId] = args.positional;
  if (!appId) throw new Error("capsule 需要 <app_id>");
  const mapPath = path.join(appsRoot(args), appId, "vision-mcp.yaml");
  const loaded = await loadMap(mapPath);
  const adapter = await createPlatformAdapter({
    platform: "auto",
    helperPath: process.env.VISION_MCP_NATIVE_HELPER,
  });
  const capsule = new Capsule(loaded.effective.visual_box, adapter, loaded.effective.input_lease_policy);
  const requestedDisplay = args.flags.display ? String(args.flags.display) : undefined;
  const offScreen = Boolean(args.flags["off-screen"]);

  let display;
  if (requestedDisplay) {
    const all = await adapter.listDisplays();
    const found = all.find((d) => d.id === requestedDisplay);
    if (!found) throw new Error(`display ${requestedDisplay} 不存在。可用：${all.map((d) => d.id).join(", ")}`);
    display = found;
    (capsule as unknown as { display: typeof found }).display = found;
  } else {
    display = await capsule.ensureDisplay({
      geometry: loaded.effective.visual_box.display,
      mode: offScreen ? "off_screen" : loaded.effective.visual_box.mode,
      fallbacks: loaded.effective.visual_box.fallbacks,
      allowOffScreen: offScreen,
    });
  }
  console.log(`[capsule] workspace display: ${display.id} (${display.kind ?? "?"}) bounds=${JSON.stringify(display.bounds)}`);

  if (!loaded.effective.visual_box.target_window) {
    throw new Error(`vision-mcp.yaml 缺少 visual_box.target_window，无法 attach`);
  }
  const win = await capsule.attach({ target: loaded.effective.visual_box.target_window });
  console.log(`[capsule] attached window: pid=${win.process_id} title="${win.title}" bounds=${JSON.stringify(win.bounds)}`);

  const moved = await capsule.migrate(display.id);
  console.log(`[capsule] migrated to ${display.id}: bounds=${JSON.stringify(moved.bounds)}`);

  console.log(JSON.stringify({
    capsule_id: capsule.id,
    display, window: moved,
    note: offScreen
      ? "窗口已移到主屏外。运行 `vision-mcp live-view " + appId + "` 在浏览器查看；`vision-mcp restore " + appId + "` 唤回主屏。"
      : "窗口已迁入 workspace display。",
  }, null, 2));
  await adapter.dispose?.();
}

async function cmdRestore(args: ParsedArgs) {
  const [appId] = args.positional;
  if (!appId) throw new Error("restore 需要 <app_id>");
  const mapPath = path.join(appsRoot(args), appId, "vision-mcp.yaml");
  const loaded = await loadMap(mapPath);
  const adapter = await createPlatformAdapter({
    platform: "auto",
    helperPath: process.env.VISION_MCP_NATIVE_HELPER,
  });
  const capsule = new Capsule(loaded.effective.visual_box, adapter, loaded.effective.input_lease_policy);

  if (!loaded.effective.visual_box.target_window) {
    throw new Error(`vision-mcp.yaml 缺少 visual_box.target_window`);
  }
  const win = await capsule.attach({ target: loaded.effective.visual_box.target_window });
  // 把窗口移回主屏中央（restore 默认行为：因为我们没有真实快照——用户可能上次没用 capsule 来 attach）
  const all = await adapter.listDisplays();
  const primary = all.find((d) => d.is_primary) ?? all[0];
  const w = loaded.effective.visual_box.display.width_px;
  const h = loaded.effective.visual_box.display.height_px;
  const x = primary.work_area.x + Math.max(0, Math.floor((primary.work_area.width - w) / 2));
  const y = primary.work_area.y + Math.max(0, Math.floor((primary.work_area.height - h) / 2));
  const moved = await adapter.moveWindow(win.native_handle, { x, y, width: w, height: h });
  console.log(`[restore] moved to primary ${primary.id} center: bounds=${JSON.stringify(moved.bounds)}`);
  await adapter.dispose?.();
}

async function cmdLiveView(args: ParsedArgs) {
  const [appId] = args.positional;
  if (!appId) throw new Error("live-view 需要 <app_id>");
  const port = Number(args.flags.port ?? 7575);
  const intervalMs = Number(args.flags["interval-ms"] ?? 500);
  const mapPath = path.join(appsRoot(args), appId, "vision-mcp.yaml");
  const loaded = await loadMap(mapPath);
  const adapter = await createPlatformAdapter({
    platform: "auto",
    helperPath: process.env.VISION_MCP_NATIVE_HELPER,
  });
  const capsule = new Capsule(loaded.effective.visual_box, adapter, loaded.effective.input_lease_policy);

  if (!loaded.effective.visual_box.target_window) {
    throw new Error(`vision-mcp.yaml 缺少 visual_box.target_window，live-view 需要先 attach`);
  }
  await capsule.attach({ target: loaded.effective.visual_box.target_window });

  // 直接 capture window（works for both real workspace and off-screen）
  const http = await import("node:http");
  const server = http.createServer(async (req, res) => {
    try {
      if (req.url === "/" || req.url === "/index.html") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderLiveViewHtml(appId, port, intervalMs));
        return;
      }
      if (req.url === "/frame.png") {
        const frame = await capsule.capture({ source: "window" });
        const png = await encodeFrameAsPng(frame);
        res.writeHead(200, {
          "Content-Type": "image/png",
          "Cache-Control": "no-store",
        });
        res.end(png);
        return;
      }
      if (req.url === "/takeover" && req.method === "POST") {
        // 接管：把窗口迁回主屏，让用户能直接操作
        const all = await adapter.listDisplays();
        const primary = all.find((d) => d.is_primary) ?? all[0];
        const w = loaded.effective.visual_box.display.width_px;
        const h = loaded.effective.visual_box.display.height_px;
        const x = primary.work_area.x + Math.max(0, Math.floor((primary.work_area.width - w) / 2));
        const y = primary.work_area.y + Math.max(0, Math.floor((primary.work_area.height - h) / 2));
        const wins = await adapter.listWindows(loaded.effective.visual_box.target_window);
        if (wins[0]) {
          await adapter.moveWindow(wins[0].native_handle, { x, y, width: w, height: h });
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, note: "已迁回主屏。capsule 已暂停。" }));
        return;
      }
      res.writeHead(404).end();
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  });
  await new Promise<void>((resolve) => server.listen(port, () => resolve()));
  console.log(`[live-view] http://localhost:${port}/  (Ctrl+C 退出)`);
  console.log(`[live-view] 接管按钮: POST /takeover —— 会把窗口迁回主屏`);
  // 保持进程
  await new Promise(() => {});
}

function renderLiveViewHtml(appId: string, port: number, intervalMs: number): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>vision-mcp live-view: ${appId}</title>
<style>
body { margin:0; font-family:-apple-system,system-ui,sans-serif; background:#111; color:#eee; }
header { padding:8px 16px; background:#222; display:flex; align-items:center; gap:12px; }
header h1 { font-size:14px; margin:0; }
button { padding:6px 14px; background:#c64; color:#fff; border:none; border-radius:4px; cursor:pointer; }
button:hover { background:#e83; }
.frame { padding:16px; text-align:center; }
img { max-width:100%; height:auto; border:1px solid #333; box-shadow:0 4px 20px rgba(0,0,0,0.5); }
.meta { padding:4px 16px; font-size:12px; color:#888; }
</style></head>
<body>
<header>
  <h1>📺 vision-mcp live-view — ${appId}</h1>
  <span class="meta">poll ${intervalMs}ms · port ${port}</span>
  <button onclick="takeover()">⏸ 接管 (迁回主屏)</button>
</header>
<div class="frame"><img id="f" src="/frame.png"></div>
<div class="meta" id="status">streaming…</div>
<script>
const img = document.getElementById('f');
const status = document.getElementById('status');
let n = 0;
setInterval(() => {
  img.src = '/frame.png?t=' + Date.now();
  n++;
  status.textContent = 'frame #' + n + ' @ ' + new Date().toLocaleTimeString();
}, ${intervalMs});
async function takeover() {
  const r = await fetch('/takeover', { method: 'POST' });
  const j = await r.json();
  alert(j.note ?? j.error ?? 'done');
}
</script>
</body></html>`;
}

/** 把 RGBA Frame 编码为 PNG（用 core 提供的 encodeRgbaToPng）。 */
async function encodeFrameAsPng(frame: { width_px: number; height_px: number; pixels: Uint8Array }): Promise<Buffer> {
  const { encodeRgbaToPng } = await import("@vision-mcp/core");
  return encodeRgbaToPng(frame.width_px, frame.height_px, frame.pixels);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
