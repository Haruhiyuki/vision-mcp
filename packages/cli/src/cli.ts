import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
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
  WindowsAccessibilityProvider,
  WindowsPlatformAdapter,
  writePatch,
} from "@vision-mcp/core";
import type { AccessibilityProvider, PlatformAdapter } from "@vision-mcp/core";

function isDarwinAdapter(a: PlatformAdapter): a is DarwinOsascriptAdapter | DarwinHelperAdapter {
  return a instanceof DarwinOsascriptAdapter || a instanceof DarwinHelperAdapter;
}

/**
 * 平台无关地拿一个 AccessibilityProvider。
 * - macOS：osascript / helper adapter → DarwinAccessibilityProvider
 * - Windows：WindowsPlatformAdapter → WindowsAccessibilityProvider（走 helper ax.dump）
 * - mock：undefined（snapshot 仍能跑，只是 candidates 空）
 */
function makeAccessibilityProvider(a: PlatformAdapter): AccessibilityProvider | undefined {
  if (isDarwinAdapter(a)) return new DarwinAccessibilityProvider(a);
  if (a instanceof WindowsPlatformAdapter) return new WindowsAccessibilityProvider(a);
  return undefined;
}

/**
 * 平台无关地拿一个 OcrProvider（有 recognizeRect 方法）。
 * - macOS swift helper → DarwinOcrProvider（Vision framework）
 * - Windows → WindowsOcrProvider（Windows.Media.Ocr WinRT）
 * - osascript / mock：undefined → 调用方应该报错或跳过 OCR 步骤
 *
 * 返回的 provider 都暴露 recognizeRect(screenRect, opts)；click-text /
 * scroll-until-text 等 OCR-依赖命令应通过这层而不是 instanceof DarwinHelperAdapter。
 */
