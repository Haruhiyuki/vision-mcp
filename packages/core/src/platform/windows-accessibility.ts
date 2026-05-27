import type {
  AccessibilityNode,
  AccessibilityProvider,
} from "../locator/types.js";
import type { RectPx } from "../capsule/types.js";
import type { WindowsPlatformAdapter } from "./windows.js";

/**
 * UIAutomation 节点的原始 PowerShell 形式（vision-mcp-helper.ps1 Dump-UIA-Tree）。
 */
interface RawUiaNode {
  /** ControlType.ProgrammaticName，如 "ControlType.Button"。 */
  role?: string;
  name?: string;
  /** PowerShell 端的 AutomationId（macOS 用 description 字段，统一名字）。 */
  desc?: string;
  /** Win32 ClassName，如 "Button" / "Edit" / "Chrome_WidgetWin_1"。 */
  class?: string;
  /** 屏幕坐标 [x, y]。 */
  pos?: [number, number];
  size?: [number, number];
  depth: number;
  path: string;
}

export interface WindowsAccessibilityOptions {
  /** Snapshot 缓存 TTL（毫秒）。 */
  cache_ttl_ms?: number;
  disable_cache?: boolean;
  /** ax.dump 限制。Win UIA 在 Chrome / Electron 树很深；默认 500/6 与 helper 一致。 */
  max_nodes?: number;
  max_depth?: number;
  /** 只返回可交互节点（Button/Edit/Link/CheckBox/MenuItem/Tab/...）+ 有 Name 的 Text。 */
  interactive_only?: boolean;
  /** 跳过没有 Name/AutomationId/ClassName 的 Pane/Group（CEF 中 90% 是这种）。 */
  skip_empty?: boolean;
  /** 视口裁剪 [nx,ny,nw,nh]：bbox 与视口不相交的子树整个跳过。 */
  viewport_norm?: [number, number, number, number];
}

/**
 * Windows accessibility provider。
 *
 * 等价 DarwinAccessibilityProvider，但走 helper.helperRequest('ax.dump') 而非 osascript。
 * helper 返回的是屏幕坐标 + size；这里转成相对 client_rect 的 bbox_norm，让
 * LocatorResolver 与 macOS 路径完全同接口。
 */
export class WindowsAccessibilityProvider implements AccessibilityProvider {
  private cache = new Map<string, { ts: number; nodes: AccessibilityNode[] }>();
  private pending = new Map<string, Promise<AccessibilityNode[]>>();
  private readonly ttl: number;

  constructor(
    private readonly adapter: WindowsPlatformAdapter,
    private readonly options: WindowsAccessibilityOptions = {},
  ) {
    this.ttl = options.disable_cache ? 0 : options.cache_ttl_ms ?? 1500;
  }

  invalidate(windowHandle?: string): void {
    if (windowHandle) this.cache.delete(windowHandle);
    else this.cache.clear();
  }

  async snapshot(windowHandle: string): Promise<AccessibilityNode[]> {
    if (this.ttl > 0) {
      const hit = this.cache.get(windowHandle);
      if (hit && Date.now() - hit.ts < this.ttl) return hit.nodes;
      const inflight = this.pending.get(windowHandle);
      if (inflight) return inflight;
    }
    const work = this._doSnapshot(windowHandle).finally(() => {
      this.pending.delete(windowHandle);
    });
    if (this.ttl > 0) this.pending.set(windowHandle, work);
    const nodes = await work;
    if (this.ttl > 0) this.cache.set(windowHandle, { ts: Date.now(), nodes });
    return nodes;
  }

