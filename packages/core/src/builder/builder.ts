// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Vision-MCP Authors
import { randomUUID } from "node:crypto";
import path from "node:path";
import { promises as fs } from "node:fs";
import type {
  AppDescriptor,
  Control,
  GeometryContract,
  State,
  VisionMap,
  Workflow,
} from "../schema/index.js";
import type { Capsule } from "../capsule/manager.js";
import { LocatorResolver } from "../locator/resolver.js";
import type {
  AccessibilityNode,
  FrameInsights,
  LocatorProviders,
  OcrToken,
} from "../locator/types.js";
import { dumpMap, saveMap } from "../map/load.js";

export interface BuilderOptions {
  app: AppDescriptor;
  visualBoxId?: string;
  capsule: Capsule;
  providers: LocatorProviders;
  /** map 输出目录。会写 vision-mcp.yaml 与 patches/。 */
  outDir: string;
}

export interface CapturedState {
  id: string;
  description?: string;
  kind?: State["kind"];
  insights: FrameInsights;
}

export class MapBuilder {
  private map: VisionMap;
  private resolver: LocatorResolver;

  constructor(private readonly opts: BuilderOptions) {
    this.resolver = new LocatorResolver(opts.providers);
    const status = opts.capsule.getVisualBox();
    this.map = {
      version: "0.1",
      app: opts.app,
      visual_box: {
        ...status,
        id: opts.visualBoxId ?? status.id,
      },
      regions: [],
      states: [],
      transitions: [],
      workflows: [],
      repair_policy: {
        max_auto_repair_level: 3,
        geometry: { tolerate_client_size_delta_px: 2, tolerate_origin_change: true, require_same_dpi: true },
        state: { min_anchor_score: 0.86, min_ocr_similarity: 0.88, min_visual_similarity: 0.82 },
        control_relocation: { confidence_threshold: 0.92, max_bbox_shift_norm: 0.08 },
        destructive_actions: { auto_repair_before_action: false, require_user_confirmation: true },
      },
      safety_policy: {
        forbidden_action_categories: [
          "payment",
          "destructive",
          "external_communication",
          "permission_change",
          "captcha",
        ],
        require_approval_for_risk_levels: ["requires_confirmation", "destructive"],
        redaction_patterns: [],
        allow_cloud_vlm: false,
        audit_log_retention_days: 30,
      },
      input_lease_policy: {
        default_lease_ms: 5000,
        break_on_user_input: true,
        break_hotkey: "Esc Esc",
        require_revalidate_after_break: true,
      },
      metadata: {
        created_at: new Date().toISOString(),
        created_by: "vision-mcp-builder",
        tags: [],
        builder_version: "0.1",
      },
    };
  }

  /**
   * 捕获当前 capsule 视图，分析 OCR/Accessibility/visual hash，作为新 state 的基础数据。
   */
  async captureCurrent(stateHints: Partial<State> = {}): Promise<CapturedState> {
    const frame = await this.opts.capsule.capture();
    const insights = await this.resolver.analyze(frame);
    const status = await this.opts.capsule.status();
    if (status.attached_window) {
      await this.resolver.setAccessibility(insights, status.attached_window.native_handle);
    }
    const id = stateHints.id ?? `state_${randomUUID().slice(0, 6)}`;
    return {
      id,
      description: stateHints.description,
      kind: stateHints.kind ?? "page",
      insights,
    };
  }

  /**
   * 从 captured state 自动生成 state record：
   *   - anchors 默认取 top-3 高置信度 OCR token + visual_hash。
   *   - controls：将 accessibility 中的 button/textbox/menu_item 转为 control，附带多 locator。
   */
  appendStateFromCapture(captured: CapturedState): State {
    const anchors: State["anchors"] = [];
    const topTokens = [...captured.insights.ocr]
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 3);
    for (const t of topTokens) {
      anchors.push({
        type: "ocr_text",
        text: t.text,
        min_confidence: Math.min(0.95, Math.max(0.6, t.confidence - 0.1)),
        match: "contains",
      });
    }
    if (captured.insights.visual_hash) {
      anchors.push({
        type: "visual_hash",
        hash: captured.insights.visual_hash,
        min_similarity: 0.82,
      });
    }
    const controls = buildControlsFromAccessibility(
      captured.insights.accessibility,
      captured.insights.ocr,
    );
    const state: State = {
      id: captured.id,
      description: captured.description,
      kind: captured.kind ?? "page",
      anchors: anchors.length
        ? anchors
        : [
            {
              type: "visual_hash",
              hash: captured.insights.visual_hash ?? "0000000000000000",
              min_similarity: 0.7,
            },
          ],
      match_policy: "any_anchor",
      controls,
      inherit_regions: [],
      variants: [],
    };
    // 去重：相同 id 直接覆盖
    const existingIdx = this.map.states.findIndex((s) => s.id === state.id);
    if (existingIdx >= 0) this.map.states[existingIdx] = state;
    else this.map.states.push(state);
    return state;
  }

  /**
   * 手动添加 / 编辑控件，例如人类演示阶段精确指定 button 的 locator。
   */
  upsertControl(stateId: string, control: Control): void {
    const state = this.map.states.find((s) => s.id === stateId);
    if (!state) throw new Error(`state ${stateId} not found`);
    const idx = state.controls.findIndex((c) => c.id === control.id);
    if (idx >= 0) state.controls[idx] = control;
    else state.controls.push(control);
  }

  addTransition(t: { from: string; to: string; action_id: string; verify?: State["controls"] }): void {
    this.map.transitions.push({
      from: t.from,
      action_id: t.action_id,
      to: t.to,
      verify: [],
    });
  }

  addWorkflow(workflow: Workflow): void {
    const idx = this.map.workflows.findIndex((w) => w.id === workflow.id);
    if (idx >= 0) this.map.workflows[idx] = workflow;
    else this.map.workflows.push(workflow);
  }

  setGeometry(g: GeometryContract): void {
    this.map.visual_box.display = g;
  }

  current(): VisionMap {
    return this.map;
  }

  async write(): Promise<string> {
    await fs.mkdir(this.opts.outDir, { recursive: true });
    const mapPath = path.join(this.opts.outDir, "vision-mcp.yaml");
    await saveMap(mapPath, this.map);
    return mapPath;
  }

  serialize(): string {
    return dumpMap(this.map);
  }
}