type RectOcrProvider = {
  recognizeRect(
    screenRect: { x: number; y: number; width: number; height: number },
    options?: { nocache?: boolean },
  ): Promise<Array<{ text: string; confidence: number; bbox_norm: [number, number, number, number] }>>;
  invalidate?(): void;
};
async function makeOcrProvider(a: PlatformAdapter): Promise<RectOcrProvider | undefined> {
  const { DarwinHelperAdapter, DarwinOcrProvider, WindowsOcrProvider: WinOcr } = await import("@vision-mcp/core");
  if (a instanceof DarwinHelperAdapter) return new DarwinOcrProvider(a);
  if (a instanceof WindowsPlatformAdapter) return new WinOcr(a);
  return undefined;
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
    "  patch <app_id> --state <id> --control <id> [--bbox-norm x,y,w,h] [--partial <json>] [--reason <text>] [--trust session_only|trusted|untrusted_proposal]",
    "       主动写一个 control patch（修正 bbox 或 locator）。agent 在实战中发现 map 偏差时应直接调用，逐步把 map 校准到位",
    "  patches <app_id>",
    "       列出 app 当前所有已应用的 patch",
    "  trace <app_id> [--session <id>] [--limit 100]",
    "       打印最近 trace 事件",
    "  trace-viewer <app_id> [--out trace.html] [--session <id>]",
    "       生成 HTML 时间线（每个 action 含前后截图、locator、postcondition）",
    "  explore <app_id> [--out <dir>] [--no-migrate]",
    "       绑定 capsule 后截图 + dump AX 树到目录，便于人类审阅与探索",
    "  record <app_id> --plan <plan.json> [--out <dir>]",
    "       按计划脚本逐步操作，每步前后都截图+dump AX，探索时预先摸清所有页面",
    "  discover <app_id> [--out <dir>] [--max-clicks 20] [--max-depth 2]",
    "       自动 BFS 探索 UI 拓扑：每个可交互节点 click → 截图比较 → 自动找返回路径 → 生成 draft map",
    "  snapshot <app_id> [--out frame.png] [--no-image] [--max-candidates 60]",
    "       Agent 视角：一次拿截图 + AX 候选 + state match。等同于 MCP tool vision_map.snapshot",
    "  annotated <app_id> [--out frame.png] [--grid-step 0.1]",
    "       叠加网格 + 候选框 + 序号的截图：agent 看图后能说『click #7』而非估坐标",
    "  click <app_id> --norm <x,y> [--button left|right|middle] [--count 1]",
    "       直接 click 归一化坐标。等同于 MCP tool vision_map.click_at",
    "  ax-press <app_id> --norm <x,y>",
    "       macOS 高级：用 AX 直接对 norm 位置元素发 AXPress（不依赖鼠标坐标，对有 AXPress action 的元素更稳）",
    "  type <app_id> --text <s> [--clear-first]",
    "       直接 type 文本（支持中文）。等同于 MCP tool vision_map.type_text",
    "  key <app_id> --combo <combo>",
    "       直接发键盘组合（return / cmd+f / Escape）。等同于 MCP tool vision_map.press_key",
    "  scroll <app_id> --norm <x,y> [--dy 120] [--dx 0]",
    "       在 norm 坐标发滚轮。dy 正=向下（一格=120 WHEEL_DELTA）",
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
    "       列出当前所有显示器及类型（不创建虚拟显示器）",
    "  capsule <app_id> [--display <id>]",
    "       一键 ensureDisplay + attach + migrate 到 display 工作区中心（窗口完整可见）",
    "  restore <app_id>",
    "       把窗口迁回主屏中央",
    "  live-view <app_id> [--port 7575] [--interval-ms 500]",
    "       在浏览器实时查看 capsule 画面（http://localhost:port）：含画面 + 接管按钮",
    "  install-helper [--force] [--prefix <path>]",
    "       检测并编译 native helper（macOS swiftc / Windows .ps1 自动 wrap）。安装后续运行的前置依赖",
    "  doctor [--watch <sec>]",
    "       一键自检：OS / Node / PowerShell / helper / DPI / elevation / displays；输出可贴 issue 报告",
    "       --watch <sec>：周期 health.snapshot 监控 helper（GDI / heap / handle leak 检测）",
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
  // 在 dispatch 前把 bundled helper 路径设进 env，让所有 createPlatformAdapter
  // 调用都能默认拿到。用户显式设的 VISION_MCP_NATIVE_HELPER 优先（resolveBundledHelper 会先读 env）。
  // install-helper 命令自己有特殊逻辑，跳过；其他命令受益。
  if (args.command !== "install-helper" && !process.env.VISION_MCP_NATIVE_HELPER) {
    const bundled = await resolveBundledHelper();
    if (bundled) process.env.VISION_MCP_NATIVE_HELPER = bundled;
  }
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
      case "patch":
        await cmdPatch(args);
        return;
      case "patches":
        await cmdPatches(args);
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
      case "scroll":
        await cmdRawScroll(args);
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
      case "install-helper":
        await cmdInstallHelper(args);
        return;
      case "doctor":
        await cmdDoctor(args);
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

/**
 * 解析 native helper 的默认路径。顺序：
 *   1) env VISION_MCP_NATIVE_HELPER（用户显式覆盖，优先级最高）
 *   2) cli 包自带的 native/<platform>/...（npm i -g 安装的情况）
 *   3) 仓库根 native/<platform>/...（源码 dev 的情况）
 * 返回 undefined 时由 core 走 native-bridge.resolveDefaultHelper 兜底。
 *
 * 为何不全靠 env：用户 npm i -g 后想直接 `vision-mcp serve` 跑 stdio
 * MCP server，不希望强迫设环境变量。CLI 比 core 更清楚自己的包位置，
 * 所以这层提前解析后显式传 helperPath。
 */
async function resolveBundledHelper(): Promise<string | undefined> {
  const envPath = process.env.VISION_MCP_NATIVE_HELPER;
  if (envPath) return envPath;
  const cliDir = path.dirname(fileURLToPath(import.meta.url));
  const plat = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : null;
  if (!plat) return undefined;
  const names = plat === "windows"
    ? ["vision-mcp-helper.exe", path.join("src", "vision-mcp-helper.ps1")]
    : ["vision-mcp-helper"];
  const roots = [
    path.resolve(cliDir, "..", "native", plat),                    // npm install: cli/native
    path.resolve(cliDir, "..", "..", "..", "native", plat),        // dev: repo/native
  ];
  for (const root of roots) {
    for (const name of names) {
      const c = path.join(root, name);
      try {
        await fs.access(c);
        return c;
      } catch { /* try next */ }
    }
  }
  return undefined;
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
  // 注入跨平台 accessibility provider（macOS osascript/helper / Windows UIA）
  const providers: import("@vision-mcp/core").LocatorProviders = {};
  const ax = makeAccessibilityProvider(adapter);
  if (ax) providers.accessibility = ax;
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
    autoMigrate: true,
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
    autoMigrate: true,
  });
  const result = await runtime.runWorkflow(wfId, inputs);
  console.log(JSON.stringify(result, null, 2));
  await capsule.adapter.dispose?.();
}

