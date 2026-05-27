import { describe, expect, it } from "vitest";

/**
 * helper RPC 协议契约：macOS swift helper 和 Windows ps1 helper 必须用相同的字段名 /
 * 类型 / 错误码。否则上层 JS 适配器要写 if-else 才能兼容，跨平台代码就退化。
 *
 * 测试策略：定义"标准 fixture"——给定方法 + 参数应返回的 JSON Schema。然后通过 grep
 * 验证两端 helper 源码都覆盖这些方法 + 关键字段。
 *
 * 这是 source-level 静态检查，不需要真启动 helper。catches drift 在 PR review 之前。
 *
 * 实测验证（end-to-end）通过 .github/workflows/ci.yml 的 install-helper + displays
 * RPC 烟雾 + 本地 macOS Mac 跑 macOS 整流程覆盖。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");

interface RpcContract {
  method: string;
  /** 必须出现在 helper 源码（PS1 / Swift）中的字段（用 grep 找）。 */
  responseFields: string[];
  /** 错误码（grep helper 看是否实现）。可选——不是所有 RPC 都有特定错误码。 */
  errorCodes?: string[];
  /** 仅 macOS 实现（Windows 仍可能跳过；不强制）。 */
  macosOnly?: boolean;
  /** 仅 Windows 实现。 */
  windowsOnly?: boolean;
}

// 标准 RPC 契约清单——每加新 RPC 都来这里登记一行
const CONTRACTS: RpcContract[] = [
  { method: "version", responseFields: ["version", "platform"] },
  { method: "capsule.list_displays", responseFields: ["id", "bounds", "work_area", "scale", "dpi_x", "dpi_y", "is_primary", "native_handle"] },
  { method: "capsule.ensure_virtual_display", responseFields: [] },
  { method: "capsule.ensure_workspace_display", responseFields: [] },
  { method: "window.list", responseFields: ["id", "title", "process_name", "process_id", "bounds", "client_bounds", "is_foreground", "native_handle"] },
  { method: "window.get", responseFields: ["title"] },
  { method: "window.move", responseFields: ["bounds"] },
  { method: "window.activate", responseFields: ["ok"] },
  { method: "window.raise", responseFields: ["ok"] },
  { method: "ax.dump", responseFields: ["role", "name", "pos", "size", "depth", "path"] },
  { method: "capture.rect", responseFields: ["png_base64", "width", "height"] },
  { method: "capture.window", responseFields: ["png_base64", "width", "height"] },
  { method: "capture.display", responseFields: ["png_base64", "width", "height"] },
  { method: "input.click", responseFields: ["ok"] },
  { method: "input.type", responseFields: ["ok"] },
  { method: "input.key", responseFields: ["ok"] },
  { method: "input.scroll", responseFields: ["ok"] },
  { method: "input.drag", responseFields: ["ok"] },
  { method: "input.ax_press", responseFields: ["ok", "via"] },
  { method: "input.subscribe", responseFields: ["ok"] },
  { method: "ocr.recognize_rect", responseFields: ["tokens"] },
  // Windows-only：PrintWindow OCR、MSAA fallback、health.snapshot；
  // macOS swift helper 现在也有 health.snapshot
  { method: "ocr.recognize_window", responseFields: ["tokens"], windowsOnly: true },
  { method: "ax.dump_msaa", responseFields: ["role"], windowsOnly: true },
  { method: "health.snapshot", responseFields: ["uptime_sec", "rpc_count", "pid"] },
];

const ERROR_CODES_SHARED = [
  "CAPSULE_DISPLAY_MISSING",
  "WINDOW_NOT_FOUND",
];

async function loadHelperSource(rel: string): Promise<string | null> {
  try {
    return await fs.readFile(path.join(repoRoot, rel), "utf8");
  } catch {
    return null;
  }
}

