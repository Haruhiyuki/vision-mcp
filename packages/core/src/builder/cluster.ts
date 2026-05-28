// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Vision-MCP Authors
import type { NodeRef } from "./discover.js";

/**
 * 同类元素聚类：从一组 NodeRef 中找出"等间距的网格 / 列 / 行"模式。
 * 输出 CollectionDraft 列表，用于 buildDraft 时生成 collection 而非 N 个独立 control。
 *
 * 算法：
 *   1. 按 role 分桶
 *   2. 桶内按 (x, y) 排序
 *   3. 找等间距子序列：相邻 cell 的 dx ≈ 常数 → row；dy ≈ 常数 → column；
 *      二维等距 → grid（cols × rows）
 *   4. 至少 3 个 cell 才聚类（避免 2 个就被误判）
 */
export interface CollectionDraft {
  /** 模板 cell（第一个 cell）的 bbox_norm */
  cell_bbox_norm: [number, number, number, number];
  layout: "grid" | "row" | "column";
  rows?: number;
  cols?: number;
  count?: number;
  spacing_x: number;
  spacing_y: number;
  /** 此 collection 覆盖的原始节点 ids（drafter 把这些从 controls 列表中移除） */
  member_ax_paths: string[];
  /** 起一个有意义的 id 草稿（基于 role 和位置） */
  suggested_id: string;
}

export interface ClusterResult {
  collections: CollectionDraft[];
  /** 没参与 collection 的节点（应保留为独立 control） */
  loose_nodes: NodeRef[];
}

const EPS_NORM = 0.02;  // 间距相等判断容差（归一化）
const SIZE_EPS_NORM = 0.015;

export function clusterCollections(nodes: NodeRef[]): ClusterResult {
  // 按 role 分桶
  const buckets = new Map<string, NodeRef[]>();
  for (const n of nodes) {
    const role = n.role ?? "?";
    if (!buckets.has(role)) buckets.set(role, []);
    buckets.get(role)!.push(n);
  }

  const collections: CollectionDraft[] = [];
  const usedPaths = new Set<string>();

  for (const [role, items] of buckets) {
    if (items.length < 3) continue;
    // 只对相同大小的元素尝试聚类
    const sizeGroups = groupBySize(items);
    for (const group of sizeGroups) {
      if (group.length < 3) continue;
      const detected = detectGridLayout(group, role);
      if (detected) {
        collections.push(detected);
        for (const id of detected.member_ax_paths) usedPaths.add(id);
      }
    }
  }

  const loose_nodes = nodes.filter((n) => !usedPaths.has(n.ax_path));
  return { collections, loose_nodes };
}

function groupBySize(items: NodeRef[]): NodeRef[][] {
  const groups: NodeRef[][] = [];
  for (const n of items) {
    const [, , w, h] = n.bbox_norm;
    let placed = false;
    for (const g of groups) {
      const [, , w0, h0] = g[0].bbox_norm;
      if (Math.abs(w - w0) < SIZE_EPS_NORM && Math.abs(h - h0) < SIZE_EPS_NORM) {
        g.push(n);
        placed = true;
        break;
      }
    }
    if (!placed) groups.push([n]);
  }
  return groups;
}

function detectGridLayout(items: NodeRef[], role: string): CollectionDraft | null {
  if (items.length < 3) return null;
  // 排序 by y, then x
  const sorted = [...items].sort((a, b) => {
    const dy = a.bbox_norm[1] - b.bbox_norm[1];
    if (Math.abs(dy) > EPS_NORM * 2) return dy;
    return a.bbox_norm[0] - b.bbox_norm[0];
  });

  // 找有几个不同 y 值（行数）
  const rowYs: number[] = [];
  for (const it of sorted) {
    const y = it.bbox_norm[1];
    if (!rowYs.some((y0) => Math.abs(y - y0) < EPS_NORM)) rowYs.push(y);
  }
  // 找有几个不同 x 值（列数）
  const colXs: number[] = [];
  for (const it of sorted) {
    const x = it.bbox_norm[0];
    if (!colXs.some((x0) => Math.abs(x - x0) < EPS_NORM)) colXs.push(x);
  }
  rowYs.sort((a, b) => a - b);
  colXs.sort((a, b) => a - b);

  const expected = rowYs.length * colXs.length;
  // 必须铺满或几乎铺满
  if (sorted.length < Math.max(3, expected - 1)) return null;
  if (sorted.length > expected) return null;

  // 计算间距
  const spacingX = colXs.length > 1 ? avgDiff(colXs) : 0;
  const spacingY = rowYs.length > 1 ? avgDiff(rowYs) : 0;
  // 验证间距均匀（最大 vs 最小差 ≤ 30%）
  if (colXs.length > 1 && !isUniform(diffs(colXs))) return null;
  if (rowYs.length > 1 && !isUniform(diffs(rowYs))) return null;

  const first = sorted[0];
  const [, , w, h] = first.bbox_norm;
  const layout: CollectionDraft["layout"] =
    rowYs.length > 1 && colXs.length > 1 ? "grid" :
    colXs.length > 1 ? "row" : "column";

  return {
    cell_bbox_norm: [colXs[0], rowYs[0], w, h],
    layout,
    rows: layout === "grid" || layout === "column" ? rowYs.length : undefined,
    cols: layout === "grid" || layout === "row" ? colXs.length : undefined,
    count: layout === "row" ? colXs.length : layout === "column" ? rowYs.length : rowYs.length * colXs.length,
    spacing_x: spacingX,
    spacing_y: spacingY,
    member_ax_paths: sorted.map((s) => s.ax_path),
    suggested_id: `${sanitizeRole(role)}_${layout}`,
  };
}

function avgDiff(arr: number[]): number {
  const d = diffs(arr);
  return d.reduce((a, b) => a + b, 0) / d.length;
}

function diffs(arr: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < arr.length; i++) out.push(arr[i] - arr[i - 1]);
  return out;
}

function isUniform(arr: number[]): boolean {
  if (arr.length === 0) return true;
  const min = Math.min(...arr);
  const max = Math.max(...arr);
  return max <= min * 1.3 + EPS_NORM;
}

function sanitizeRole(role: string): string {
  return role.toLowerCase().replace(/^ax/, "").replace(/[^a-z0-9]/g, "_") || "ctrl";
}