async function cmdPatch(args: ParsedArgs) {
  const [appId] = args.positional;
  if (!appId) throw new Error("patch 需要 <app_id>");
  const mapPath = path.join(appsRoot(args), appId, "vision-mcp.yaml");
  const loaded = await loadMap(mapPath);

  const stateId = args.flags.state ? String(args.flags.state) : undefined;
  const controlId = args.flags.control ? String(args.flags.control) : undefined;
  const bboxStr = args.flags["bbox-norm"] ? String(args.flags["bbox-norm"]) : undefined;
  const partialStr = args.flags.partial ? String(args.flags.partial) : undefined;
  const reason = args.flags.reason ? String(args.flags.reason) : "agent in-the-loop correction";
  const trust = (args.flags.trust ? String(args.flags.trust) : "session_only") as
    | "session_only" | "trusted" | "untrusted_proposal";
  const confidence = args.flags.confidence ? Number(args.flags.confidence) : 1;

  // 决定 patch 类型
  let patch: import("@vision-mcp/core").Patch;
  if (bboxStr) {
    if (!stateId || !controlId) throw new Error("--bbox-norm 需要同时给 --state 和 --control");
    const parts = bboxStr.split(",").map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
      throw new Error("--bbox-norm 形式：x,y,w,h（0-1）");
    }
    patch = {
      id: `bbox-${appId}-${stateId}-${controlId}-${Date.now().toString(36)}`,
      kind: "control_bbox",
      state_id: stateId,
      control_id: controlId,
      new_bbox_norm: parts as [number, number, number, number],
      method: reason,
      trust,
      confidence,
      reason,
      requires_review: trust === "untrusted_proposal",
      created_at: new Date().toISOString(),
      created_by: "vision-mcp-cli-patch",
    };
  } else if (partialStr) {
    if (!stateId || !controlId) throw new Error("--partial 需要同时给 --state 和 --control");
    const partial = JSON.parse(partialStr);
    patch = {
      id: `loc-${appId}-${stateId}-${controlId}-${Date.now().toString(36)}`,
      kind: "control_locator",
      state_id: stateId,
      control_id: controlId,
      partial,
      trust,
      confidence,
      reason,
      requires_review: trust === "untrusted_proposal",
      created_at: new Date().toISOString(),
      created_by: "vision-mcp-cli-patch",
    };
  } else {
    throw new Error("patch 需要 --bbox-norm 或 --partial 至少一个");
  }

  // 校验 patch 能 apply（防止 state/region/control 不存在）
  const Patch = (await import("@vision-mcp/core")).Patch;
  const validated = Patch.parse(patch);
  const state = loaded.effective.states.find((s) => s.id === stateId);
  const region = loaded.effective.regions.find((r) => r.id === stateId);
  if (!state && !region) {
    console.warn(`⚠️  "${stateId}" 在 states / regions 都不存在，patch 仍写入但 applyPatches 会跳过`);
  } else if (controlId) {
    const inState = state?.controls.find((c) => c.id === controlId);
    const inRegion = region?.controls.find((c) => c.id === controlId);
    const inInherited = state?.inherit_regions
      .map((rid) => loaded.effective.regions.find((r) => r.id === rid))
      .some((r) => r?.controls.find((c) => c.id === controlId));
    if (!inState && !inRegion && !inInherited) {
      console.warn(`⚠️  control "${controlId}" 在 "${stateId}" / inherited regions 不存在`);
    }
  }
  const filePath = await writePatch(loaded.baseDir, validated);
  console.log(`✅ wrote patch ${filePath}`);
  console.log(JSON.stringify(validated, null, 2));
}

