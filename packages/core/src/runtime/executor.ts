import { randomUUID } from "node:crypto";
import { VisionMcpError } from "../errors.js";
import type { VisionMap } from "../schema/index.js";
import type { Patch } from "../schema/patch.js";
import { findAction, findWorkflow, parseActionId } from "../map/lookup.js";
import { denormalizePoint, denormalizeBBox } from "../capsule/geometry.js";
import { LocatorResolver } from "../locator/resolver.js";
import type {
  ActionContext,
  ActionParams,
  ActionResult,
  RuntimeOptions,
  WorkflowResult,
} from "./types.js";
import type {
  FrameInsights,
  LocatorMatch,
  StateMatch,
} from "../locator/types.js";
import { evaluateCondition, waitForCondition } from "./postcondition.js";
import {
  CallbackApprovalResolver,
  DenyAllApprovalResolver,
  FileTraceStore,
  redactObject,
  TraceEventBase,
} from "../trace/index.js";
import { RepairEngine } from "../repair/engine.js";
import { encodeRgbaToPng } from "./png.js";

export class RuntimeExecutor {
  private resolver: LocatorResolver;
  private sessionId: string;
  private repair: RepairEngine;
  private recentControls: LocatorMatch[] = [];

  constructor(private readonly opts: RuntimeOptions) {
    this.resolver = new LocatorResolver(opts.providers);
    this.sessionId = opts.sessionId ?? randomUUID();
    this.repair = new RepairEngine({
      map: opts.map,
      capsule: opts.capsule,
      resolver: this.resolver,
      mapBaseDir: opts.mapBaseDir,
      onPatch: opts.onPatch,
    });
  }

  get session_id(): string {
    return this.sessionId;
  }

  async detectState(): Promise<{
    state: StateMatch | null;
    insights: FrameInsights;
  }> {
    const frame = await this.opts.capsule.capture();
    const insights = await this.resolver.analyze(frame);
    const status = await this.opts.capsule.status();
    if (status.attached_window) {
      insights.window_title = status.attached_window.title;
      await this.resolver.setAccessibility(insights, status.attached_window.native_handle);
    }
    const state = this.resolver.detectState(this.opts.map, insights);
    await this.appendTrace({
      kind: "state_detected",
      message: state
        ? `匹配到 state ${state.state_id} (score=${state.score.toFixed(3)})`
        : "未能匹配任何 state",
      detail: redactObject(
        { state_match: state, anchors: state?.matched_anchors },
        this.opts.map.safety_policy.redaction_patterns,
      ),
      state_id: state?.state_id,
    });
    return { state, insights };
  }

  listActions(stateId?: string): string[] {
    const targets = stateId
      ? this.opts.map.states.filter((s) => s.id === stateId)
      : this.opts.map.states;
    const out: string[] = [];
    for (const s of targets) {
      for (const c of s.controls) {
        out.push(`${s.id}.${c.id}`);
        for (const a of c.action_types) out.push(`${s.id}.${c.id}:${a}`);
      }
    }
    return [...new Set(out)];
  }