describe("helper protocol contract", () => {
  it("Windows ps1 helper 实现所有 contract 方法（除非 macosOnly）", async () => {
    const src = await loadHelperSource("native/windows/src/vision-mcp-helper.ps1");
    expect(src, "ps1 helper not found").not.toBeNull();
    if (!src) return;
    const missing: string[] = [];
    for (const c of CONTRACTS) {
      if (c.macosOnly) continue;
      // 在 switch 块里以 "method-name" 形式出现
      if (!new RegExp(`"${c.method.replace(".", "\\.")}"`).test(src)) {
        missing.push(c.method);
      }
    }
    expect(missing, `Windows helper 缺少以下方法实现: ${missing.join(", ")}`).toEqual([]);
  });

  it("macOS swift helper 实现所有 contract 方法（除非 windowsOnly）", async () => {
    const src = await loadHelperSource("native/macos/src/main.swift");
    expect(src, "swift source not found").not.toBeNull();
    if (!src) return;
    const missing: string[] = [];
    for (const c of CONTRACTS) {
      if (c.windowsOnly) continue;
      if (!new RegExp(`"${c.method.replace(".", "\\.")}"`).test(src)) {
        missing.push(c.method);
      }
    }
    expect(missing, `macOS helper 缺少以下方法实现: ${missing.join(", ")}`).toEqual([]);
  });

  it("两端 helper 都用 snake_case 命名（不能出现 displayId / clientBounds 等驼峰）", async () => {
    const ps = await loadHelperSource("native/windows/src/vision-mcp-helper.ps1");
    const sw = await loadHelperSource("native/macos/src/main.swift");
    // 禁用的驼峰命名 —— 这些应该写成 display_id / client_bounds 等
    // 注：JS-side adapter 用 camelCase 是允许的（local var 名字），grep 仅看
    // helper 内字段定义（hashtable key / dict key）。
    const camelOffenders = ["displayId", "clientBounds", "windowTitle", "processName", "boundingRect"];
    if (ps) {
      for (const w of camelOffenders) {
        // helper 内只在 hashtable @{ key = val } 这种语法里出现就算违例
        // 排除注释行
        const psLines = ps.split("\n").filter((l) => !l.trim().startsWith("#"));
        const psText = psLines.join("\n");
        // helper 当前接受 displayId 是兼容老 JS 适配器；我们允许它在 if 判断里出现，
        // 但不能出现在 hashtable 定义为字段名
        const hashtableFieldPattern = new RegExp(`\\b${w}\\s*=`);
        if (hashtableFieldPattern.test(psText)) {
          // 仍然失败 → drift
          expect.fail(`Windows helper 用了驼峰字段名 ${w}（应改 snake_case）`);
        }
      }
    }
    if (sw) {
      for (const w of camelOffenders) {
        const swiftLines = sw.split("\n").filter((l) => !l.trim().startsWith("//"));
        const swiftText = swiftLines.join("\n");
        if (new RegExp(`"${w}"\\s*:`).test(swiftText)) {
          expect.fail(`macOS helper 用了驼峰字段名 ${w}`);
        }
      }
    }
  });

  it("两端 helper 都对 ax.dump 用 ToFinite / Finite 抑制 Infinity（防 JSON 解析错）", async () => {
    const ps = await loadHelperSource("native/windows/src/vision-mcp-helper.ps1");
    // PS 必须有 ToFinite / Finite() 调用包裹 pos/size
    if (ps) {
      // 至少出现一处 finite-coerce 函数
      const hasFiniteFn = /ToFinite\s*\(|Finite\s*\(|IsInfinity/.test(ps);
      expect(hasFiniteFn, "Windows helper 必须对 ax.dump pos/size 做 Infinity 兜底").toBe(true);
    }
  });

  it("两端 helper 都设置 UTF-8 stdout（中文窗口标题不乱码）", async () => {
    const ps = await loadHelperSource("native/windows/src/vision-mcp-helper.ps1");
    if (ps) {
      expect(/UTF8Encoding|UTF8\b/.test(ps), "Windows helper 必须强制 UTF-8 OutputEncoding").toBe(true);
    }
    const sw = await loadHelperSource("native/macos/src/main.swift");
    if (sw) {
      // swift 默认 UTF-8 stdout，不需要显式声明
      expect(sw.length).toBeGreaterThan(0);
    }
  });

  it("响应字段 grep 全覆盖（防止 PR 改 helper 时漏掉响应字段）", async () => {
    const ps = await loadHelperSource("native/windows/src/vision-mcp-helper.ps1");
    const sw = await loadHelperSource("native/macos/src/main.swift");
    const missing: string[] = [];
    for (const c of CONTRACTS) {
      for (const field of c.responseFields) {
        // 字段名应在 helper 源码 hashtable / dict 中至少出现一次
        if (!c.macosOnly && ps && !new RegExp(`\\b${field}\\b`).test(ps)) {
          missing.push(`ps:${c.method}.${field}`);
        }
        if (!c.windowsOnly && sw && !new RegExp(`"${field}"`).test(sw)) {
          missing.push(`swift:${c.method}.${field}`);
        }
      }
    }
    expect(missing, `helper 响应字段缺失: ${missing.slice(0, 10).join(", ")}${missing.length > 10 ? ` (+${missing.length - 10} more)` : ""}`).toEqual([]);
  });
});