  private async _doSnapshot(windowHandle: string): Promise<AccessibilityNode[]> {
    // 拿 client_rect 用于坐标归一化
    let clientRect: RectPx | undefined;
    try {
      const w = await this.adapter.getWindow(windowHandle);
      clientRect = w.client_bounds;
    } catch {
      return [];
    }
    if (!clientRect || clientRect.width <= 0 || clientRect.height <= 0) return [];

    // Win UIAutomationClient 首次调用要加载几个 .NET assembly，冷启动观测到
    // 单次 ax.dump 偶尔 > 20s（即使节点数很少）。给 60s buffer；后续调用走 cache。
    // max_nodes 默认 300（比 macOS 的 500 保守）：Chrome / Electron 子树极深，
    // 让 UIA Walker 跑完整棵树会卡 GUI 线程；agent 实战靠 100~200 个节点足够。
    const maxNodes = this.options.max_nodes ?? 300;
    const maxDepth = this.options.max_depth ?? 5;
    let raw: RawUiaNode[] | RawUiaNode = [];
    try {
      raw = await this.adapter.helperRequest<RawUiaNode[] | RawUiaNode>(
        "ax.dump",
        {
          handle: windowHandle,
          max_nodes: maxNodes,
          max_depth: maxDepth,
          interactive_only: this.options.interactive_only,
          skip_empty: this.options.skip_empty,
          viewport_norm: this.options.viewport_norm,
        },
        60_000,
      );
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[vision-mcp] ax.dump 失败 (handle=${windowHandle}):`, (err as Error).message);
      return [];
    }
    const arr = Array.isArray(raw) ? raw : raw ? [raw] : [];
    return arr
      .map((n) => normalize(n, clientRect!))
      .filter((n): n is AccessibilityNode => n !== null);
  }
}

function normalize(raw: RawUiaNode, clientRect: RectPx): AccessibilityNode | null {
  if (!raw.pos || !raw.size) return null;
  const [x, y] = raw.pos;
  const [w, h] = raw.size;
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  const nx = (x - clientRect.x) / clientRect.width;
  const ny = (y - clientRect.y) / clientRect.height;
  const nw = w / clientRect.width;
  const nh = h / clientRect.height;
  // 完全 off-client 的节点丢弃（窗口阴影 / 系统菜单 / 悬浮 tooltip 等）
  if (nx + nw < 0 || ny + nh < 0 || nx > 1.5 || ny > 1.5) return null;
  // 把 "ControlType.Button" 简化为 "AXButton"，与 macOS 命名对齐让上游
  // 模式匹配（snapshot 的 candidates filter regex）能复用同一组正则。
  const role = mapRole(raw.role);
  return {
    id: raw.path,
    role,
    name: raw.name || undefined,
    description: raw.desc || undefined,
    automation_id: raw.desc || undefined,
    class_name: raw.class || undefined,
    bbox_norm: [clamp(nx), clamp(ny), clamp(nw), clamp(nh)],
    enabled: true,
    visible: true,
  };
}

/**
 * UIA ControlType → macOS AX role 命名（让 snapshot 的 candidates 正则复用）。
 * 仅常用控件做映射；其他保留原始 ControlType.* 字符串。
 */
function mapRole(raw?: string): string | undefined {
  if (!raw) return undefined;
  const m = raw.replace(/^ControlType\./, "");
  const table: Record<string, string> = {
    Button: "AXButton",
    Edit: "AXTextField",
    Document: "AXTextArea",
    Hyperlink: "AXLink",
    CheckBox: "AXCheckBox",
    RadioButton: "AXRadioButton",
    ComboBox: "AXPopUpButton",
    MenuItem: "AXMenuItem",
    Tab: "AXTab",
    TabItem: "AXTab",
    List: "AXList",
    ListItem: "AXCell",
    DataItem: "AXCell",
    TreeItem: "AXCell",
    Text: "AXStaticText",
    Image: "AXImage",
    Slider: "AXSlider",
    SplitButton: "AXButton",
    Group: "AXGroup",
    Pane: "AXGroup",
    Window: "AXWindow",
  };
  return table[m] ?? raw;
}

function clamp(v: number): number {
  if (v < 0) return 0;
  if (v > 1.5) return 1.5;
  return v;
}
