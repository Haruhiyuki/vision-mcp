import { describe, expect, it } from "vitest";
import { clusterCollections } from "@vision-mcp/core";
import type { NodeRef } from "@vision-mcp/core";

function node(
  x: number,
  y: number,
  w: number,
  h: number,
  role = "AXButton",
  i = 0,
): NodeRef {
  return {
    role,
    name: `btn_${i}`,
    description: undefined,
    bbox_norm: [x, y, w, h],
    ax_path: `n${i}`,
  };
}

describe("clusterCollections (P2)", () => {
  it("识别 4x2 网格为 grid collection", () => {
    const items: NodeRef[] = [];
    let idx = 0;
    for (let r = 0; r < 2; r++) {
      for (let c = 0; c < 4; c++) {
        items.push(node(0.2 + c * 0.15, 0.1 + r * 0.12, 0.13, 0.09, "AXButton", idx++));
      }
    }
    const res = clusterCollections(items);
    expect(res.collections).toHaveLength(1);
    expect(res.collections[0].layout).toBe("grid");
    expect(res.collections[0].rows).toBe(2);
    expect(res.collections[0].cols).toBe(4);
    expect(res.collections[0].member_ax_paths).toHaveLength(8);
    expect(res.loose_nodes).toHaveLength(0);
  });

  it("识别 row 等距序列", () => {
    const items: NodeRef[] = [];
    for (let c = 0; c < 5; c++) {
      items.push(node(0.1 + c * 0.18, 0.5, 0.16, 0.04, "AXCell", c));
    }
    const res = clusterCollections(items);
    expect(res.collections).toHaveLength(1);
    expect(res.collections[0].layout).toBe("row");
    expect(res.collections[0].cols).toBe(5);
  });

  it("不强行把 2 个元素聚类", () => {
    const items = [
      node(0.1, 0.1, 0.1, 0.1, "AXButton", 0),
      node(0.5, 0.1, 0.1, 0.1, "AXButton", 1),
    ];
    const res = clusterCollections(items);
    expect(res.collections).toHaveLength(0);
    expect(res.loose_nodes).toHaveLength(2);
  });

  it("不同 size 不聚类（不同尺寸视为不同语义）", () => {
    const items = [
      node(0.1, 0.1, 0.10, 0.05, "AXButton", 0),
      node(0.25, 0.1, 0.10, 0.05, "AXButton", 1),
      node(0.4, 0.1, 0.10, 0.05, "AXButton", 2),
      // 一个明显更大的按钮
      node(0.6, 0.1, 0.25, 0.10, "AXButton", 3),
    ];
    const res = clusterCollections(items);
    // 3 个小按钮可能聚类为 row（rows=1 cols=3），大按钮孤立
    expect(res.loose_nodes.some((n) => n.ax_path === "n3")).toBe(true);
  });
});