async function cmdPatches(args: ParsedArgs) {
  const [appId] = args.positional;
  if (!appId) throw new Error("patches 需要 <app_id>");
  const mapPath = path.join(appsRoot(args), appId, "vision-mcp.yaml");
  const loaded = await loadMap(mapPath);
  if (loaded.patches.length === 0) {
    console.log(`(${appId}) 0 patches`);
    return;
  }
  console.log(`${appId} 已应用 ${loaded.patches.length} patch:`);
  for (const p of loaded.patches) {
    const target = p.kind === "geometry_profile"
      ? p.visual_box_id
      : p.kind === "state"
      ? p.state.id
      : `${p.state_id}.${p.control_id}`;
    console.log(`  - ${p.id} [${p.kind}] target=${target} trust=${p.trust} confidence=${p.confidence}`);
    if (p.reason) console.log(`    reason: ${p.reason}`);
  }
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
  // attach + ensureDisplay（轻量：Windows / macOS 都只是挑稳定 display，不创建虚拟器）。
  // ensureDisplay 是 validateGeometry 的前置条件，click/hover/scroll 等都会用到。
  // 默认不 migrate（不重排窗口位置），避免反复把屏外 workspace 拉回主屏；--migrate 显式触发。
  if (loaded.effective.visual_box.target_window) {
    await capsule.attach({ target: loaded.effective.visual_box.target_window });
    await capsule.ensureDisplay({
      geometry: loaded.effective.visual_box.display,
      mode: loaded.effective.visual_box.mode,
      fallbacks: loaded.effective.visual_box.fallbacks,
    });
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
  const provider = makeAccessibilityProvider(adapter);
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

async function cmdAxPress(args: ParsedArgs) {
  const { adapter, capsule } = await openCapsuleForRaw(args);
  const normStr = String(args.flags.norm ?? "");
  const [nxs, nys] = normStr.split(",");
  const nx = Number(nxs), ny = Number(nys);
  if (!Number.isFinite(nx) || !Number.isFinite(ny)) throw new Error("--norm 形式：x,y（归一化 0-1）");
  const status = await capsule.status();
  const handle = status.attached_window?.native_handle;
  if (!handle) throw new Error("ax-press 需要 attach 窗口");
  // macOS（swift helper）和 Windows（UIA InvokePattern）都实现了 axPressInWindow。
  // osascript adapter 没有；mock 也没有。
  const a = adapter as unknown as { axPressInWindow?: (h: string, n: [number, number]) => Promise<unknown> };
  if (!a.axPressInWindow) {
    throw new Error(
      `当前 adapter (${adapter.platform}) 不支持 ax-press。` +
      `macOS 需 swift helper（不是 osascript）；Windows 需 helper.ps1 (helperRequest input.ax_press)。`,
    );
  }
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

/**
 * scroll: 在 norm 坐标位置发滚轮。
 * dy 正值 = 向下滚（屏幕内容上移），与 macOS 一致；一格 = 120（Windows WHEEL_DELTA）。
 */
async function cmdRawScroll(args: ParsedArgs) {
  const { adapter, capsule } = await openCapsuleForRaw(args);
  const [nxs, nys] = String(args.flags.norm ?? "0.5,0.5").split(",");
  const nx = Number(nxs), ny = Number(nys);
  if (!Number.isFinite(nx) || !Number.isFinite(ny)) throw new Error("--norm 形式：x,y（归一化 0-1）");
  const dy = Number(args.flags.dy ?? 120);
  const dx = Number(args.flags.dx ?? 0);
  await capsule.raise().catch(() => {});
  const cr = (await capsule.validateGeometry()).client_rect_px;
  const pt = { x: Math.round(cr.x + nx * cr.width), y: Math.round(cr.y + ny * cr.height) };
  await adapter.scroll(pt, { dy_px: dy, dx_px: dx });
  console.log(JSON.stringify({ ok: true, point: pt, dy, dx }));
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
  const ocr = await makeOcrProvider(adapter);
  if (!ocr) {
    throw new Error(
      `click-text 需要 OCR provider。当前 adapter (${adapter.platform}) 不支持：` +
      `macOS 需 swift helper（不是 osascript），Windows 需 helper.ps1`,
    );
  }
  // OCR 走 GDI 屏幕抓取（不是 PrintWindow），目标窗口必须可见且在前台
  // 否则 OCR 会读到上层其它窗口（比如我们自己的终端）。先 raise 再 OCR。
  await capsule.raise().catch(() => {});
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
  const ocr = await makeOcrProvider(adapter);
  if (!ocr) {
    throw new Error(
      `scroll-until-text 需要 OCR provider。当前 adapter (${adapter.platform}) 不支持。`,
    );
  }
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
/** 跨平台默认临时目录（不能再 hardcode /tmp）。 */
function defaultTempPath(name: string): string {
  return path.join(process.env.TEMP ?? process.env.TMP ?? (process.platform === "win32" ? "C:\\Windows\\Temp" : "/tmp"), name);
}

/** 在 RGBA frame 上裁剪指定像素 rect（frame 坐标系），返回 RGBA pixels + 尺寸。 */
function cropRgba(
  frame: { width_px: number; height_px: number; pixels: Uint8Array },
  rect: { x: number; y: number; width: number; height: number },
): { width: number; height: number; pixels: Uint8Array } {
  const W = frame.width_px;
  const H = frame.height_px;
  const x0 = Math.max(0, Math.min(W, rect.x));
  const y0 = Math.max(0, Math.min(H, rect.y));
  const x1 = Math.max(0, Math.min(W, rect.x + rect.width));
  const y1 = Math.max(0, Math.min(H, rect.y + rect.height));
  const w = Math.max(0, x1 - x0);
  const h = Math.max(0, y1 - y0);
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const srcOff = ((y0 + y) * W + x0) * 4;
    const dstOff = y * w * 4;
    out.set(frame.pixels.subarray(srcOff, srcOff + w * 4), dstOff);
  }
  return { width: w, height: h, pixels: out };
}

async function cmdSnapshotCrop(args: ParsedArgs) {
  const { adapter, capsule } = await openCapsuleForRaw(args);
  const outPath = String(args.flags.out ?? defaultTempPath("vm-crop.png"));
  if (!args.flags.region) throw new Error("snapshot-crop 需要 --region x,y,w,h（归一化）");
  const [nx, ny, nw, nh] = String(args.flags.region).split(",").map(Number);
  const cr = (await capsule.validateGeometry()).client_rect_px;
  const { encodeRgbaToPng } = await import("@vision-mcp/core");
  // 走 capsule.capture()（window/Print Window 路径），跨平台。
  // frame 是 client_rect 的内容，所以 region 直接用 frame 像素坐标（client_rect 内偏移）。
  const frame = await capsule.capture();
  const frameRect = {
    x: Math.round(nx * frame.width_px),
    y: Math.round(ny * frame.height_px),
    width: Math.round(nw * frame.width_px),
    height: Math.round(nh * frame.height_px),
  };
  const { width, height, pixels } = cropRgba(frame, frameRect);
  await fs.writeFile(outPath, encodeRgbaToPng(width, height, pixels));
  const screenRect = {
    x: Math.round(cr.x + nx * cr.width),
    y: Math.round(cr.y + ny * cr.height),
    width: Math.round(nw * cr.width),
    height: Math.round(nh * cr.height),
  };
  console.log(JSON.stringify({ ok: true, out: outPath, region_screen: screenRect, region_frame: frameRect, size: { width, height } }));
  await adapter.dispose?.();
}

/** snapshot-tile: 把当前帧切成 N×M thumb 网格，输出多张小图。 */
async function cmdSnapshotTile(args: ParsedArgs) {
  const { adapter, capsule } = await openCapsuleForRaw(args);
  const cols = Number(args.flags.cols ?? 3);
  const rows = Number(args.flags.rows ?? 3);
  const outDir = String(args.flags["out-dir"] ?? defaultTempPath("vm-tiles"));
  await fs.mkdir(outDir, { recursive: true });
  const { encodeRgbaToPng } = await import("@vision-mcp/core");
  const frame = await capsule.capture();
  const tileW = Math.floor(frame.width_px / cols);
  const tileH = Math.floor(frame.height_px / rows);
  const tiles: Array<{ row: number; col: number; out: string; region_norm: [number, number, number, number] }> = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cropped = cropRgba(frame, { x: c * tileW, y: r * tileH, width: tileW, height: tileH });
      const filename = `tile_r${r}_c${c}.png`;
      const fullPath = path.join(outDir, filename);
      await fs.writeFile(fullPath, encodeRgbaToPng(cropped.width, cropped.height, cropped.pixels));
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
  const { describeDisplay } = await import("@vision-mcp/core");
  const displays = await adapter.listDisplays();
  if (args.flags.json) {
    console.log(JSON.stringify({ displays }, null, 2));
  } else {
    console.log("Displays:");
    for (const d of displays) {
      console.log("  " + describeDisplay(d));
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
      mode: loaded.effective.visual_box.mode,
      fallbacks: loaded.effective.visual_box.fallbacks,
    });
  }
  console.log(`[capsule] display: ${display.id} (${display.kind ?? "?"}) bounds=${JSON.stringify(display.bounds)}`);

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
    note: "窗口已迁到 display 工作区中心，完整可见。",
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

/**
 * `vision-mcp doctor`：一键自检 + 写报告。
 *
 * 输出一份纯文本（便于 `vision-mcp doctor > report.txt` 贴到 issue），
 * 覆盖：OS / Node / PowerShell 版本、helper 路径、helper ping (version RPC)、
 * 当前 displays 数、是否管理员、DPI awareness 状态。
 *
 * 退出码：所有关键项 OK → 0；任意 fail → 1。
 */
async function cmdDoctor(args: ParsedArgs) {
  // --watch <seconds>：周期性轮询 helper health.snapshot，看 GDI/heap/handle 趋势。
  // 用于 P4-23 长 session 内存监控（24h 跑下来看是否 leak）。
  if (args.flags.watch) {
    const intervalMs = Number(args.flags.watch === true ? 60 : args.flags.watch) * 1000;
    await cmdDoctorWatch(intervalMs);
    return;
  }
  const os = await import("node:os");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execP = promisify(execFile);
  const lines: string[] = [];
  let allOk = true;
  const ok = (label: string, value: string) => lines.push(`  ✅ ${label}: ${value}`);
  const warn = (label: string, value: string) => { lines.push(`  ⚠️  ${label}: ${value}`); };
  const fail = (label: string, value: string) => { allOk = false; lines.push(`  ❌ ${label}: ${value}`); };

  lines.push(`vision-mcp doctor — ${new Date().toISOString()}`);
  lines.push("");
  lines.push(`[system]`);
  ok("os", `${os.type()} ${os.release()} (${process.platform}/${process.arch})`);
  ok("node", process.version);
  ok("cwd", process.cwd());

  lines.push("");
  lines.push(`[helper]`);
  const bundledHelper = await resolveBundledHelper();
  if (bundledHelper) {
    ok("path", bundledHelper);
  } else {
    fail("path", "未找到 vision-mcp-helper（既无 env，又无 cli/native 也无 repo/native）");
  }

  if (process.platform === "win32") {
    lines.push("");
    lines.push(`[windows]`);
    const psExe = process.env.SystemRoot
      ? path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
      : "powershell.exe";
    try {
      const r = await execP(psExe, [
        "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command",
        `$PSVersionTable.PSVersion.ToString() + '|' + $PSVersionTable.PSEdition`,
      ], { timeout: 10_000 });
      const ver = (r.stdout || "").trim();
      if (ver.endsWith("|Core")) {
        fail("powershell", `${ver} — 必须用 Windows PowerShell 5.1，不能用 pwsh 7+`);
      } else {
        ok("powershell", ver);
      }
    } catch (err) {
      fail("powershell", `${psExe} 调用失败：${(err as Error).message.split("\n")[0]}`);
    }
    // 管理员？
    try {
      const r = await execP(psExe, [
        "-NoProfile", "-NonInteractive", "-Command",
        "([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)",
      ], { timeout: 5_000 });
      const elevated = (r.stdout || "").trim() === "True";
      if (elevated) ok("elevation", "已以管理员身份运行（可注入 elevated app）");
      else warn("elevation", "未以管理员身份运行——任务管理器 / 反作弊 app 的输入会被拒");
    } catch { warn("elevation", "无法检测"); }
    // ps2exe 不是关键依赖了，列下信息
    try {
      const r = await execP(psExe, [
        "-NoProfile", "-NonInteractive", "-Command",
        "if (Get-Module -ListAvailable -Name ps2exe,PS2EXE) { 'yes' } else { 'no' }",
      ], { timeout: 8_000 });
      const has = (r.stdout || "").trim() === "yes";
      if (has) ok("ps2exe", "已装（v0.1 暂不用，留作 prebuilt 编译）");
      else warn("ps2exe", "未装（v0.1 不需要；helper 走 .ps1 + powershell.exe -File）");
    } catch { /* skip */ }
    // OCR 语言包检测（Windows.Media.Ocr 需要装语言包才能识别该语言）
    try {
      const r = await execP(psExe, [
        "-NoProfile", "-NonInteractive", "-Command",
        "[Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime] | Out-Null; " +
        "([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | ForEach-Object { $_.LanguageTag }) -join ','",
      ], { timeout: 10_000 });
      const langs = (r.stdout || "").trim();
      if (langs) ok("ocr.languages", langs);
      else warn("ocr.languages", "无—设置 → 时间和语言 → 添加语言（中文 / 英文）");
    } catch { warn("ocr.languages", "Windows.Media.Ocr 不可用"); }
  }

  lines.push("");
  lines.push(`[capabilities]`);
  // ping helper：跑 version RPC
  if (bundledHelper) {
    try {
      const adapter = await createPlatformAdapter({
        platform: "auto",
        helperPath: bundledHelper,
      });
      const displays = await adapter.listDisplays();
      ok("helper.ping", `OK (${displays.length} displays)`);
      for (const d of displays) {
        ok(`display ${d.id}`,
          `${d.bounds.width}x${d.bounds.height} @ scale=${d.scale} (dpi=${d.dpi_x}, ${d.is_primary ? "primary" : d.kind})`,
        );
      }
      await adapter.dispose?.();
    } catch (err) {
      fail("helper.ping", `${(err as Error).message.split("\n")[0]}`);
    }
  }

  lines.push("");
  lines.push(allOk ? "✅ 所有关键项 OK" : "❌ 部分检查失败，见上");
  lines.push("");
  console.log(lines.join("\n"));
  if (!allOk) process.exit(1);
}

/**
 * doctor --watch：周期 health.snapshot 看趋势。
 * 检测 GDI handle / .NET heap / working set 累积；suspicious 时高亮。
 *
 * 一行一个 sample（jsonl），方便 grep / 喂给 vega-lite 画图。
 * Ctrl+C 退出。
 *
 * 用法：vision-mcp doctor --watch 30   # 每 30s 一次
 *      vision-mcp doctor --watch        # 默认 60s
 */
async function cmdDoctorWatch(intervalMs: number) {
  const bundled = await resolveBundledHelper();
  if (!bundled) {
    console.error("doctor --watch 需要 helper 可用；先跑 vision-mcp install-helper");
    process.exit(1);
  }
  const adapter = await createPlatformAdapter({ platform: "auto", helperPath: bundled });
  // 只有 Windows helper 实现了 health.snapshot（macOS swift helper 没这条；roadmap）
  const isWindows = adapter.platform === "windows";
  if (!isWindows) {
    console.error(`doctor --watch 目前仅支持 Windows helper（当前 ${adapter.platform}）`);
    await adapter.dispose?.();
    process.exit(1);
  }
  const helperRequest = (adapter as unknown as {
    helperRequest: <T>(method: string, params?: unknown, timeoutMs?: number) => Promise<T>;
  }).helperRequest.bind(adapter);

  console.error(`[doctor watch] helper=${bundled}  interval=${intervalMs}ms  Ctrl+C 退出`);
  console.error(`[doctor watch] 输出 JSONL 到 stdout；用 jq 处理：vision-mcp doctor --watch 30 | jq -c '{t:.iso,gdi:.gdi_handle_count,heap:.gc_heap_bytes}'`);

  let firstSample: Record<string, number> | null = null;
  const tick = async () => {
    try {
      const h = await helperRequest<Record<string, number>>("health.snapshot", {}, 10_000);
      const sample = {
        iso: new Date().toISOString(),
        ...h,
      };
      // 简单趋势：与 first sample 比较，发现增长就在 stderr 高亮
      if (!firstSample) {
        firstSample = h;
      } else {
        const deltas: string[] = [];
        for (const k of ["gdi_handle_count", "user_handle_count", "handle_count", "gc_heap_bytes", "working_set_bytes"]) {
          const cur = Number(h[k] ?? 0);
          const orig = Number(firstSample[k] ?? 0);
          if (orig > 0 && cur > orig * 1.5) {
            deltas.push(`${k}: ${orig} → ${cur} (+${Math.round(((cur - orig) / orig) * 100)}%)`);
          }
        }
        if (deltas.length) {
          console.error(`[doctor watch] ⚠️  potential leak: ${deltas.join("; ")}`);
        }
      }
      console.log(JSON.stringify(sample));
    } catch (err) {
      console.error(`[doctor watch] sample failed: ${(err as Error).message}`);
    }
  };
  // 立即一次 + 周期
  await tick();
  const timer = setInterval(tick, intervalMs);
  // Ctrl+C cleanup
  process.on("SIGINT", async () => {
    clearInterval(timer);
    await adapter.dispose?.();
    process.exit(0);
  });
  // 持续运行
  await new Promise(() => {});
}

async function cmdInstallHelper(args: ParsedArgs) {
  const force = Boolean(args.flags.force);
  const silent = Boolean(args.flags.silent);   // 静默模式：失败不抛错，给 postinstall 用
  const platform = process.platform;
  const { fileURLToPath } = await import("node:url");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execP = promisify(execFile);

  // 跨平台路径解析（避免 Windows 上 new URL().pathname 带前导斜杠）
  const cliDir = path.dirname(fileURLToPath(import.meta.url));

  // 检测命令是否在 PATH（跨平台：用 spawn 试一下，比 which/where 更可靠）
  async function commandExists(cmd: string, probeArgs: string[] = ["--version"]): Promise<boolean> {
    try {
      await execP(cmd, probeArgs, { timeout: 5000 });
      return true;
    } catch (err: unknown) {
      const e = err as { code?: string; status?: number };
      // 命令存在但 --version 失败时 status !== 0 但不是 ENOENT
      if (e?.code === "ENOENT") return false;
      // 其他错（包括 --version 异常退出）仍认为命令存在
      return true;
    }
  }

  // 跨平台文件存在/可执行检测：Windows 上 X_OK 不可靠（用 ACL 而非 mode bits），只查 F_OK
  async function isExecutable(p: string): Promise<boolean> {
    try {
      const mode = platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK;
      await fs.access(p, mode);
      return true;
    } catch {
      return false;
    }
  }

  // prefix 解析：
  //   1) --prefix 显式
  //   2) cli 包内 native/（npm 安装：node_modules/@vision-mcp/cli/native）
  //   3) 仓库根 native/（源码 dev：repo/packages/cli/dist + ../../../native）
  // 注意 cliDir = packages/cli/dist；不能用 ../../native（那是 packages/native，不存在）
  const candidates = args.flags.prefix
    ? [String(args.flags.prefix)]
    : [
        path.resolve(cliDir, "..", "native"),
        path.resolve(cliDir, "..", "..", "..", "native"),
      ];
  let prefix = candidates[0];
  for (const c of candidates) {
    try {
      await fs.access(c);
      prefix = c;
      break;
    } catch { /* try next */ }
  }

  const log = silent ? () => {} : console.log.bind(console);
  const fail = (msg: string) => {
    if (silent) {
      console.warn(`[vision-mcp install-helper] ${msg.split("\n")[0]}`);
      console.warn(`[vision-mcp install-helper] 详细指引：vision-mcp install-helper`);
      return; // silent 模式不抛
    }
    throw new Error(msg);
  };

  if (platform === "darwin") {
    const helperPath = path.join(prefix, "macos", "vision-mcp-helper");
    const srcPath = path.join(prefix, "macos", "src", "main.swift");
    if (await isExecutable(helperPath) && !force) {
      log(`✅ macOS helper 已就绪：${helperPath}`);
      if (!silent) {
        log(`   重新编译请加 --force`);
        log(`📋 host 配置环境变量（Plugin / npm 路径会自动）：`);
        log(`   export VISION_MCP_NATIVE_HELPER="${helperPath}"`);
      }
      return;
    }
    try {
      await fs.access(srcPath);
    } catch {
      return fail(`找不到 swift 源码 ${srcPath}。请确保完整安装（npm tarball / git clone）。`);
    }
    if (!(await commandExists("swiftc", ["--version"]))) {
      return fail(
        `未找到 swiftc。请先安装 Xcode Command Line Tools：\n` +
          `   xcode-select --install\n` +
          `完成后重新运行：vision-mcp install-helper`,
      );
    }
    log(`🔨 编译 macOS helper（首次约 5–10 秒）...`);
    try {
      await execP(
        "swiftc",
        [
          "-O",
          "-o", helperPath,
          srcPath,
          "-framework", "AppKit",
          "-framework", "ApplicationServices",
          "-framework", "CoreGraphics",
          "-framework", "IOKit",
          "-framework", "Vision",
          "-framework", "CoreImage",
          "-framework", "ScreenCaptureKit",
        ],
        { maxBuffer: 10 * 1024 * 1024, timeout: 120_000 },
      );
    } catch (err) {
      return fail(
        `swiftc 编译失败：${(err as Error).message}\n` +
          `请确认已安装 Xcode Command Line Tools：xcode-select --install`,
      );
    }
    log(`✅ 编译完成：${helperPath}`);
    if (!silent) {
      log(`📋 host 配置：export VISION_MCP_NATIVE_HELPER="${helperPath}"`);
      log(`\n⚠️  第一次操作真窗口时，macOS 会弹两个授权对话框：`);
      log(`   1. 屏幕录制（Screen Recording）`);
      log(`   2. 辅助功能（Accessibility）`);
      log(`   都授权后重启 MCP host 让权限生效。`);
    }
    return;
  }

  if (platform === "win32") {
    const ps1Path = path.join(prefix, "windows", "src", "vision-mcp-helper.ps1");
    try {
      await fs.access(ps1Path);
    } catch {
      return fail(`找不到 PowerShell 脚本 ${ps1Path}。请确保完整安装。`);
    }
    // 一定要用 Windows PowerShell 5.1（powershell.exe）：
    //   - UIAutomationClient Add-Type 在 pwsh.exe (PowerShell 7) 必失败
    // 显式 SystemRoot 路径，避免用户 PATH 把 powershell 解析到 pwsh.exe alias。
    const powershellExe = process.env.SystemRoot
      ? path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
      : "powershell.exe";
    const psWrap = (script: string) =>
      `$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new(); ${script}`;
    async function powershell(script: string, timeoutMs = 30_000) {
      return execP(powershellExe, [
        "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", psWrap(script),
      ], { maxBuffer: 10 * 1024 * 1024, timeout: timeoutMs });
    }

    // 检测 PowerShell 5.1 是不是可用
    let psVer = "";
    try {
      const ver = await powershell(`$PSVersionTable.PSVersion.Major.ToString() + '.' + $PSVersionTable.PSVersion.Minor.ToString() + '|' + $PSVersionTable.PSEdition`);
      psVer = (ver.stdout || "").trim();
      if (psVer.endsWith("|Core")) {
        return fail(
          `检测到 PowerShell 是 Core (pwsh.exe)：${psVer}。\n` +
          `vision-mcp helper 必须用 Windows PowerShell 5.1。请确认 ${powershellExe} 存在。`,
        );
      }
    } catch (err) {
      if (!silent) log(`⚠️ powershell.exe 调用失败：${(err as Error).message}`);
    }

    // 既然 .ps1 + 自动 wrap 已能用，install-helper 主要变成"自检 + 写说明"。
    // ps2exe 编译路径已验证 stdio 不可用（默认 host 拦了 [Console]::In，noConsole 又关
    // console），不再自动尝试。需要 .exe 提速的用户走 prebuilt（CI 产物）或自研 C# launcher。
    log(`✅ Windows helper 就绪（PowerShell ${psVer || "5.x"}）`);
    log(`   helper: ${ps1Path}`);
    log(`   CLI 会自动用 powershell.exe -File 包一层；首次 RPC ~400ms 冷启动后稳定 ~50ms`);
    if (!silent) {
      log(`\n📋 host 配置（可选；不设也行，CLI 会自动找到此 .ps1）：`);
      log(`   $env:VISION_MCP_NATIVE_HELPER = "${ps1Path}"`);
      log(`\n⚠️  权限提示：`);
      log(`   - 高完整度 app（任务管理器 / 反作弊）：vision-mcp 进程需以管理员身份运行才能注入输入`);
      log(`   - 中文 / 中文窗口标题：helper 已强制 UTF-8 输出`);
      log(`\n⚙️  想要 .exe 提速（启动 ~10ms vs ~400ms）：`);
      log(`   PS2EXE 的默认 PowerShell host 拦截 [Console]::In，不能做 JSON-RPC sidecar。`);
      log(`   推荐方案：用 dotnet AOT / C# 写个 5-行 launcher 包 powershell.exe，或等官方 prebuilt 发布。`);
      log(`\n📖 详细协议 + 故障排查见 native/windows/README.md`);
    }
    return;
  }

  // Linux / 其他平台：mock-only
  if (silent) {
    console.warn(`[vision-mcp install-helper] 当前 platform=${platform} 不支持 native helper；仅 mock 可用`);
    return;
  }
  fail(`install-helper 只支持 macOS / Windows，当前 platform=${platform}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
