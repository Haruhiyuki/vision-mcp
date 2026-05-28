// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Vision-MCP Authors
import type {
  ActionType,
  Control,
  RiskLevel,
  State,
  VisionMap,
} from "../schema/index.js";
import type { Capsule } from "../capsule/manager.js";
import type { Patch } from "../schema/patch.js";
import type {
  LocatorMatch,
  LocatorProviders,
  StateMatch,
} from "../locator/types.js";
import type { FileTraceStore, ApprovalResolver, TraceEventBase } from "../trace/index.js";

export interface RuntimeOptions {
  map: VisionMap;
  mapBaseDir: string;
  capsule: Capsule;
  providers: LocatorProviders;
  trace?: FileTraceStore;
  approval?: ApprovalResolver;
  sessionId?: string;
  /** 当 runtime 自动写入修复 patch 时回调。 */
  onPatch?: (patch: Patch) => Promise<void> | void;
  /** 允许调用方修改 perform_action 之前的 params。 */
  onBeforeAction?: (ctx: ActionContext) => Promise<ActionContext> | ActionContext;
}

export interface ActionParams {
  text?: string;
  combo?: string;
  /** 滚动距离（像素），正为向下。 */
  dy_px?: number;
  dx_px?: number;
  /** drag 目标点（归一化）。 */
  to_norm?: [number, number];
  /** wait 动作的毫秒数。 */
  wait_ms?: number;
  /** 强制使用某个 locator type（调试用）。 */
  force_locator?: string;
  /** 覆盖默认 click 选项。 */
  modifiers?: ReadonlyArray<"ctrl" | "shift" | "alt" | "meta">;
  click_count?: number;
  /** type 动作时是否先 Cmd+A → Delete 清空当前输入。 */
  clear_first?: boolean;
  /** type 动作的逐字延迟（毫秒）；0 或未设走粘贴。 */
  per_char_delay_ms?: number;
}

export interface ActionContext {
  action_id: string;
  state: State;
  control: Control;
  actionType: ActionType;
  params: ActionParams;
  risk_level: RiskLevel;
  approval_required: boolean;
}

/**
 * 动作执行后给 agent 的原始信号——让 agent 不被 runtime 黑盒判定。
 *
 * 设计哲学：postcondition 评估是机械的二元 pass/fail；signals 是 raw 数据让
 * agent 自己复核——比如看到 ocr_hits 命中的字其实是错的（"新建备录" 漏了"忘"），
 * agent 可以主动 patch locator 而不是相信 evaluator 的 ok=true。
 *
 * 字段精简（避免 token 爆炸）：只返回 postcondition 评估时关键命中的数据，
 * 不 dump 整个 frame insights。
 */
export interface ActionSignals {
  /** capsule.status 返回的 window title 字面值。最便宜的信号。 */
  window_title?: string;
  /** detect_state 推断结果：状态 id + score + 命中的 anchor 类型列表。 */
  state_after?: {
    state_id: string;
    score: number;
    matched_anchors?: string[];
  };
  /** postcondition 评估时 OCR 命中的关键 token（如 text_should_appear 命中的那行）。 */
  ocr_hits?: Array<{
    text: string;
    confidence: number;
    bbox_norm?: [number, number, number, number];
  }>;
  /** postcondition 评估时 AX 命中的 node（如 control_should_exist 找到的）。 */
  ax_matched?: Array<{
    control_id?: string;
    role?: string;
    name?: string;
  }>;
  /** 动作前后 dHash 差异（0=没变，1=全变）；和 visual_change 同源。 */
  visual_diff?: number;
  /** 动作后的 dHash hex（16 char）。agent 可以下次跟基线比对。 */
  visual_hash_after?: string;
  /** postcondition 评估器返回的 reason 字符串（紧凑结论，agent 直接读）。 */
  postcondition_reasons?: string[];
}

export interface ActionResult {
  action_id: string;
  succeeded: boolean;
  locator: LocatorMatch | null;
  state_before?: StateMatch | null;
  state_after?: StateMatch | null;
  postcondition_ok: boolean;
  repaired: boolean;
  patches: Patch[];
  events: TraceEventBase[];
  message?: string;
  /**
   * P1 内建视觉验证：动作前后 dHash 相似度。
   * - visual_change=1-similarity（0 完全没变；1 完全不同）
   * - low_visual_change=true 时表示"动作执行但 UI 没明显变化"——
   *   这是 vision-mcp 最常见的"幽灵成功"幽默 bug 来源，agent 应警惕。
   */
  visual_change?: number;
  low_visual_change?: boolean;
  /**
   * Raw signals — agent in-the-loop 看的原始数据。
   * 让 agent 自己复核 OCR 命中是不是真对、AX node 名字是否符合预期、
   * window_title 是否真切换、state_score 高不高，
   * 不被 runtime 机械 pass/fail 黑盒。
   */
  signals?: ActionSignals;
}

export interface WorkflowResult {
  workflow_id: string;
  succeeded: boolean;
  steps: Array<{
    action_id: string;
    succeeded: boolean;
    message?: string;
  }>;
}

