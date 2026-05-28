// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Vision-MCP Authors
import { ChildProcess, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import path from "node:path";

/**
 * 与平台 native helper（外部 sidecar 进程）通信的 JSON-RPC 桥。
 *
 * 协议：每条消息一行 JSON，包含 {id, method, params} 或 {id, result|error}。
 * helper 由各平台独立编译（Windows: Rust + windows-rs；macOS: Swift + ScreenCaptureKit）。
 * 当 helper 不存在时返回 null 以便适配器降级。
 */
export interface NativeBridgeOptions {
  helperPath?: string;
  /** 启动参数。 */
  args?: string[];
  /** 调用超时毫秒，默认 5000。 */
  defaultTimeoutMs?: number;
  /** 用于调试：把所有进出消息写到 stderr。 */
  debug?: boolean;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(err: Error): void;
  timer: NodeJS.Timeout;
}

export class NativeBridge extends EventEmitter {
  private proc: ChildProcess;
  private buffer = "";
  private pending = new Map<string, PendingRequest>();
  private disposed = false;
  private readonly opts: NativeBridgeOptions;
  /**
   * helper 在 exit 前用 {id:null, error, code} 发出的致命诊断（如 PWSH_INCOMPATIBLE）。
   * onStdout 缓存到这里；exit handler 用作 reject reason，让用户拿到根因而不是
   * 笼统的 "exited code=2 signal=null"。
   */
  private fatalDiagnostic: string | null = null;

  constructor(opts: NativeBridgeOptions) {
    super();
    // 允许全局 env 强开 debug，方便用户排查 helper 通讯问题
    if (process.env.VISION_MCP_NATIVE_DEBUG === "1" && !opts.debug) {
      opts = { ...opts, debug: true };
    }
    this.opts = opts;
    const helperPath = opts.helperPath;
    if (!helperPath) {
      throw new Error("NativeBridge 需要 helperPath");
    }
    // Windows: 如果 helper 是 .ps1 脚本，自动用 Windows PowerShell 5.1 包一层
    //   - powershell.exe（5.1）而非 pwsh.exe（7.x）：UIAutomationClient Add-Type 仅在 5.1 可加载
    //   - -NoProfile：避免用户 profile 改 OutputEncoding / 写日志污染 stdio
    //   - -NonInteractive -ExecutionPolicy Bypass：CI/锁机环境也能跑
    //   - -File：把 .ps1 当 script 跑，stdin/stdout 直通到子进程管道
    const isPs1 = process.platform === "win32" && /\.ps1$/i.test(helperPath);
    const execPath = isPs1 ? "powershell.exe" : helperPath;
    const execArgs = isPs1
      ? ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helperPath, ...(opts.args ?? [])]
      : (opts.args ?? []);
    this.proc = spawn(execPath, execArgs, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, RUST_LOG: process.env.RUST_LOG ?? "info" },
      // Windows .exe 启动用 shell:false（默认）即可；spawn 在 win32 上对 .exe 直接 CreateProcess
      windowsHide: true,
    });
    this.proc.stdout!.setEncoding("utf8");
    this.proc.stderr!.setEncoding("utf8");
    this.proc.stdout!.on("data", (chunk) => this.onStdout(String(chunk)));
    this.proc.stderr!.on("data", (chunk) => {
      if (opts.debug) process.stderr.write(`[native] ${chunk}`);
      this.emit("stderr", String(chunk));
    });
    this.proc.on("exit", (code, signal) => {
      this.disposed = true;
      // 优先 fatal diagnostic（如 PWSH_INCOMPATIBLE），否则用退出码
      const reason = this.fatalDiagnostic
        ? `native helper 启动失败：${this.fatalDiagnostic}`
        : `native helper exited code=${code} signal=${signal}`;
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error(reason));
      }
      this.pending.clear();
      this.emit("exit", { code, signal, fatal: this.fatalDiagnostic });
    });
  }

  static async tryCreate(opts: NativeBridgeOptions): Promise<NativeBridge | null> {
    if (!opts.helperPath) return null;
    try {
      const stat = await fs.stat(opts.helperPath);
      if (!stat.isFile()) return null;
    } catch {
      return null;
    }
    try {
      return new NativeBridge(opts);
    } catch {
      return null;
    }
  }

  async request<T = unknown>(
    method: string,
    params: unknown = {},
    timeoutMs = this.opts.defaultTimeoutMs ?? 5000,
  ): Promise<T> {
    if (this.disposed) throw new Error("native bridge disposed");
    const id = randomUUID();
    const msg = JSON.stringify({ id, method, params }) + "\n";
    if (this.opts.debug) process.stderr.write(`${new Date().toISOString()} [native →] ${msg}`);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`native ${method} timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
        timer,
      });
      this.proc.stdin!.write(msg);
    });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.proc.stdin?.end();
      this.proc.kill();
    } catch {}
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      if (this.opts.debug) process.stderr.write(`${new Date().toISOString()} [native ←] ${line.slice(0, 200)}\n`);
      try {
        const msg = JSON.parse(line);
        if (this.opts.debug) {
          process.stderr.write(`${new Date().toISOString()} [native parse] id=${msg.id} pending.has=${msg.id ? this.pending.has(msg.id) : "?"}\n`);
        }
        if (msg.id && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id)!;
          clearTimeout(p.timer);
          this.pending.delete(msg.id);
          if (msg.error) p.reject(new Error(msg.error));
          else p.resolve(msg.result);
        } else if (msg.event) {
          this.emit(msg.event, msg.data);
        } else if (msg.error && msg.id === null) {
          // Helper 启动期致命诊断（如 PWSH_INCOMPATIBLE）：没有 id 对应 pending，但
          // 紧接着会 exit。缓存到 fatalDiagnostic，让 exit handler 用作 reject reason，
          // 避免用户只看到 "exited code=2 signal=null"。
          this.fatalDiagnostic = msg.code ? `[${msg.code}] ${msg.error}` : String(msg.error);
        }
      } catch (err) {
        if (this.opts.debug) {
          process.stderr.write(`${new Date().toISOString()} [native parse_error] ${(err as Error).message} line=${line.slice(0, 100)}\n`);
        }
        this.emit("parse_error", { line, err });
      }
    }
  }
}

/**
 * 默认 helper 搜索路径：
 *   1. 环境变量 VISION_MCP_NATIVE_HELPER
 *   2. <project>/native/<platform>/vision-mcp-helper
 *   3. <package>/native/<platform>/vision-mcp-helper
 */
export async function resolveDefaultHelper(
  platform: "windows" | "macos",
  hint?: string,
): Promise<string | null> {
  const env = process.env.VISION_MCP_NATIVE_HELPER;
  if (env) return env;
  if (hint) return hint;
  // Windows 优先 .exe（prebuilt 启动 ~10ms），所有 root 都找不到再 fallback .ps1（~400ms）。
  // macOS 只看编译产物 vision-mcp-helper。
  // 外层 name、内层 root：避免 "dev cwd 的 .ps1 抢在 cli 包的 .exe 之前命中"。
  const candidateNames =
    platform === "windows"
      ? ["vision-mcp-helper.exe", path.join("src", "vision-mcp-helper.ps1")]
      : ["vision-mcp-helper"];
  // packages/cli 也会被打包，npm 安装时 helper 在 cli 包的 native/ 里
  const roots = [
    path.resolve(process.cwd(), "native", platform),
    path.resolve(process.cwd(), "packages/core/native", platform),
    path.resolve(process.cwd(), "packages/cli/native", platform),
  ];
  for (const name of candidateNames) {
    for (const root of roots) {
      const c = path.join(root, name);
      try {
        const stat = await fs.stat(c);
        if (stat.isFile()) return c;
      } catch {}
    }
  }
  return null;
}
