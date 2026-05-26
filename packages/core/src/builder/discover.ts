import { promises as fs } from "node:fs";
import path from "node:path";
import type { Capsule, PlatformAdapter } from "../capsule/manager.js";
import type {
  AccessibilityNode,
  AccessibilityProvider,
} from "../locator/types.js";
import { DHashProvider } from "../locator/visual-hash.js";
import { VisionMcpError } from "../errors.js";

export interface DiscoverOptions {
  /** 最大尝试 click 数（防止指数爆炸）。 */
  max_clicks?: number;
  /** 探索深度（从初始页向外的最大跳数）。 */
  max_depth?: number;
  /** 单次 click 后等待页面稳定的毫秒数。 */
  click_wait_ms?: number;
  /** 用于判断"页面变化"的视觉相似度阈值（< 此值视为变化）。 */
  page_change_visual_threshold?: number;
  /** 用于判断"返回成功"的视觉相似度阈值（>= 此值视为回到了来源页）。 */
  return_visual_threshold?: number;
  /** 候选返回操作。顺序尝试，第一个能把页面变回 source 的就记为该 transition 的 return action。 */
  return_actions?: ReturnAction[];
  /**
   * 过滤可点 anchor：返回 true 才会被尝试。默认排除尺寸过小、tooltip、padding 节点。
   */
  filter?: (n: AccessibilityNode) => boolean;
  /** 截图 + ax 输出根目录。每个新发现的 page 一个子目录。 */
  out_dir: string;
  /** 进度回调。 */
  on_progress?: (msg: string) => void;
}

export type ReturnAction =
  | { kind: "key"; combo: string }
  | { kind: "click_back_button" }
  | { kind: "double_esc" }
  | { kind: "click_norm"; point: [number, number] };

export interface PageFingerprint {
  visual_hash: string;
  ax_signature: string;
  window_title: string;
}

export interface DiscoveredPage {
  id: string;
  fingerprint: PageFingerprint;
  visited_at: string;
  out_dir: string;
  /** 该页可探索的可交互节点。 */
  candidates: NodeRef[];
  /** 从此页到达其它页的 transitions。 */
  outgoing: DiscoveredTransition[];
}

export interface NodeRef {
  role: string;
  name?: string;
  description?: string;
  bbox_norm: [number, number, number, number];
  /** path 用于稳定标识同一个 AX 节点。 */
  ax_path: string;
}

export interface DiscoveredTransition {
  from_page: string;
  to_page: string;
  click: NodeRef;
  /** 哪个返回 action 把页面带回了 source；null 表示找不到返回路径。 */
  return_via: ReturnAction | null;
  notes?: string;
}

export interface DiscoverResult {
  pages: DiscoveredPage[];
  transitions: DiscoveredTransition[];
  /**
   * 建议草稿：可直接作为 vision-mcp.yaml 中 states 的起点；agent/人类再补 anchor / locator / 风险级别。
   */
  draft_states: Array<{
    id: string;
    anchors_hint: Array<{ role: string; description?: string; name?: string }>;
    controls_hint: Array<{
      id: string;
      role: string;
      label?: string;
      bbox_norm: [number, number, number, number];
      goes_to?: string;
      return_via?: ReturnAction;
    }>;
  }>;
}

const DEFAULT_RETURN_ACTIONS: ReturnAction[] = [
  { kind: "key", combo: "Escape" },
  { kind: "key", combo: "cmd+[" },
  { kind: "double_esc" },
  { kind: "click_back_button" },
];

/**
 * 自动探索：BFS 遍历所有可交互节点，每个 click 后比对页面 fingerprint，自动尝试返回路径。
 *
 * 这是 vision-mcp 的核心建图能力——"像人一样使用软件"：
 *   1. 截图当前页 -> 记 fingerprint A。
 *   2. 列出页面上的可交互 AX 节点（去重 + 过滤）。
 *   3. 选第一个未尝试节点，click，等页面稳定。
 *   4. 截图 -> fingerprint B。
 *      a. B == A -> 标记 "no-op"，跳过。
 *      b. B != A -> 是一个新页面（或可能是已发现过的 page）。
 *   5. 尝试一系列 return actions，找到第一个能把页面回到 A 的。
 *   6. 记录 transition (A, click_node, B, return_action)。
 *   7. 把 B 加入待探索队列，BFS 继续。
 *   8. 输出 discover.json（pages + transitions）+ draft.yaml 草稿。
 */