  async performAction(
    actionId: string,
    params: ActionParams = {},
  ): Promise<ActionResult> {
    const resolved = findAction(this.opts.map, actionId);
    const { state, control, effectiveControl, actionType } = resolved;
    // 用 effectiveControl 给 runtime —— 对 collection 而言是动态算出的 cell。
    let ctx: ActionContext = {
      action_id: actionId,
      state: state ?? this.opts.map.states[0],
      control: effectiveControl,
      actionType: actionType as ActionContext["actionType"],
      params,
      risk_level: effectiveControl.risk_level,
      approval_required:
        effectiveControl.approval_required ||
        this.opts.map.safety_policy.require_approval_for_risk_levels.includes(
          effectiveControl.risk_level as "requires_confirmation" | "destructive",
        ),
    };
    if (this.opts.onBeforeAction) {
      ctx = await this.opts.onBeforeAction(ctx);
    }

    const events: TraceEventBase[] = [];

    // 1. 几何契约校验
    let geom = await this.opts.capsule.validateGeometry();
    if (
      !geom.ok &&
      geom.violations.length > 0 &&
      geom.violations.every((v) => v.includes("前台") || v.toLowerCase().includes("foreground"))
    ) {
      // 仅 foreground 不达标：自动 raise 再校验一次（不写 patch，无副作用）
      events.push(
        await this.appendTrace({
          kind: "warning",
          message: "窗口不在前台，自动 raise 后重试",
          detail: { violations: geom.violations },
        }),
      );
      await this.opts.capsule.raise().catch(() => {});
      geom = await this.opts.capsule.validateGeometry();
    }
    if (!geom.ok) {
      events.push(
        await this.appendTrace({
          kind: "warning",
          message: "几何契约失败，尝试 repair L0/L1",
          detail: { violations: geom.violations },
          geometry: { ok: geom.ok, violations: geom.violations },
        }),
      );
      const repairOutcome = await this.repair.attempt({ level: 1, geometry: geom });
      events.push(
        await this.appendTrace({
          kind: repairOutcome.succeeded ? "repair_succeeded" : "repair_attempted",
          message: repairOutcome.message,
          detail: { level: repairOutcome.level },
        }),
      );
      if (!repairOutcome.succeeded) {
        throw new VisionMcpError("GEOMETRY_MISMATCH", repairOutcome.message, {
          details: { violations: geom.violations },
          recoverable: true,
        });
      }
    }

    // 2. 高风险动作必须取得批准
    if (ctx.approval_required) {
      const resolver = this.opts.approval ?? new DenyAllApprovalResolver();
      const decision = await resolver.request({
        id: randomUUID(),
        session_id: this.sessionId,
        state_id: ctx.state.id,
        control_id: ctx.control.id,
        action_id: ctx.action_id,
        risk_level: ctx.risk_level,
        message: `请求执行 ${actionId}（${ctx.control.label ?? ctx.control.id}，风险 ${ctx.risk_level}）`,
        context: redactObject(
          { params },
          this.opts.map.safety_policy.redaction_patterns,
        ),
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      });
      events.push(
        await this.appendTrace({
          kind: decision === "granted" ? "approval_granted" : "approval_denied",
          message: `审批结果：${decision}`,
          action_id: actionId,
          state_id: ctx.state.id,
          control_id: ctx.control.id,
        }),
      );
      if (decision !== "granted") {
        return {
          action_id: actionId,
          succeeded: false,
          locator: null,
          postcondition_ok: false,
          repaired: false,
          patches: [],
          events,
          message: `动作 ${actionId} 未获得审批（${decision}）`,
        };
      }
    }

    // 3. 当前 state 检测 + precondition
    const { state: detected, insights } = await this.detectState();
    if (control.precondition) {
      const pre = await evaluateCondition(control.precondition, {
        map: this.opts.map,
        state_match: detected,
        insights,
        window_title: (await this.opts.capsule.status()).attached_window?.title,
        recent_controls: this.recentControls,
      });
      if (!pre.ok) {
        events.push(
          await this.appendTrace({
            kind: "warning",
            message: `precondition 失败：${pre.reasons.join(" | ")}`,
            action_id: actionId,
          }),
        );
        throw new VisionMcpError(
          "PRECONDITION_FAILED",
          `precondition 失败：${pre.reasons.join(" | ")}`,
          { recoverable: false },
        );
      }
    }

    // 4. 取得 input lease
    const lease = await this.opts.capsule.acquireLease();
    events.push(
      await this.appendTrace({
        kind: "lease_acquired",
        message: `lease=${lease.id} expires=${lease.expires_at}`,
      }),
    );

    let match: LocatorMatch | null = null;
    let succeeded = false;
    const patches: Patch[] = [];
    let postOk = false;
    let stateAfter: StateMatch | null = null;
    let message: string | undefined;

    try {
      events.push(
        await this.appendTrace({
          kind: "action_started",
          message: `执行 ${actionId}（${actionType}）`,
          action_id: actionId,
          state_id: ctx.state.id,
          control_id: ctx.control.id,
        }),
      );

      // 5. locator 解析（仅在需要屏幕坐标的动作上执行）
      const needsLocator = !["key", "wait", "noop"].includes(ctx.actionType);
      if (needsLocator) {
        try {
          match = await this.resolver.resolveControl(
            this.opts.map,
            ctx.state,
            ctx.control,
            insights,
            this.opts.mapBaseDir,
          );
        } catch (err) {
          // 尝试 L3 relocation
          const relocated = await this.repair.relocateControl({
            state: ctx.state,
            control: ctx.control,
            insights,
          });
          if (relocated.match) {
            match = relocated.match;
            if (relocated.patch) {
              patches.push(relocated.patch);
              events.push(
                await this.appendTrace({
                  kind: "repair_succeeded",
                  message: `L3 relocation：${relocated.message}`,
                  detail: { patch: relocated.patch },
                }),
              );
            }
          } else {
            throw err;
          }
        }
        if (match) this.recentControls.push(match);
      }

      // 6. 执行动作
      // 6a. before-screenshot 写 trace asset
      let beforeAssetPath: string | undefined;
      if (this.opts.trace) {
        beforeAssetPath = await this.saveActionScreenshot("before", actionId);
      }
      await this.dispatch(ctx, match);
      // 动作完成后失效 AX 缓存：postcondition 必须看到新页面
      if (this.opts.providers.accessibility?.invalidate) {
        this.opts.providers.accessibility.invalidate();
      }
      // 6b. after-screenshot
      let afterAssetPath: string | undefined;
      if (this.opts.trace) {
        // 给 UI 一点时间响应
        await new Promise((r) => setTimeout(r, 250));
        afterAssetPath = await this.saveActionScreenshot("after", actionId);
      }

      // 7. 等待 postcondition
      if (ctx.control.postcondition) {
        const result = await waitForCondition(
          ctx.control.postcondition,
          async () => {
            const frame = await this.opts.capsule.capture();
            const ins = await this.resolver.analyze(frame);
            const st = await this.opts.capsule.status();
            if (st.attached_window) {
              ins.window_title = st.attached_window.title;
              // 关键：wait 的 refresh 必须重填 AX，否则 AX-based anchor 永远不命中
              await this.resolver.setAccessibility(ins, st.attached_window.native_handle);
            }
            const detected2 = this.resolver.detectState(this.opts.map, ins);
            stateAfter = detected2;
            return {
              map: this.opts.map,
              state_match: detected2,
              insights: ins,
              window_title: st.attached_window?.title,
              recent_controls: this.recentControls,
            };
          },
        );
        postOk = result.ok;
        if (!postOk) {
          events.push(
            await this.appendTrace({
              kind: "postcondition_failed",
              message: `postcondition 失败：${result.reasons.join(" | ")}`,
              action_id: actionId,
            }),
          );
          throw new VisionMcpError(
            "POSTCONDITION_FAILED",
            `postcondition 失败：${result.reasons.join(" | ")}`,
            { details: { reasons: result.reasons }, recoverable: true },
          );
        }
      } else {
        postOk = true;
        const post = await this.detectState();
        stateAfter = post.state;
      }

      succeeded = true;
      events.push(
        await this.appendTrace({
          kind: "action_succeeded",
          message: `${actionId} 成功`,
          action_id: actionId,
          state_id: stateAfter?.state_id,
          bbox_norm: match?.bbox_norm,
          asset_refs: [beforeAssetPath, afterAssetPath].filter(Boolean) as string[],
        }),
      );
    } catch (err) {
      message = (err as Error).message ?? String(err);
      events.push(
        await this.appendTrace({
          kind: "action_failed",
          message: `${actionId} 失败：${message}`,
          detail: { error: serialize(err) },
          action_id: actionId,
        }),
      );
      if (!(err instanceof VisionMcpError)) {
        throw err;
      }
      // VisionMcpError 已经记录，向调用方返回结果对象以便决策
    } finally {
      await lease.release();
    }

    return {
      action_id: actionId,
      succeeded,
      locator: match,
      state_before: detected ?? null,
      state_after: stateAfter,
      postcondition_ok: postOk,
      repaired: patches.length > 0,
      patches,
      events,
      message,
    };
  }

