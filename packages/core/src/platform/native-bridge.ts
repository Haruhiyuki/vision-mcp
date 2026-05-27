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

  constructor(private readonly opts: NativeBridgeOptions) {
    super();
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
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error(`native helper exited code=${code} signal=${signal}`));
      }
      this.pending.clear();
      this.emit("exit", { code, signal });
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
    if (this.opts.debug) process.stderr.write(`[native →] ${msg}`);
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
      if (this.opts.debug) process.stderr.write(`[native ←] ${line}\n`);
      try {
        const msg = JSON.parse(line);
        if (msg.id && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id)!;
          clearTimeout(p.timer);
          this.pending.delete(msg.id);
          if (msg.error) p.reject(new Error(msg.error));
          else p.resolve(msg.result);
        } else if (msg.event) {
          this.emit(msg.event, msg.data);
        }
      } catch (err) {
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
  // Windows 优先 .exe（ps2exe 编译产物，启动 ~10ms），缺失时 fallback .ps1（启动 ~400ms）。
  // macOS 只看编译产物 vision-mcp-helper。
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
  for (const root of roots) {
    for (const name of candidateNames) {
      const c = path.join(root, name);
      try {
        const stat = await fs.stat(c);
        if (stat.isFile()) return c;
      } catch {}
    }
  }
  return null;
}
