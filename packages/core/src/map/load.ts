// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Vision-MCP Authors
import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { VisionMap } from "../schema/index.js";
import type { VisionMap as VisionMapT } from "../schema/index.js";
import { Patch } from "../schema/patch.js";
import type { Patch as PatchT } from "../schema/patch.js";

export interface MapLoadResult {
  baseline: VisionMapT;
  patches: PatchT[];
  effective: VisionMapT;
  baselinePath: string;
  baseDir: string;
  patchPaths: string[];
  /**
   * 原始 yaml Document 实例（未经 zod 解析），保留注释 / 格式 / 字段顺序。
   * saveMap 用它作为基底走增量改：原文档已有字段被新值覆盖，注释保留；
   * 数组按 newJs 长度调整；原文档没有的字段（zod default 注入）跳过。
   */
  baselineDoc: YAML.Document.Parsed;
}

export interface MapLoadOptions {
  /** 默认 true：加载相邻 patches/ 目录下的所有 *.yaml。 */
  loadPatches?: boolean;
  /** 仅加载 trust 在该列表内的 patch。默认 ["trusted", "session_only"]。 */
  trustFilter?: PatchT["trust"][];
  /** 额外手动指定的 patch 文件（绝对路径）。 */
  extraPatchFiles?: string[];
}

/**
 * 从磁盘加载 vision-mcp.yaml + patches，并按 trust 顺序合并出有效 map。
 *
 * 加载顺序（设计文档 §12.3）：
 *   baseline → trusted patches → session patches → untrusted proposals(不自动应用)
 */