  async runWorkflow(
    workflowId: string,
    inputs: Record<string, unknown> = {},
  ): Promise<WorkflowResult> {
    const wf = findWorkflow(this.opts.map, workflowId);
    if (!wf) {
      throw new VisionMcpError(
        "ACTION_NOT_FOUND",
        `workflow ${workflowId} 不存在`,
      );
    }
    const result: WorkflowResult = {
      workflow_id: workflowId,
      succeeded: true,
      steps: [],
    };
    for (let i = 0; i < wf.steps.length; i++) {
      const step = wf.steps[i];
      const params = resolveParams(step.params ?? {}, inputs);
      let lastErr: unknown;
      let stepResult: ActionResult | null = null;
      const attempts = step.retry?.max_attempts ?? 1;
      for (let attempt = 0; attempt < attempts; attempt++) {
        try {
          stepResult = await this.performAction(step.action_id, params);
          if (stepResult.succeeded) break;
          lastErr = new Error(stepResult.message ?? "action failed");
        } catch (err) {
          lastErr = err;
        }
        if (attempt < attempts - 1 && step.retry?.delay_ms) {
          await new Promise((res) => setTimeout(res, step.retry!.delay_ms));
        }
      }
      const ok = stepResult?.succeeded ?? false;
      result.steps.push({
        action_id: step.action_id,
        succeeded: ok,
        message: ok ? undefined : String(lastErr),
      });
      if (!ok) {
        if (step.on_failure === "abort" || !step.on_failure) {
          result.succeeded = false;
          break;
        }
        if (step.on_failure === "skip") continue;
        if (step.on_failure === "ask_user" || step.on_failure === "repair") {
          // 调用方应观察 trace 并自行决策；此处停止 workflow。
          result.succeeded = false;
          break;
        }
      }
    }
    return result;
  }

