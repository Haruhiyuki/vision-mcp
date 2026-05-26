import { randomUUID } from "node:crypto";
import { VisionMcpError } from "../errors.js";
import type {
  Control,
  State,
  VisionMap,
} from "../schema/index.js";
import type {
  ControlBBoxPatch,
  GeometryProfilePatch,
  Patch,
} from "../schema/patch.js";
import type {
  Capsule,
} from "../capsule/manager.js";
import type {
  FrameInsights,
  LocatorMatch,
} from "../locator/types.js";
import { LocatorResolver } from "../locator/resolver.js";
import { matchText, findNearby } from "../locator/text.js";

export interface RepairEngineOptions {
  map: VisionMap;
  capsule: Capsule;
  resolver: LocatorResolver;
  mapBaseDir: string;
  onPatch?: (patch: Patch) => Promise<void> | void;
}

export interface RepairAttemptOptions {
  level: number;
  geometry?: import("../capsule/types.js").GeometryState;
}

export interface RepairOutcome {
  succeeded: boolean;
  level: number;
  message: string;
  patches: Patch[];
}

export interface RelocateInput {
  state: State;
  control: Control;
  insights: FrameInsights;
}

export interface RelocateOutput {
  match: LocatorMatch | null;
  patch?: Patch;
  message: string;
}

/**
 * Repair Engine 按 §12 描述的阶梯实现 L0-L3 自动修复：
 *   - L0 Recompute Transform：geometry contract 满足但内部坐标缓存过期 → 重算 client rect。
 *   - L1 Restore Geometry：窗口移动/缩放/最小化 → 重新 migrate。
 *   - L2 Update Geometry Profile：尺寸轻微变化但 anchor 在 → 写入 geometry profile patch。
 *   - L3 Relocate Control：单控件漂移 → 通过 nearby_text / image_patch / VLM 重定位并写 patch。
 * L4-L6 不在自动范围内，会返回 succeeded=false 并提示由 agent/用户决策。
 */
export class RepairEngine {
  constructor(private readonly opts: RepairEngineOptions) {}

  async attempt(opts: RepairAttemptOptions): Promise<RepairOutcome> {
    const policy = this.opts.map.repair_policy;
    const cap = Math.min(opts.level, policy.max_auto_repair_level);
    let outcome: RepairOutcome = {
      succeeded: false,
      level: cap,
      message: "no repair attempted",
      patches: [],
    };
    for (let level = 0; level <= cap; level++) {
      try {
        const r = await this.runLevel(level, opts);
        if (r.succeeded) return r;
        outcome = r;
      } catch (err) {
        outcome = {
          succeeded: false,
          level,
          message: (err as Error).message ?? String(err),
          patches: outcome.patches,
        };
      }
    }
    return outcome;
  }

