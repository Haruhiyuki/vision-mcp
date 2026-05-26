import { VisionMcpError } from "../errors.js";
import type { PlatformAdapter } from "../capsule/manager.js";
import { MockPlatformAdapter } from "./mock.js";
import { WindowsPlatformAdapter } from "./windows.js";
import { MacosPlatformAdapter } from "./macos.js";
import { DarwinOsascriptAdapter } from "./darwin-osascript.js";

export type PlatformName = "windows" | "macos" | "macos-osascript" | "macos-helper" | "mock" | "auto";

export interface CreatePlatformOptions {
  platform?: PlatformName;
  /** 当 native helper 不可用时是否自动降级到 mock。默认 false。 */
  fallbackToMock?: boolean;
  /** 自定义 helper 路径。 */
  helperPath?: string;
  /** mock 适配器的初始化参数（仅 platform === "mock" 生效）。 */
  mockInit?: ConstructorParameters<typeof MockPlatformAdapter>[0];
}

/**
 * 选择并创建平台适配器。
 *   - "auto"：根据 process.platform 选择 windows/macos；若 helper 不可用且 fallbackToMock=true，
 *     则回退到 mock 并发出 warning。
 *   - "mock"：始终返回 MockPlatformAdapter，用于测试或无 helper 环境。
 */
export async function createPlatformAdapter(
  opts: CreatePlatformOptions = {},
): Promise<PlatformAdapter> {
  const requested = opts.platform ?? "auto";
  const resolved = requested === "auto" ? detectPlatform() : requested;

  if (resolved === "mock") {
    return new MockPlatformAdapter(opts.mockInit);
  }
  try {
    if (resolved === "windows") {
      return await WindowsPlatformAdapter.create({ helperPath: opts.helperPath });
    }
    if (resolved === "macos-helper") {
      return await MacosPlatformAdapter.create({ helperPath: opts.helperPath });
    }
    if (resolved === "macos" || resolved === "macos-osascript") {
      // macOS 默认走 osascript 适配器：无须额外 helper，开箱可用。
      // 若用户显式设置 VISION_MCP_PREFER_HELPER=1 或传入 helperPath，则走 JSON-RPC sidecar。
      const wantsHelper =
        process.env.VISION_MCP_PREFER_HELPER === "1" ||
        (resolved === "macos" && !!opts.helperPath);
      if (wantsHelper) {
        return await MacosPlatformAdapter.create({ helperPath: opts.helperPath });
      }
      return new DarwinOsascriptAdapter();
    }
  } catch (err) {
    if (opts.fallbackToMock) {
      // eslint-disable-next-line no-console
      console.warn(
        `[vision-mcp] 平台 ${resolved} 不可用，降级 mock 适配器：${(err as Error).message}`,
      );
      return new MockPlatformAdapter(opts.mockInit);
    }
    throw err;
  }
  throw new VisionMcpError(
    "UNSUPPORTED_PLATFORM",
    `当前平台 ${process.platform} 不支持（仅 windows / macos / mock）`,
  );
}

function detectPlatform(): "windows" | "macos" | "mock" {
  if (process.platform === "win32") return "windows";
  if (process.platform === "darwin") return "macos";
  return "mock";
}
