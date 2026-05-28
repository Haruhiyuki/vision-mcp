// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Vision-MCP Authors
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  ApprovalDecision,
  ApprovalRequest,
  ApprovalResolver,
  TraceEventBase,
  TraceEventKind,
  TraceQuery,
  TraceSession,
} from "./types.js";

/**
 * 简洁的文件型 trace 存储：
 *   <dir>/sessions.jsonl  → 一行一个 session 元信息
 *   <dir>/events.jsonl    → 一行一个事件（按时间顺序追加）
 *   <dir>/assets/         → 截图、patch 图片等资产
 *
 * 设计目标：纯 Node fs，无原生依赖；可方便后续替换为 SQLite 或上传到云端。
 */
export class FileTraceStore {
  constructor(private readonly dir: string) {}

  async ensure(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    await fs.mkdir(path.join(this.dir, "assets"), { recursive: true });
    for (const f of ["sessions.jsonl", "events.jsonl"]) {
      const fp = path.join(this.dir, f);
      try {
        await fs.access(fp);
      } catch {
        await fs.writeFile(fp, "", "utf8");
      }
    }
  }

  async startSession(meta: Omit<TraceSession, "id" | "started_at" | "events_count" | "status">): Promise<TraceSession> {
    await this.ensure();
    const session: TraceSession = {
      id: randomUUID(),
      started_at: new Date().toISOString(),
      events_count: 0,
      status: "running",
      ...meta,
    };
    await this.appendLine("sessions.jsonl", session);
    return session;
  }

  async endSession(
    sessionId: string,
    status: TraceSession["status"],
  ): Promise<void> {
    const sessions = await this.listSessions();
    const idx = sessions.findIndex((s) => s.id === sessionId);
    if (idx < 0) return;
    sessions[idx].ended_at = new Date().toISOString();
    sessions[idx].status = status;
    await this.writeLines("sessions.jsonl", sessions);
  }

  async append(event: Omit<TraceEventBase, "id" | "ts"> & { ts?: string }): Promise<TraceEventBase> {
    await this.ensure();
    const full: TraceEventBase = {
      id: randomUUID(),
      ts: event.ts ?? new Date().toISOString(),
      ...event,
    };
    await this.appendLine("events.jsonl", full);
    return full;
  }

  async listSessions(): Promise<TraceSession[]> {
    return this.readJsonl<TraceSession>("sessions.jsonl");
  }

  async query(query: TraceQuery = {}): Promise<TraceEventBase[]> {
    const all = await this.readJsonl<TraceEventBase>("events.jsonl");
    let result = all;
    if (query.sessionId) {
      result = result.filter((e) => e.session_id === query.sessionId);
    }
    if (query.kinds) {
      const set = new Set(query.kinds);
      result = result.filter((e) => set.has(e.kind as TraceEventKind));
    }
    if (query.since) {
      result = result.filter((e) => e.ts >= query.since!);
    }
    if (query.limit && result.length > query.limit) {
      result = result.slice(-query.limit);
    }
    return result;
  }

  async writeAsset(filename: string, data: Uint8Array | string): Promise<string> {
    await this.ensure();
    const safe = filename.replace(/[^a-zA-Z0-9_.\-]/g, "_");
    const filePath = path.join(this.dir, "assets", `${Date.now()}-${safe}`);
    await fs.writeFile(filePath, data as Buffer);
    return filePath;
  }

  async exportSession(sessionId: string): Promise<{
    session: TraceSession | undefined;
    events: TraceEventBase[];
  }> {
    const sessions = await this.listSessions();
    const events = await this.query({ sessionId });
    return { session: sessions.find((s) => s.id === sessionId), events };
  }

  private async appendLine(file: string, obj: unknown): Promise<void> {
    await fs.appendFile(path.join(this.dir, file), JSON.stringify(obj) + "\n", "utf8");
  }

  private async writeLines(file: string, list: unknown[]): Promise<void> {
    await fs.writeFile(
      path.join(this.dir, file),
      list.map((o) => JSON.stringify(o)).join("\n") + (list.length ? "\n" : ""),
      "utf8",
    );
  }

  private async readJsonl<T>(file: string): Promise<T[]> {
    try {
      const text = await fs.readFile(path.join(this.dir, file), "utf8");
      return text
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as T);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }
}

/**
 * 默认审批解析器：直接拒绝所有高风险动作。生产环境应替换为接入 UI 的实现。
 */
export class DenyAllApprovalResolver implements ApprovalResolver {
  async request(_req: ApprovalRequest): Promise<ApprovalDecision> {
    return "denied";
  }
}

/**
 * 内存审批解析器：按 action_id 查表决定批准或拒绝。
 * 测试与脚本驱动场景使用。
 */
export class ScriptedApprovalResolver implements ApprovalResolver {
  constructor(
    private readonly decisions: Record<string, ApprovalDecision> = {},
  ) {}
  async request(req: ApprovalRequest): Promise<ApprovalDecision> {
    return this.decisions[req.action_id] ?? "denied";
  }
}

/**
 * 通过外部回调实现的审批解析器，例如桥接到 MCP elicitation 或 stdin prompt。
 */
export class CallbackApprovalResolver implements ApprovalResolver {
  constructor(
    private readonly cb: (req: ApprovalRequest) => Promise<ApprovalDecision>,
  ) {}
  request(req: ApprovalRequest): Promise<ApprovalDecision> {
    return this.cb(req);
  }
}