  private async dispatch(ctx: ActionContext, match: LocatorMatch | null): Promise<void> {
    const adapter = this.opts.capsule.adapter;
    // 为 type/key 等键盘输入主动 raise 一次：lease 验证到这里可能已隔了几秒，
    // 在 macOS 上焦点会被其他 osascript 调用临时打断。
    if (["type", "key"].includes(ctx.actionType)) {
      await this.opts.capsule.raise().catch(() => {});
    }
    const geom = await this.opts.capsule.validateGeometry();
    const clientRect = geom.client_rect_px;
    // 对 key/wait/noop 而言不需要 match；坐标用窗口中心兜底
    const fallbackCenter: [number, number] = [0.5, 0.5];
    const center = denormalizePoint(match?.center_norm ?? fallbackCenter, clientRect);
    const targetRect = match
      ? denormalizeBBox(match.bbox_norm, clientRect)
      : { x: center.x, y: center.y, width: 1, height: 1 };
    switch (ctx.actionType) {
      case "click":
        return adapter.click(center, {
          modifiers: ctx.params.modifiers,
          click_count: ctx.params.click_count,
        });
      case "double_click":
        return adapter.click(center, { click_count: 2 });
      case "right_click":
        return adapter.click(center, { button: "right" });
      case "hover":
        // adapter 没有 hover；近似实现：用 0 步 drag 移动鼠标
        return adapter.drag(center, { to_point_px: center, steps: 1 });
      case "type":
        await adapter.click(center);
        await new Promise((r) => setTimeout(r, 120));
        return adapter.typeText({
          text: String(ctx.params.text ?? ""),
          per_char_delay_ms: ctx.params.per_char_delay_ms ?? 0,
          clear_first: ctx.params.clear_first ?? false,
        });
      case "key":
        return adapter.pressKey({ combo: String(ctx.params.combo ?? "") });
      case "scroll":
        return adapter.scroll(center, {
          dy_px: ctx.params.dy_px ?? 0,
          dx_px: ctx.params.dx_px ?? 0,
        });
      case "drag": {
        const to = ctx.params.to_norm
          ? denormalizePoint(ctx.params.to_norm, clientRect)
          : { x: targetRect.x + targetRect.width, y: targetRect.y };
        return adapter.drag(center, { to_point_px: to });
      }
      case "drop":
        return; // drop 由 drag 的尾段实现
      case "wait":
        return new Promise((res) =>
          setTimeout(res, Number(ctx.params.wait_ms ?? 500)),
        );
      case "noop":
        return;
    }
  }

  /**
   * 截一帧并以 PNG 写入 trace asset 目录，返回相对路径。
   * 用 frame 自带 RGBA 转 PNG（避免再 fork screencapture）。
   */
  private async saveActionScreenshot(stage: "before" | "after", actionId: string): Promise<string | undefined> {
    if (!this.opts.trace) return undefined;
    try {
      const frame = await this.opts.capsule.capture();
      const png = encodeRgbaToPng(frame.width_px, frame.height_px, frame.pixels);
      const safeAction = actionId.replace(/[^a-zA-Z0-9_.\-]/g, "_");
      const filename = `${this.sessionId}-${stage}-${safeAction}.png`;
      return await this.opts.trace.writeAsset(filename, png);
    } catch {
      return undefined;
    }
  }

  async repairAttempt(level = 3): Promise<{ ok: boolean; message: string; patches: Patch[] }> {
    const geom = await this.opts.capsule.validateGeometry();
    const result = await this.repair.attempt({ level, geometry: geom });
    return {
      ok: result.succeeded,
      message: result.message,
      patches: result.patches,
    };
  }

  private async appendTrace(
    event: Omit<TraceEventBase, "id" | "ts" | "session_id">,
  ): Promise<TraceEventBase> {
    if (!this.opts.trace) {
      return {
        id: randomUUID(),
        ts: new Date().toISOString(),
        session_id: this.sessionId,
        ...event,
      };
    }
    return this.opts.trace.append({ ...event, session_id: this.sessionId });
  }
}

function resolveParams(
  params: Record<string, unknown>,
  inputs: Record<string, unknown>,
): ActionParams {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (typeof v === "string") {
      out[k] = interpolate(v, inputs);
    } else {
      out[k] = v;
    }
  }
  return out as ActionParams;
}

function interpolate(template: string, inputs: Record<string, unknown>): string {
  return template.replace(/{{\s*(\w+)\s*}}/g, (_, key: string) => {
    const v = inputs[key];
    return v === undefined ? "" : String(v);
  });
}

function serialize(err: unknown): unknown {
  if (err instanceof VisionMcpError) return err.toJSON();
  if (err instanceof Error) return { name: err.name, message: err.message, stack: err.stack };
  return err;
}

// 让 createCallbackApprovalResolver 在外部 re-export
export { CallbackApprovalResolver, FileTraceStore };
