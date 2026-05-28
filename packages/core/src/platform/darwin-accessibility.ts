// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Vision-MCP Authors
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  AccessibilityNode,
  AccessibilityProvider,
} from "../locator/types.js";
import type { RectPx } from "../capsule/types.js";
import type { DarwinOsascriptAdapter } from "./darwin-osascript.js";
import type { DarwinHelperAdapter, RawAxNode } from "./darwin-helper.js";

const execFileP = promisify(execFile);

/**
 * 通过 System Events 抽取目标 app 的 accessibility 树。按 native_handle (pid:index)
 * 解析根窗口，再用 capsule 当前 client_rect 把屏幕坐标归一化。
 *
 * 与 OcrProvider 配合，给 LocatorResolver / detectState / control 提供结构化定位。
 */
export interface DarwinAccessibilityOptions {
  /** Snapshot 缓存 TTL（毫秒）。waitForCondition 多次 polling 时避免重复 dump。 */
  cache_ttl_ms?: number;
  /** 强制无缓存。 */
  disable_cache?: boolean;
}

export class DarwinAccessibilityProvider implements AccessibilityProvider {
  private cache = new Map<string, { ts: number; nodes: AccessibilityNode[] }>();
  private pending = new Map<string, Promise<AccessibilityNode[]>>();
  private readonly ttl: number;

  /**
   * adapter：可为 osascript 或 swift helper adapter。
   * - helper 路径：使用 adapter.dumpAxTree（毫秒级）
   * - osascript 路径：每次 spawn JXA（~10s）
   */
  constructor(
    private readonly adapter: DarwinOsascriptAdapter | DarwinHelperAdapter,
    options: DarwinAccessibilityOptions = {},
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
      // 同时发起的多次请求合并为一次实际 dump
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
    const [pidStr] = windowHandle.split(":");
    const pid = Number(pidStr);
    if (!Number.isFinite(pid)) return [];
    let clientRect: RectPx | undefined;
    try {
      const win = await this.adapter.getWindow(windowHandle);
      clientRect = win.client_bounds;
    } catch {
      return [];
    }
    if (!clientRect || clientRect.width <= 0 || clientRect.height <= 0) return [];

    // 优先用 helper.dumpAxTree（毫秒级），否则 osascript 兜底
    const dumpAxTree = (this.adapter as DarwinHelperAdapter).dumpAxTree;
    if (typeof dumpAxTree === "function") {
      try {
        const raw = await (this.adapter as DarwinHelperAdapter).dumpAxTree(
          windowHandle,
          500,
          6,
        );
        return raw
          .map((n) => normalizeHelper(n, clientRect!))
          .filter((n): n is AccessibilityNode => n !== null);
      } catch {
        // fall through
      }
    }

    const script = AX_DUMP_SCRIPT.replace("__PID__", String(pid));
    const { stdout } = await execFileP(
      "/usr/bin/osascript",
      ["-l", "JavaScript", "-e", script],
      { timeout: 60_000, maxBuffer: 64 * 1024 * 1024 },
    );
    let raw: RawNode[] = [];
    try {
      raw = JSON.parse(stdout.trim());
    } catch {
      return [];
    }
    return raw
      .map((n) => normalize(n, clientRect))
      .filter((n): n is AccessibilityNode => n !== null);
  }
}

function normalizeHelper(raw: RawAxNode, clientRect: RectPx): AccessibilityNode | null {
  if (!raw.pos || !raw.size) return null;
  const [x, y] = raw.pos;
  const [w, h] = raw.size;
  if (w <= 0 || h <= 0) return null;
  const nx = (x - clientRect.x) / clientRect.width;
  const ny = (y - clientRect.y) / clientRect.height;
  const nw = w / clientRect.width;
  const nh = h / clientRect.height;
  if (nx + nw < 0 || ny + nh < 0 || nx > 1.2 || ny > 1.2) return null;
  return {
    id: raw.path,
    role: raw.role,
    name: raw.name ?? undefined,
    description: raw.desc ?? undefined,
    automation_id: undefined,
    class_name: undefined,
    bbox_norm: [clamp(nx), clamp(ny), clamp(nw), clamp(nh)],
    enabled: true,
    visible: true,
    children: undefined,
  };
}