  async relocateControl(input: RelocateInput): Promise<RelocateOutput> {
    const policy = this.opts.map.repair_policy.control_relocation;
    const ctrl = input.control;

    // 1. 优先用 nearby_text + label
    if (ctrl.label) {
      const r = matchText(input.insights.ocr, {
        text: ctrl.label,
        match: "contains",
        min_confidence: 0.7,
      });
      if (r) {
        const center: [number, number] = [
          r.bbox_norm[0] + r.bbox_norm[2] / 2,
          r.bbox_norm[1] + r.bbox_norm[3] / 2,
        ];
        const oldBBox = ctrl.visual?.bbox_norm;
        const shift = oldBBox ? bboxShift(oldBBox, r.bbox_norm) : 0;
        const confidence = r.confidence * (1 - Math.min(shift, 1) * 0.5);
        if (
          confidence >= policy.confidence_threshold &&
          shift <= policy.max_bbox_shift_norm
        ) {
          const match: LocatorMatch = {
            control_id: ctrl.id,
            bbox_norm: r.bbox_norm,
            center_norm: center,
            confidence,
            locator_used: "ocr_text",
            evidence: `relocate via label "${ctrl.label}"`,
          };
          const patch = await this.persistBBoxPatch({
            stateId: input.state.id,
            controlId: ctrl.id,
            oldBBox,
            newBBox: r.bbox_norm,
            method: `label "${ctrl.label}" via OCR`,
            confidence,
          });
          return {
            match,
            patch,
            message: `relocated ${ctrl.id} → label OCR (conf=${confidence.toFixed(3)})`,
          };
        }
      }
    }

    // 2. 试试 nearby_text locator
    for (const loc of ctrl.locator_priority) {
      if (loc.type === "nearby_text" && ctrl.visual?.bbox_norm) {
        const nearby = findNearby(
          input.insights.ocr,
          ctrl.visual.bbox_norm,
          loc.direction,
          loc.max_distance_norm,
        );
        const hit = nearby.find((t) => t.text.includes(loc.text));
        if (hit && hit.confidence >= policy.confidence_threshold) {
          const center: [number, number] = [
            hit.bbox_norm[0] + hit.bbox_norm[2] / 2,
            hit.bbox_norm[1] + hit.bbox_norm[3] / 2,
          ];
          const patch = await this.persistBBoxPatch({
            stateId: input.state.id,
            controlId: ctrl.id,
            oldBBox: ctrl.visual.bbox_norm,
            newBBox: hit.bbox_norm,
            method: `nearby_text(${loc.direction}, "${loc.text}")`,
            confidence: hit.confidence,
          });
          return {
            match: {
              control_id: ctrl.id,
              bbox_norm: hit.bbox_norm,
              center_norm: center,
              confidence: hit.confidence,
              locator_used: "nearby_text",
              evidence: `nearby relocate "${loc.text}"`,
            },
            patch,
            message: `relocated via nearby_text`,
          };
        }
      }
    }

    return {
      match: null,
      message: "L3 relocation 未找到符合阈值的候选",
    };
  }

  private async runLevel(level: number, opts: RepairAttemptOptions): Promise<RepairOutcome> {
    switch (level) {
      case 0:
        return this.recomputeTransform(opts);
      case 1:
        return this.restoreGeometry(opts);
      case 2:
        return this.updateGeometryProfile(opts);
      case 3:
        // L3 仅在 relocate 控件时生效，attempt 不主动触发
        return {
          succeeded: false,
          level: 3,
          message: "L3 relocate 由 runtime 在控件解析失败时触发",
          patches: [],
        };
      default:
        return {
          succeeded: false,
          level,
          message: `L${level} 不在自动范围（max=${this.opts.map.repair_policy.max_auto_repair_level}）`,
          patches: [],
        };
    }
  }

  private async recomputeTransform(_opts: RepairAttemptOptions): Promise<RepairOutcome> {
    // 直接重新校验一次几何契约——如果是窗口原点变化但 client size 不变，则 transform 已自动更新。
    const after = await this.opts.capsule.validateGeometry();
    if (after.ok) {
      return {
        succeeded: true,
        level: 0,
        message: "重算 transform 后几何契约通过",
        patches: [],
      };
    }
    return {
      succeeded: false,
      level: 0,
      message: `L0 后仍未通过：${after.violations.join("; ")}`,
      patches: [],
    };
  }

  private async restoreGeometry(_opts: RepairAttemptOptions): Promise<RepairOutcome> {
    const status = await this.opts.capsule.status();
    if (!status.display) {
      return {
        succeeded: false,
        level: 1,
        message: "L1: 未绑定 capsule display",
        patches: [],
      };
    }
    try {
      await this.opts.capsule.migrate(status.display.id);
      const after = await this.opts.capsule.validateGeometry();
      if (after.ok) {
        return {
          succeeded: true,
          level: 1,
          message: "L1: 重新迁移窗口至 capsule，几何恢复",
          patches: [],
        };
      }
      return {
        succeeded: false,
        level: 1,
        message: `L1 后仍未通过：${after.violations.join("; ")}`,
        patches: [],
      };
    } catch (err) {
      return {
        succeeded: false,
        level: 1,
        message: `L1 失败：${(err as Error).message}`,
        patches: [],
      };
    }
  }

