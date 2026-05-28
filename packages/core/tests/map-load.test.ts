// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Vision-MCP Authors
import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  VisionMap,
  applyPatches,
  loadMap,
  saveMap,
  writePatch,
} from "@vision-mcp/core";

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "vision-mcp-test-"));
}

const sampleMap = (): import("@vision-mcp/core").VisionMap =>
  VisionMap.parse({
    version: "0.1",
    app: { id: "demo", name: "Demo", platform: "any" },
    visual_box: {
      id: "demo-cap",
      mode: "real_window",
      platform: "any",
      coordinate_space: "normalized_client_rect",
      display: { width_px: 800, height_px: 600 },
      contract: { require_client_size_px: [800, 600] },
    },
    states: [
      {
        id: "home",
        anchors: [{ type: "ocr_text", text: "Hello" }],
        controls: [
          {
            id: "btn",
            role: "button",
            action_types: ["click"],
            locator_priority: [
              { type: "bbox_norm", value: [0.2, 0.2, 0.3, 0.1] },
            ],
            visual: { bbox_norm: [0.2, 0.2, 0.3, 0.1] },
          },
        ],
      },
    ],
  });

describe("map io", () => {
  it("save + load 一致", async () => {
    const dir = await makeTempDir();
    const mp = path.join(dir, "vision-mcp.yaml");
    const original = sampleMap();
    await saveMap(mp, original);
    const result = await loadMap(mp);
    expect(result.baseline.app.id).toBe("demo");
    expect(result.effective.states[0].controls[0].id).toBe("btn");
  });

  it("applyPatches: control_bbox 覆盖 bbox 与 locator", async () => {
    const dir = await makeTempDir();
    const mp = path.join(dir, "vision-mcp.yaml");
    const original = sampleMap();
    await saveMap(mp, original);
    await writePatch(dir, {
      kind: "control_bbox",
      id: "patch-1",
      trust: "trusted",
      state_id: "home",
      control_id: "btn",
      new_bbox_norm: [0.5, 0.5, 0.2, 0.1],
      method: "test",
    } as never);
    const result = await loadMap(mp);
    const ctrl = result.effective.states[0].controls[0];
    expect(ctrl.visual?.bbox_norm).toEqual([0.5, 0.5, 0.2, 0.1]);
    expect(
      (ctrl.locator_priority[0] as { type: string; value: number[] }).value,
    ).toEqual([0.5, 0.5, 0.2, 0.1]);
  });

  it("applyPatches: geometry_profile 更新 require_client_size_px", () => {
    const baseline = sampleMap();
    const next = applyPatches(baseline, [
      {
        kind: "geometry_profile",
        id: "g1",
        trust: "trusted",
        visual_box_id: "demo-cap",
        display: { width_px: 1024, height_px: 768 },
        confidence: 1,
        requires_review: false,
      } as never,
    ]);
    expect(next.visual_box.display.width_px).toBe(1024);
    expect(next.visual_box.contract.require_client_size_px).toEqual([1024, 768]);
  });

  it("applyPatches: control_add 往现有 state 加新 control", () => {
    const baseline = sampleMap();
    const next = applyPatches(baseline, [
      {
        kind: "control_add",
        id: "add-1",
        trust: "session_only",
        state_id: "home",
        control: {
          id: "new_btn",
          role: "button",
          action_types: ["click"],
          locator_priority: [
            { type: "ocr_text", text: "设置", match: "exact" },
          ],
          visual: { center_norm: [0.7, 0.1] },
        },
        confidence: 0.9,
        requires_review: false,
      } as never,
    ]);
    const state = next.states.find((s) => s.id === "home")!;
    expect(state.controls).toHaveLength(2);
    expect(state.controls.map((c) => c.id)).toContain("new_btn");
    // 原 control 不动
    expect(state.controls.find((c) => c.id === "btn")).toBeTruthy();
  });

  it("applyPatches: control_add 幂等（重复 id 不报错也不重复添加）", () => {
    const baseline = sampleMap();
    const next = applyPatches(baseline, [
      {
        kind: "control_add",
        id: "add-dup",
        trust: "session_only",
        state_id: "home",
        control: {
          id: "btn", // 与 sample 已有的 control 同 id
          role: "button",
          action_types: ["click"],
          locator_priority: [{ type: "bbox_norm", value: [0.9, 0.9, 0.05, 0.05] }],
        },
        confidence: 1,
        requires_review: false,
      } as never,
    ]);
    const state = next.states.find((s) => s.id === "home")!;
    // 只剩原 control，没多
    expect(state.controls).toHaveLength(1);
    // 原 bbox 不被覆盖（要替换走 control_locator）
    expect(
      (state.controls[0].locator_priority[0] as { type: string; value: number[] }).value,
    ).toEqual([0.2, 0.2, 0.3, 0.1]);
  });

  it("applyPatches: control_add state_id 是 region.id 时往 region.controls 加", () => {
    const baseline = VisionMap.parse({
      ...sampleMap(),
      regions: [
        {
          id: "sidebar",
          controls: [
            {
              id: "old_item",
              role: "button",
              action_types: ["click"],
              locator_priority: [{ type: "bbox_norm", value: [0.0, 0.1, 0.2, 0.05] }],
            },
          ],
        },
      ],
    });
    const next = applyPatches(baseline, [
      {
        kind: "control_add",
        id: "add-region",
        trust: "trusted",
        state_id: "sidebar",
        control: {
          id: "new_item",
          role: "button",
          action_types: ["click"],
          locator_priority: [{ type: "ocr_text", text: "Library" }],
        },
        confidence: 1,
        requires_review: false,
      } as never,
    ]);
    const region = next.regions.find((r) => r.id === "sidebar")!;
    expect(region.controls).toHaveLength(2);
    expect(region.controls.map((c) => c.id)).toContain("new_item");
  });

  it("saveMap 增量改：注释 + 字段顺序 + 自身收敛", async () => {
    const dir = await makeTempDir();
    const mp = path.join(dir, "vision-mcp.yaml");

    // 写一份手编 yaml 含注释 + 自定义字段顺序
    const handEdited = `# 这是顶部注释
version: "0.1"
app:
  id: demo
  name: Demo
  platform: any  # 平台无关
visual_box:
  id: demo-cap
  mode: real_window
  platform: any
  coordinate_space: normalized_client_rect
  display:
    width_px: 800
    height_px: 600
  contract:
    require_client_size_px: [800, 600]
# 中间注释
states:
  - id: home
    anchors:
      - { type: ocr_text, text: Hello }
    controls:
      - id: btn
        role: button
        action_types: [click]
        locator_priority:
          - { type: bbox_norm, value: [0.2, 0.2, 0.3, 0.1] }
        visual: { bbox_norm: [0.2, 0.2, 0.3, 0.1] }
workflows: []
`;
    await fs.writeFile(mp, handEdited, "utf8");

    // 1. load → 立即 save → 应规范化一次
    const r1 = await loadMap(mp);
    const out1Path = path.join(dir, "save1.yaml");
    await saveMap(out1Path, r1.baseline, { baselineDoc: r1.baselineDoc });
    const out1 = await fs.readFile(out1Path, "utf8");

    // 2. 注释保留（关键！）
    expect(out1).toContain("# 这是顶部注释");
    expect(out1).toContain("# 中间注释");
    expect(out1).toContain("# 平台无关");

    // 3. 第二次 save 应自身收敛（0 diff）
    const r2 = await loadMap(out1Path);
    const out2Path = path.join(dir, "save2.yaml");
    await saveMap(out2Path, r2.baseline, { baselineDoc: r2.baselineDoc });
    const out2 = await fs.readFile(out2Path, "utf8");
    expect(out2).toBe(out1);

    // 4. 加新 workflow 不破坏原结构
    r2.baseline.workflows.push({
      id: "new_wf",
      description: "测试 harvest",
      inputs: [],
      steps: [{ action_id: "home.btn", approval_required: false, on_failure: "abort" as const }],
      timeout_ms: 120_000,
    });
    const out3Path = path.join(dir, "save3.yaml");
    await saveMap(out3Path, r2.baseline, { baselineDoc: r2.baselineDoc });
    const out3 = await fs.readFile(out3Path, "utf8");
    expect(out3).toContain("# 这是顶部注释");
    expect(out3).toContain("# 中间注释");
    expect(out3).toContain("id: new_wf");
    // 原状态字段不变（btn 不被 zod default 注入污染）
    expect(out3).not.toContain("kind: control"); // zod default 跳过
    expect(out3).not.toContain("approval_required: false\n        notes:"); // 不该注入空 notes
  });
});
