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
  const rawDoc = YAML.parse(text);
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
    // 去掉 flow 数组的 padding 空格，让 [1280, 800] 不变 [ 1280, 800 ]
    flowCollectionPadding: false,
  });
}

/**
 * 写入 baseline 文件并覆盖原 map。会校验后再写。
 */
export async function saveMap(
  mapPath: string,
  map: VisionMapT,
): Promise<void> {
  const validated = VisionMap.parse(map);
  const text = dumpMap(validated);
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