export class Discoverer {
  private capsule: Capsule;
  private adapter: PlatformAdapter;
  private ax: AccessibilityProvider;
  private hasher = new DHashProvider();
  private opts: Required<Omit<DiscoverOptions, "filter" | "on_progress">> & {
    filter?: DiscoverOptions["filter"];
    on_progress?: DiscoverOptions["on_progress"];
  };
  private pages = new Map<string, DiscoveredPage>();
  private transitions: DiscoveredTransition[] = [];
  private clickedSet = new Set<string>(); // page_id + ":" + ax_path

  constructor(
    capsule: Capsule,
    adapter: PlatformAdapter,
    ax: AccessibilityProvider,
    opts: DiscoverOptions,
  ) {
    this.capsule = capsule;
    this.adapter = adapter;
    this.ax = ax;
    this.opts = {
      max_clicks: opts.max_clicks ?? 20,
      max_depth: opts.max_depth ?? 2,
      click_wait_ms: opts.click_wait_ms ?? 1500,
      page_change_visual_threshold: opts.page_change_visual_threshold ?? 0.9,
      return_visual_threshold: opts.return_visual_threshold ?? 0.85,
      return_actions: opts.return_actions ?? DEFAULT_RETURN_ACTIONS,
      out_dir: opts.out_dir,
      filter: opts.filter,
      on_progress: opts.on_progress,
    };
  }

  async run(): Promise<DiscoverResult> {
    await fs.mkdir(this.opts.out_dir, { recursive: true });
    const log = (s: string) => this.opts.on_progress?.(s);

    const root = await this.capturePage("page-0", 0);
    log(`root page: ${root.id} candidates=${root.candidates.length}`);
    const queue: Array<{ page: DiscoveredPage; depth: number }> = [
      { page: root, depth: 0 },
    ];
    let clicks = 0;

    while (queue.length > 0 && clicks < this.opts.max_clicks) {
      const { page, depth } = queue.shift()!;
      if (depth >= this.opts.max_depth) continue;
      for (const node of page.candidates) {
        if (clicks >= this.opts.max_clicks) break;
        const key = page.id + ":" + node.ax_path;
        if (this.clickedSet.has(key)) continue;
        this.clickedSet.add(key);
        clicks++;
        log(`click ${clicks}/${this.opts.max_clicks}: page=${page.id} node=${node.role}|${node.name ?? node.description}`);
        // 1. 当前 fingerprint
        const beforeFp = page.fingerprint;
        // 2. click
        try {
          await this.clickNode(node);
          await sleep(this.opts.click_wait_ms);
        } catch (err) {
          log(`  click failed: ${(err as Error).message}`);
          continue;
        }
        // 3. 新 fingerprint
        const afterFp = await this.fingerprint();
        // 4. no-op?
        const sim = this.hasher.similarity(afterFp.visual_hash, beforeFp.visual_hash);
        if (
          sim >= this.opts.page_change_visual_threshold &&
          afterFp.ax_signature === beforeFp.ax_signature
        ) {
          log(`  → no-op (sim=${sim.toFixed(2)})`);
          continue;
        }
        // 5. 找到/创建 to-page
        let to = this.findPageByFingerprint(afterFp);
        if (!to) {
          const newId = `page-${this.pages.size}`;
          to = await this.capturePage(newId, this.pages.size, afterFp);
          log(`  → new page ${to.id} (cands=${to.candidates.length})`);
          queue.push({ page: to, depth: depth + 1 });
        } else {
          log(`  → known page ${to.id}`);
        }
        // 6. 找返回 action
        let returnVia: ReturnAction | null = null;
        for (const ra of this.opts.return_actions) {
          try {
            await this.execReturn(ra);
            await sleep(700);
            const fpBack = await this.fingerprint();
            const back =
              this.hasher.similarity(fpBack.visual_hash, beforeFp.visual_hash) >=
                this.opts.return_visual_threshold ||
              fpBack.ax_signature === beforeFp.ax_signature;
            if (back) {
              returnVia = ra;
              log(`  return via ${describeReturn(ra)}`);
              break;
            }
          } catch {
            // ignored
          }
        }
        // 7. record transition
        this.transitions.push({
          from_page: page.id,
          to_page: to.id,
          click: node,
          return_via: returnVia,
          notes: returnVia ? undefined : "no automatic return path found",
        });
        page.outgoing.push(this.transitions[this.transitions.length - 1]);
        // 8. 如果未能返回到 beforeFp，无法继续遍历同一页其余 candidates；break 跳出
        if (!returnVia) {
          log(`  cannot return to ${page.id}, stop exploring this page`);
          break;
        }
      }
    }

    const result: DiscoverResult = {
      pages: [...this.pages.values()],
      transitions: this.transitions,
      draft_states: this.buildDraft(),
    };
    await fs.writeFile(
      path.join(this.opts.out_dir, "discover.json"),
      JSON.stringify(result, null, 2),
    );
    return result;
  }