  private async updateGeometryProfile(opts: RepairAttemptOptions): Promise<RepairOutcome> {
    const geom = opts.geometry ?? (await this.opts.capsule.validateGeometry());
    const policy = this.opts.map.repair_policy.geometry;
    const expected = this.opts.map.visual_box.display;
    const dw = Math.abs(geom.window.client_bounds.width - expected.width_px);
    const dh = Math.abs(geom.window.client_bounds.height - expected.height_px);
    const sizeShift = Math.max(dw, dh);
    if (sizeShift <= policy.tolerate_client_size_delta_px) {
      return {
        succeeded: true,
        level: 2,
        message: "L2: 尺寸变化在允许范围内，无需 profile patch",
        patches: [],
      };
    }
    if (policy.require_same_dpi && !geom.dpi_match) {
      return {
        succeeded: false,
        level: 2,
        message: "L2: DPI 不匹配，禁止自动更新 profile",
        patches: [],
      };
    }
    const patch: GeometryProfilePatch = {
      kind: "geometry_profile",
      id: `geometry-${Date.now()}`,
      trust: "session_only",
      created_at: new Date().toISOString(),
      confidence: 1 - Math.min(sizeShift / Math.max(expected.width_px, 1), 0.5),
      requires_review: true,
      reason: `client size drift ${sizeShift}px`,
      visual_box_id: this.opts.map.visual_box.id,
      display: {
        width_px: geom.window.client_bounds.width,
        height_px: geom.window.client_bounds.height,
        dpi_x: geom.display.dpi_x,
        dpi_y: geom.display.dpi_y,
        scale: geom.display.scale,
      },
    };
    this.opts.capsule.updateContract({
      require_client_size_px: [
        geom.window.client_bounds.width,
        geom.window.client_bounds.height,
      ],
    });
    await this.maybeWritePatch(patch);
    return {
      succeeded: true,
      level: 2,
      message: `L2: 写入 geometry profile patch (${patch.id})`,
      patches: [patch],
    };
  }

  private async persistBBoxPatch(args: {
    stateId: string;
    controlId: string;
    oldBBox?: import("../schema/index.js").BBoxNorm;
    newBBox: import("../schema/index.js").BBoxNorm;
    method: string;
    confidence: number;
  }): Promise<Patch> {
    const patch: ControlBBoxPatch = {
      kind: "control_bbox",
      id: `bbox-${args.stateId}.${args.controlId}-${Date.now()}`,
      trust: "session_only",
      created_at: new Date().toISOString(),
      requires_review: args.confidence < 0.97,
      confidence: args.confidence,
      reason: args.method,
      state_id: args.stateId,
      control_id: args.controlId,
      old_bbox_norm: args.oldBBox,
      new_bbox_norm: args.newBBox,
      method: args.method,
    };
    await this.maybeWritePatch(patch);
    return patch;
  }

  private async maybeWritePatch(patch: Patch): Promise<void> {
    if (!this.opts.onPatch) return;
    try {
      await this.opts.onPatch(patch);
    } catch (err) {
      throw new VisionMcpError(
        "REPAIR_NOT_APPLICABLE",
        `写入 patch 失败：${(err as Error).message}`,
        { cause: err },
      );
    }
  }
}

function bboxShift(
  a: import("../schema/index.js").BBoxNorm,
  b: import("../schema/index.js").BBoxNorm,
): number {
  const ax = a[0] + a[2] / 2;
  const ay = a[1] + a[3] / 2;
  const bx = b[0] + b[2] / 2;
  const by = b[1] + b[3] / 2;
  return Math.hypot(ax - bx, ay - by);
}