function buildControlsFromAccessibility(
  nodes: AccessibilityNode[],
  ocr: OcrToken[],
): Control[] {
  const controls: Control[] = [];
  const flat: AccessibilityNode[] = [];
  const walk = (list: AccessibilityNode[]) => {
    for (const n of list) {
      flat.push(n);
      if (n.children) walk(n.children);
    }
  };
  walk(nodes);
  for (const n of flat) {
    const role = (n.role ?? "").toLowerCase();
    const isInteractive =
      /(button|textbox|edit|combo|menu_?item|menuitem|tab|link|listitem|list_item)/.test(role);
    if (!isInteractive) continue;
    const id = sanitizeId(n.automation_id ?? n.name ?? `ctrl_${flat.indexOf(n)}`);
    const actionTypes = inferActionTypes(role);
    const center: [number, number] = [
      n.bbox_norm[0] + n.bbox_norm[2] / 2,
      n.bbox_norm[1] + n.bbox_norm[3] / 2,
    ];
    const control: Control = {
      kind: "control",
      id,
      role: simplifyRole(role),
      label: n.name,
      description: n.description,
      action_types: actionTypes,
      locator_priority: buildLocatorPriority(n, ocr),
      visual: {
        bbox_norm: n.bbox_norm,
        center_norm: center,
      },
      risk_level: inferRisk(n.name ?? ""),
      approval_required: inferRisk(n.name ?? "") !== "safe",
    };
    controls.push(control);
  }
  // 去重 id
  const seen = new Set<string>();
  return controls.filter((c) => {
    if (seen.has(c.id)) return false;
    seen.add(c.id);
    return true;
  });
}

function buildLocatorPriority(node: AccessibilityNode, ocr: OcrToken[]): Control["locator_priority"] {
  const list: Control["locator_priority"] = [];
  if (node.automation_id) {
    list.push({ type: "accessibility", automation_id: node.automation_id });
  } else if (node.name) {
    list.push({ type: "accessibility", role: node.role, name: node.name });
  }
  if (node.name) {
    list.push({
      type: "ocr_text",
      text: node.name,
      match: "contains",
      min_confidence: 0.8,
    });
  }
  list.push({ type: "bbox_norm", value: node.bbox_norm });
  return list;
}

function sanitizeId(s: string): string {
  return s
    .replace(/[^a-zA-Z0-9_.\-]/g, "_")
    .replace(/^_+/, "")
    .slice(0, 64) || "ctrl";
}

function inferActionTypes(role: string): Control["action_types"] {
  if (/(textbox|edit|combo)/.test(role)) return ["type", "click"];
  if (/(menu_?item|menuitem|tab|link|list_?item|listitem)/.test(role)) return ["click"];
  return ["click"];
}

function simplifyRole(role: string): string {
  if (/text|edit/.test(role)) return "textbox";
  if (/button/.test(role)) return "button";
  if (/combo/.test(role)) return "combobox";
  if (/menu/.test(role)) return "menu_item";
  if (/tab/.test(role)) return "tab";
  if (/link/.test(role)) return "link";
  return role || "control";
}

function inferRisk(label: string): Control["risk_level"] {
  const danger = /(删除|清空|删除全部|发送|提交|支付|付款|授权|批准|授予|关闭|清除|delete|send|pay|approve|grant|remove)/i;
  if (danger.test(label)) return "requires_confirmation";
  return "safe";
}