  // --- helpers ----------------------------------------------------------

  private async clickNode(node: NodeRef): Promise<void> {
    const status = await this.capsule.status();
    const cr = status.geometry?.client_rect_px;
    if (!cr) throw new VisionMcpError("GEOMETRY_MISMATCH", "client_rect missing");
    const [x, y, w, h] = node.bbox_norm;
    const pt = {
      x: Math.round(cr.x + (x + w / 2) * cr.width),
      y: Math.round(cr.y + (y + h / 2) * cr.height),
    };
    await this.capsule.raise().catch(() => {});
    await this.adapter.click(pt);
  }

  private async execReturn(action: ReturnAction): Promise<void> {
    await this.capsule.raise().catch(() => {});
    switch (action.kind) {
      case "key":
        await this.adapter.pressKey({ combo: action.combo });
        return;
      case "double_esc":
        await this.adapter.pressKey({ combo: "Escape" });
        await sleep(150);
        await this.adapter.pressKey({ combo: "Escape" });
        return;
      case "click_norm": {
        const status = await this.capsule.status();
        const cr = status.geometry?.client_rect_px;
        if (!cr) return;
        await this.adapter.click({
          x: Math.round(cr.x + action.point[0] * cr.width),
          y: Math.round(cr.y + action.point[1] * cr.height),
        });
        return;
      }
      case "click_back_button": {
        // 在当前页找 description/name 含「返回 / Back / ◁」的按钮
        if (!this.ax || !this.capsule) return;
        const status = await this.capsule.status();
        if (!status.attached_window) return;
        if ((this.ax as AccessibilityProvider & { invalidate?: () => void }).invalidate) {
          (this.ax as AccessibilityProvider & { invalidate?: () => void }).invalidate?.();
        }
        const nodes = await this.ax.snapshot(status.attached_window.native_handle);
        const back = nodes.find(
          (n) =>
            n.role === "AXButton" &&
            (/(返回|Back|◁|‹|<|上一)/.test(n.name ?? "") ||
              /(返回|Back|◁|‹|<|上一)/.test(n.description ?? "")),
        );
        if (!back) throw new Error("no back button");
        await this.clickNode({
          role: back.role ?? "AXButton",
          name: back.name,
          description: back.description,
          bbox_norm: back.bbox_norm,
          ax_path: back.id,
        });
        return;
      }
    }
  }

  private async fingerprint(): Promise<PageFingerprint> {
    const frame = await this.capsule.capture();
    const status = await this.capsule.status();
    const handle = status.attached_window?.native_handle ?? "";
    if ((this.ax as AccessibilityProvider & { invalidate?: () => void }).invalidate) {
      (this.ax as AccessibilityProvider & { invalidate?: () => void }).invalidate?.(handle);
    }
    const nodes = handle ? await this.ax.snapshot(handle) : [];
    const visual_hash = await this.hasher.hash(frame);
    // ax_signature：top 15 个有 name/description 的节点签名（角色+主键）
    const sig = nodes
      .filter((n) => n.name || n.description)
      .slice(0, 15)
      .map((n) => `${n.role}:${n.name ?? n.description}`)
      .sort()
      .join("|");
    return {
      visual_hash,
      ax_signature: sig,
      window_title: status.attached_window?.title ?? "",
    };
  }

  private findPageByFingerprint(fp: PageFingerprint): DiscoveredPage | null {
    for (const p of this.pages.values()) {
      if (
        p.fingerprint.ax_signature === fp.ax_signature &&
        this.hasher.similarity(p.fingerprint.visual_hash, fp.visual_hash) >=
          this.opts.return_visual_threshold
      ) {
        return p;
      }
    }
    return null;
  }

