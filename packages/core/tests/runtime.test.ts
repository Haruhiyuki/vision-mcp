// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Vision-MCP Authors
import { describe, expect, it } from "vitest";
import {
  Capsule,
  CallbackApprovalResolver,
  FixedOcrProvider,
  MockPlatformAdapter,
  RuntimeExecutor,
  VisionMap,
} from "@vision-mcp/core";

const map = VisionMap.parse({
  version: "0.1",
  app: { id: "demo", name: "Demo", platform: "any" },
  visual_box: {
    id: "cap",
    mode: "real_window",
    platform: "any",
    coordinate_space: "normalized_client_rect",
    display: { width_px: 800, height_px: 600 },
    target_window: { process_name: "demo.exe" },
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
          label: "Submit",
          action_types: ["click"],
          locator_priority: [
            { type: "ocr_text", text: "Submit", match: "contains", min_confidence: 0.8 },
            { type: "bbox_norm", value: [0.4, 0.4, 0.2, 0.05] },
          ],
          visual: { bbox_norm: [0.4, 0.4, 0.2, 0.05] },
          postcondition: { type: "text_should_appear", text: "Done", timeout_ms: 1000 },
          risk_level: "safe",
        },
      ],
    },
    {
      id: "after",
      anchors: [{ type: "ocr_text", text: "Done" }],
      controls: [],
    },
  ],
});

describe("RuntimeExecutor end-to-end (mock)", () => {
  it("perform_action 完整成功路径", async () => {
    const adapter = new MockPlatformAdapter();
    adapter.addWindow({
      title: "Demo Window",
      process_name: "demo.exe",
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      is_foreground: true,
    });

    // 让 OCR 第一次返回 "Submit" 命中按钮，第二次返回 "Done" 让 postcondition 通过。
    let calls = 0;
    const ocrTokensFirst = [
      { text: "Hello", bbox_norm: [0.1, 0.1, 0.1, 0.05] as [number, number, number, number], confidence: 0.95 },
      { text: "Submit", bbox_norm: [0.4, 0.4, 0.2, 0.05] as [number, number, number, number], confidence: 0.95 },
    ];
    const ocrTokensAfter = [
      { text: "Done", bbox_norm: [0.5, 0.5, 0.1, 0.05] as [number, number, number, number], confidence: 0.96 },
    ];
    const providers = {
      ocr: {
        recognize: async () => {
          calls++;
          return calls < 3 ? ocrTokensFirst : ocrTokensAfter;
        },
      },
    };

    const cap = new Capsule(map.visual_box, adapter, map.input_lease_policy);
    const display = await cap.ensureDisplay({
      geometry: map.visual_box.display,
      mode: map.visual_box.mode,
    });
    await cap.attach({ target: map.visual_box.target_window! });
    await cap.migrate(display.id);
    const rt = new RuntimeExecutor({
      map,
      mapBaseDir: ".",
      capsule: cap,
      providers,
      approval: new CallbackApprovalResolver(async () => "granted"),
    });
    const result = await rt.performAction("home.btn");
    expect(result.succeeded).toBe(true);
    expect(result.locator?.locator_used).toBe("ocr_text");
    expect(result.postcondition_ok).toBe(true);
  });

  it("repair_minimal L0 在几何已 OK 时返回成功", async () => {
    const adapter = new MockPlatformAdapter();
    adapter.addWindow({
      title: "Demo Window",
      process_name: "demo.exe",
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      is_foreground: true,
    });
    const cap = new Capsule(map.visual_box, adapter, map.input_lease_policy);
    const display = await cap.ensureDisplay({
      geometry: map.visual_box.display,
      mode: map.visual_box.mode,
    });
    await cap.attach({ target: map.visual_box.target_window! });
    await cap.migrate(display.id);
    const rt = new RuntimeExecutor({
      map,
      mapBaseDir: ".",
      capsule: cap,
      providers: { ocr: new FixedOcrProvider([]) },
    });
    const r = await rt.repairAttempt(0);
    expect(r.ok).toBe(true);
  });
});
