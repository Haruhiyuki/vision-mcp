// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Vision-MCP Authors
import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CallbackApprovalResolver,
  FileTraceStore,
  ScriptedApprovalResolver,
  redactObject,
  redactString,
} from "@vision-mcp/core";

describe("FileTraceStore", () => {
  it("startSession + append + query 完整流程", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vmcp-trace-"));
    const store = new FileTraceStore(dir);
    await store.ensure();
    const sess = await store.startSession({
      app_id: "demo",
      visual_box_id: "cap",
      mode: "real_window",
    });
    expect(sess.id).toMatch(/[a-z0-9-]+/);
    await store.append({
      session_id: sess.id,
      kind: "action_started",
      message: "click submit",
    });
    await store.append({
      session_id: sess.id,
      kind: "action_succeeded",
      message: "ok",
    });
    await store.endSession(sess.id, "succeeded");
    const events = await store.query({ sessionId: sess.id });
    expect(events.length).toBe(2);
    const sessions = await store.listSessions();
    expect(sessions[0].status).toBe("succeeded");
  });
});

describe("redact", () => {
  it("redactString 替换匹配片段", () => {
    expect(redactString("password=secret", ["secret"])).toContain("***");
  });
  it("redactObject 深度替换", () => {
    const out = redactObject({ password: "abcdef" }, ["abcdef"]);
    expect(JSON.stringify(out)).toContain("***");
  });
});

describe("approval resolvers", () => {
  it("ScriptedApprovalResolver 按 action_id 查表", async () => {
    const r = new ScriptedApprovalResolver({ "x.y": "granted" });
    const decision = await r.request({
      id: "1",
      session_id: "s",
      state_id: "x",
      control_id: "y",
      action_id: "x.y",
      risk_level: "requires_confirmation",
      message: "",
      created_at: "",
      expires_at: "",
    });
    expect(decision).toBe("granted");
  });

  it("CallbackApprovalResolver 直接传递", async () => {
    const r = new CallbackApprovalResolver(async () => "denied");
    expect(
      await r.request({
        id: "1",
        session_id: "s",
        state_id: "x",
        control_id: "y",
        action_id: "x.y",
        risk_level: "safe",
        message: "",
        created_at: "",
        expires_at: "",
      }),
    ).toBe("denied");
  });
});