export async function loadMap(
  mapPath: string,
  options: MapLoadOptions = {},
): Promise<MapLoadResult> {
  const {
    loadPatches = true,
    trustFilter = ["trusted", "session_only"],
    extraPatchFiles = [],
  } = options;

  const absMapPath = path.resolve(mapPath);
  const baseDir = path.dirname(absMapPath);
  const text = await fs.readFile(absMapPath, "utf8");
  // 用 parseDocument 保留注释 / 格式 / 节点位置，作 incremental save 的基底
  const baselineDoc = YAML.parseDocument(text);
  const rawDoc = baselineDoc.toJS();
  const baseline = VisionMap.parse(rawDoc);

  let patchPaths: string[] = [];
  if (loadPatches) {
    const patchDir = path.join(baseDir, "patches");
    try {
      const entries = await fs.readdir(patchDir);
      patchPaths = entries
        .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
        .map((f) => path.join(patchDir, f))
        .sort();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  patchPaths = [...patchPaths, ...extraPatchFiles.map((p) => path.resolve(p))];

  const patches: PatchT[] = [];
  for (const pp of patchPaths) {
    const raw = YAML.parse(await fs.readFile(pp, "utf8"));
    const parsed = Patch.parse(raw);
    if (trustFilter.includes(parsed.trust)) {
      patches.push(parsed);
    }
  }

  const effective = applyPatches(baseline, patches);
  return {
    baseline,
    patches,
    effective,
    baselinePath: absMapPath,
    baseDir,
    patchPaths,
    baselineDoc,
  };
}

/**
 * 把 patches 顺序应用到 baseline 上。返回新对象，不修改原 baseline。
 */
export function applyPatches(
  baseline: VisionMapT,
  patches: PatchT[],
): VisionMapT {
  const draft: VisionMapT = structuredClone(baseline);
  for (const p of patches) {
    switch (p.kind) {
      case "geometry_profile": {
        if (draft.visual_box.id !== p.visual_box_id) break;
        Object.assign(draft.visual_box.display, p.display);
        if (p.display.width_px && p.display.height_px) {
          draft.visual_box.contract.require_client_size_px = [
            p.display.width_px,
            p.display.height_px,
          ];
        }
        break;
      }
      case "control_bbox": {
        const ctrl = findControlInDraft(draft, p.state_id, p.control_id);
        if (!ctrl) break;
        ctrl.visual = {
          ...(ctrl.visual ?? {}),
          bbox_norm: p.new_bbox_norm,
          center_norm: [
            p.new_bbox_norm[0] + p.new_bbox_norm[2] / 2,
            p.new_bbox_norm[1] + p.new_bbox_norm[3] / 2,
          ],
        };
        // 把 locator_priority 中的 bbox_norm locator 同步更新。
        for (const loc of ctrl.locator_priority) {
          if (loc.type === "bbox_norm") loc.value = p.new_bbox_norm;
        }
        break;
      }
      case "control_locator": {
        const ctrl = findControlInDraft(draft, p.state_id, p.control_id);
        if (!ctrl) break;
        Object.assign(ctrl, p.partial);
        break;
      }
      case "state": {
        const idx = draft.states.findIndex((s) => s.id === p.state.id);
        if (p.operation === "remove") {
          if (idx >= 0) draft.states.splice(idx, 1);
        } else if (p.operation === "replace") {
          if (idx >= 0) draft.states[idx] = p.state;
          else draft.states.push(p.state);
        } else {
          // add
          if (idx < 0) draft.states.push(p.state);
        }
        break;
      }
      case "control_add": {
        // state_id 既可以是 state.id 也可以是 region.id（与 findControlInDraft 对称）
        const state = draft.states.find((s) => s.id === p.state_id);
        const region = state ? null : draft.regions.find((r) => r.id === p.state_id);
        const targetControls = state?.controls ?? region?.controls;
        if (!targetControls) break;
        // 幂等：已存在同 id control → 跳过（不报错；要替换请用 control_locator patch）
        if (targetControls.find((c) => c.id === p.control.id)) break;
        targetControls.push(p.control);
        break;
      }
    }
  }
  return draft;
}

/**
 * 在 draft 中按 (state_id, control_id) 找 control。
 * - 优先在 states[].controls[] 里找；
 * - 找不到则在 regions[].controls[] 里找（patch.state_id 可以是 region.id）；
 * - 仍找不到则在 states[].inherit_regions 引用的 regions 里找。
 * 这让 control_bbox / control_locator patch 能修正 region 共享控件。
 */
function findControlInDraft(
  draft: VisionMapT,
  stateOrRegionId: string,
  controlId: string,
): import("../schema/index.js").Control | null {
  const state = draft.states.find((s) => s.id === stateOrRegionId);
  if (state) {
    const ctrl = state.controls.find((c) => c.id === controlId);
    if (ctrl) return ctrl;
    // state 里没有？看它 inherit 的 regions
    for (const rid of state.inherit_regions ?? []) {
      const region = draft.regions.find((r) => r.id === rid);
      const rc = region?.controls.find((c) => c.id === controlId);
      if (rc) return rc;
    }
  }
  // state_id 本身可能就是 region_id
  const region = draft.regions.find((r) => r.id === stateOrRegionId);
  if (region) {
    return region.controls.find((c) => c.id === controlId) ?? null;
  }
  return null;
}

/**
 * 把 VisionMap 序列化回 YAML，使用稳定 key 顺序。
 *
 * 关键：用 Document API 给"短标量数组"显式设 flow style（inline `[a, b, c]`），
 * 避免 yaml lib 把 bbox_norm / action_types / matched_anchors 这种短数组也展成多行 block。
 * 否则 commit_state / commit_workflow / harvest_session 任何写 baseline 的工具
 * 都会把 hand-edited yaml 的紧凑可读格式毁掉（实例：bbox_norm: [0, 0, 0.085, 1] → 4 行）。
 *
 * 已知限制：注释（# ...）在 zod parse → re-stringify 这条路径会丢失，因为我们用对象重建
 * 而不是基于原 YAML doc 增量改。保留注释需要 loadMap/saveMap 改成 doc-level diff，
 * 目前没做。
 */
export function dumpMap(map: VisionMapT): string {
  const doc = new YAML.Document(map);
  YAML.visit(doc, {
    Seq(_, node) {
      // 短数组（≤ 8 元素）且全部是标量 → 用 flow style 保 inline
      // 典型场景：bbox_norm[4] / center_norm[2] / action_types[2-3] / tags[N]
      // / require_client_size_px[2] / matched_anchors[N]
      // 含 object/map 的数组（如 states / locator_priority / patches / steps）不变，保持 block
      if (
        node.items.length > 0 &&
        node.items.length <= 8 &&
        node.items.every((item) => YAML.isScalar(item))
      ) {
        node.flow = true;
      }
    },
  });
  return doc.toString({
    indent: 2,
    lineWidth: 120,
    blockQuote: "literal",
  });
}

/**
 * 把 newJs 的所有路径增量应用到原 doc（保留注释 / 格式 / 节点顺序）。
 *
 * 算法：
 *   - 原 doc 已有的 leaf path 且值变了 → setIn 更新（保留节点位置 + 周围注释）
 *   - 原 doc 没有的字段 → 跳过（zod default 注入或非声明字段，避免污染手编 yaml）
 *   - 数组超过原长度 → 用 newDoc 风格化的 node 追加
 *   - 数组短于原长度 → 截断末尾（如 commit_workflow overwrite 减少 step）
 *
 * "原 doc 没有的字段跳过" 是关键 — 这避免了 zod default（kind: control, risk_level: safe,
 * approval_required: false 等）污染 hand-edited yaml；同时保留所有手编注释。
 *
 * 例外：数组追加的"全新元素"（如 harvest_session 加的新 workflow）会写完整 node，
 * 包含 zod default 字段——因为新元素本来就没原文档存在的 baseline 可对比。
 */
function applyJsToDoc(doc: YAML.Document, jsValue: unknown, currentPath: (string | number)[] = []): void {
  // 数组
  if (Array.isArray(jsValue)) {
    const oldNode = doc.getIn(currentPath) as YAML.YAMLSeq | undefined;
    if (!oldNode || !YAML.isSeq(oldNode)) return;
    const oldLen = oldNode.items.length;
    // 1. 对原数组每个保留元素递归 update
    const overlap = Math.min(oldLen, jsValue.length);
    for (let i = 0; i < overlap; i++) {
      applyJsToDoc(doc, jsValue[i], [...currentPath, i]);
    }
    // 2. 追加新元素（用 newDoc 风格化的完整 node）
    for (let i = oldLen; i < jsValue.length; i++) {
      doc.addIn(currentPath, jsValue[i]);
    }
    // 3. 截断超出元素
    if (jsValue.length < oldLen) {
      oldNode.items.length = jsValue.length;
    }
    return;
  }
  // 对象
  if (jsValue !== null && typeof jsValue === "object") {
    const oldNode = doc.getIn(currentPath);
    if (!oldNode || !YAML.isMap(oldNode)) return;
    for (const key of Object.keys(jsValue as Record<string, unknown>)) {
      // 关键：只有原 doc 已声明此 key 才递归更新，避免 zod default 注入
      if (!oldNode.has(key)) continue;
      applyJsToDoc(doc, (jsValue as Record<string, unknown>)[key], [...currentPath, key]);
    }
    return;
  }
  // 标量：值变了才 setIn（保持节点位置 + 周围注释）
  const oldScalar = doc.getIn(currentPath);
  if (oldScalar !== jsValue) {
    doc.setIn(currentPath, jsValue);
  }
}

/**
 * 增量 dump：基于原 baselineDoc 把 map 的变化应用回去，保留注释 / 字段顺序 / 手编格式。
 * commit_state / commit_workflow / harvest_session 都走这条路径，避免每次 save 把
 * hand-edited yaml 重新规范化破坏掉。
 *
 * 仅"数组追加的新元素"会带 zod default 字段（不可避免——新元素本来就没有 baseline 对比）。
 * 已存在元素的 zod default 注入完全跳过。
 */
export function dumpMapIncremental(map: VisionMapT, baselineDoc: YAML.Document.Parsed): string {
  // 用 clone 避免污染调用方的 baselineDoc
  const doc = baselineDoc.clone();
  const newJs = JSON.parse(JSON.stringify(map));
  applyJsToDoc(doc, newJs);
  // 给"新加"的短 scalar 数组设 flow style；保留原 doc 已是 flow 的节点不动（避免破坏原始 source）
  YAML.visit(doc, {
    Seq(_, node) {
      if (
        !node.flow &&
        node.items.length > 0 &&
        node.items.length <= 8 &&
        node.items.every((item) => YAML.isScalar(item))
      ) {
        node.flow = true;
      }
    },
  });
  return doc.toString({
    indent: 2,
    lineWidth: 120,
    blockQuote: "literal",
    // yaml lib 全局 padding 设置不能 per-node 控制。选 false 让数组紧凑
    // （bbox_norm 等出现频率高，原文档大多不带 padding），代价是对象 padding 也去掉。
    // 第一次 save 后文件规范化，之后 round-trip 完全保真（自身收敛）。
    flowCollectionPadding: false,
  });
}

/**
 * 写入 baseline 文件并覆盖原 map。
 *
 * - 有 baselineDoc：走增量改路径，保留注释 + 格式（推荐，commit_* 系列工具默认这条）
 * - 没 baselineDoc：fallback 走 dumpMap 完整重写（init 等首次写入场景）
 */
export async function saveMap(
  mapPath: string,
  map: VisionMapT,
  options: { baselineDoc?: YAML.Document.Parsed } = {},
): Promise<void> {
  const validated = VisionMap.parse(map);
  const text = options.baselineDoc
    ? dumpMapIncremental(validated, options.baselineDoc)
    : dumpMap(validated);
  await fs.writeFile(path.resolve(mapPath), text, "utf8");
}

/**
 * 在 patches/ 目录追加一个 patch 文件。文件名格式：{date}-{slug}.yaml。
 */
export async function writePatch(
  baseDir: string,
  patch: PatchT,
  filenameSlug?: string,
): Promise<string> {
  const validated = Patch.parse(patch);
  const date = new Date().toISOString().slice(0, 10);
  const slug = filenameSlug ?? patch.id;
  const safeSlug = slug.replace(/[^a-zA-Z0-9_.\-]/g, "_");
  const patchDir = path.join(baseDir, "patches");
  await fs.mkdir(patchDir, { recursive: true });
  const filePath = path.join(patchDir, `${date}-${safeSlug}.yaml`);
  await fs.writeFile(filePath, YAML.stringify(validated, { indent: 2 }), "utf8");
  return filePath;
}