interface RawNode {
  role: string;
  name: string | null;
  desc: string | null;
  pos: [number, number] | null;
  size: [number, number] | null;
  enabled?: boolean;
  /** 平铺：原本子节点用 depth 字段表示层级，便于在 JXA 端避免递归 stringify。 */
  depth: number;
  /** 路径，例如 "win[0].splitGroup[0].toolbar[0].button[2]"。 */
  path: string;
}

function normalize(raw: RawNode, clientRect: RectPx): AccessibilityNode | null {
  if (!raw.pos || !raw.size) return null;
  const [x, y] = raw.pos;
  const [w, h] = raw.size;
  if (w <= 0 || h <= 0) return null;
  const nx = (x - clientRect.x) / clientRect.width;
  const ny = (y - clientRect.y) / clientRect.height;
  const nw = w / clientRect.width;
  const nh = h / clientRect.height;
  // 完全在 client_rect 外的节点过滤掉（窗口阴影 / 工具提示等）
  if (nx + nw < 0 || ny + nh < 0 || nx > 1.2 || ny > 1.2) return null;
  return {
    id: raw.path,
    role: raw.role,
    name: raw.name ?? undefined,
    description: raw.desc ?? undefined,
    automation_id: undefined,
    class_name: undefined,
    bbox_norm: [clamp(nx), clamp(ny), clamp(nw), clamp(nh)],
    enabled: raw.enabled ?? true,
    visible: true,
    children: undefined, // 我们已扁平化
  };
}

function clamp(v: number): number {
  if (v < 0) return 0;
  if (v > 1.5) return 1.5;
  return v;
}

/**
 * 在 JXA 端扁平化 AX 树。每个节点 stringify 时仅带 role/name/desc/pos/size。
 * 限制：默认深度 ≤ 6，节点数 ≤ 800；防止 osascript 在大型 app（Apple Music / Xcode）上卡死。
 * Apple Music sidebar/lists 可能有上千行；调用方可在 builder 中按需提高这些参数。
 */
/**
 * AX dump 性能说明：
 * - 每个节点 4 次 attribute query；JXA 调用 ObjC 桥很慢（每次 ~5-10ms）。
 * - 在 Apple Music 上 ~200 节点 + 4 attr = ~5-10s。比 35s 已大幅提速。
 * - 上限 MAX_NODES=300, MAX_DEPTH=5；建图阶段 explore 命令可临时提高。
 * - 跳过 position/size 调用次数同样多但不可省（locator 必须）。
 */
const AX_DUMP_SCRIPT = `
const se = Application("System Events");
const procs = se.processes();
let target = null;
for (let i = 0; i < procs.length; i++) {
  let pid = -1;
  try { pid = procs[i].unixId(); } catch (e) {}
  if (pid === __PID__) { target = procs[i]; break; }
}
if (!target) { JSON.stringify([]); }
else {
  const wins = target.windows();
  const out = [];
  const MAX_NODES = 300;
  const MAX_DEPTH = 5;
  function visit(el, depth, path) {
    if (out.length >= MAX_NODES || depth > MAX_DEPTH) return;
    let role = "?", desc = null, name = null, pos = null, size = null;
    try { role = el.role(); } catch (e) {}
    try { desc = el.description(); } catch (e) {}
    try { name = el.name(); } catch (e) {}
    try { pos = el.position(); } catch (e) {}
    try { size = el.size(); } catch (e) {}
    out.push({ role, name, desc, pos, size, enabled: true, depth, path });
    let kids = [];
    try { kids = el.uiElements(); } catch (e) {}
    const limit = Math.min(kids.length, 60);
    for (let j = 0; j < limit; j++) {
      if (out.length >= MAX_NODES) break;
      visit(kids[j], depth + 1, path + "/" + role + "[" + j + "]");
    }
  }
  if (wins.length > 0) visit(wins[0], 0, "win[0]");
  JSON.stringify(out);
}
`;