  private async capturePage(
    id: string,
    index: number,
    fp?: PageFingerprint,
  ): Promise<DiscoveredPage> {
    const fingerprint = fp ?? (await this.fingerprint());
    const pageDir = path.join(this.opts.out_dir, id);
    await fs.mkdir(pageDir, { recursive: true });
    const status = await this.capsule.status();
    const cr = status.geometry?.client_rect_px;
    if (cr && this.adapter.platform === "macos") {
      try {
        const { execFile } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const execFileP = promisify(execFile);
        await execFileP("/usr/sbin/screencapture", [
          "-x",
          "-t",
          "png",
          "-R",
          `${cr.x},${cr.y},${cr.width},${cr.height}`,
          path.join(pageDir, "frame.png"),
        ]);
      } catch {}
    }
    const handle = status.attached_window?.native_handle ?? "";
    const nodes = handle ? await this.ax.snapshot(handle) : [];
    await fs.writeFile(path.join(pageDir, "ax.json"), JSON.stringify(nodes, null, 2));
    await fs.writeFile(
      path.join(pageDir, "fingerprint.json"),
      JSON.stringify(fingerprint, null, 2),
    );
    const candidates = this.extractCandidates(nodes);
    await fs.writeFile(
      path.join(pageDir, "candidates.json"),
      JSON.stringify(candidates, null, 2),
    );
    const page: DiscoveredPage = {
      id,
      fingerprint,
      visited_at: new Date().toISOString(),
      out_dir: pageDir,
      candidates,
      outgoing: [],
    };
    this.pages.set(id, page);
    return page;
  }

  private extractCandidates(nodes: AccessibilityNode[]): NodeRef[] {
    const list: NodeRef[] = [];
    const seen = new Set<string>();
    for (const n of nodes) {
      if (!isInteractive(n)) continue;
      if (this.opts.filter && !this.opts.filter(n)) continue;
      const [x, y, w, h] = n.bbox_norm;
      if (w < 0.005 || h < 0.005) continue; // 过小，可能是装饰
      const key = `${n.role}|${n.name ?? n.description ?? ""}|${x.toFixed(2)},${y.toFixed(2)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      list.push({
        role: n.role ?? "?",
        name: n.name,
        description: n.description,
        bbox_norm: n.bbox_norm,
        ax_path: n.id,
      });
    }
    return list;
  }

  private buildDraft(): DiscoverResult["draft_states"] {
    return [...this.pages.values()].map((p) => ({
      id: p.id,
      anchors_hint: p.candidates.slice(0, 3).map((c) => ({
        role: c.role,
        description: c.description,
        name: c.name,
      })),
      controls_hint: p.candidates.map((c, i) => {
        const tr = p.outgoing.find((t) => t.click.ax_path === c.ax_path);
        return {
          id: sanitizeId(c.name ?? c.description ?? `ctrl_${i}`),
          role: c.role,
          label: c.name ?? c.description,
          bbox_norm: c.bbox_norm,
          goes_to: tr?.to_page,
          return_via: tr?.return_via ?? undefined,
        };
      }),
    }));
  }
}

function isInteractive(n: AccessibilityNode): boolean {
  const r = n.role ?? "";
  if (
    /(AXButton|AXTextField|AXSearchField|AXPopUpButton|AXMenuItem|AXTab|AXLink|AXSlider|AXCheckBox|AXRadioButton)/.test(
      r,
    )
  )
    return true;
  // AXCell 在 sidebar 之外的搜索结果 / 列表都是可点击的
  if (r === "AXCell" && (n.description || n.name) && n.description !== "单元格") return true;
  return false;
}

function describeReturn(a: ReturnAction): string {
  if (a.kind === "key") return `key(${a.combo})`;
  if (a.kind === "double_esc") return "double_esc";
  if (a.kind === "click_back_button") return "click_back_button";
  return `click_norm(${a.point[0].toFixed(2)},${a.point[1].toFixed(2)})`;
}

function sanitizeId(s: string): string {
  return (
    s
      .replace(/[^a-zA-Z0-9_.\-]/g, "_")
      .replace(/^_+/, "")
      .slice(0, 48) || "ctrl"
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
