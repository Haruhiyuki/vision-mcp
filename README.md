# Vision-MCP

> 基于视觉胶囊的自适应 GUI 操作地图。把真实桌面应用吸入稳定视觉胶囊，扫描并编译成可复用的交互地图，再通过 MCP 工具让 agent 安全、低成本、可审计地操作软件。

完整设计：`vision_mcp_windows_macos_design.md`。

## 项目状态

本仓库是 Vision-MCP 设计文档（v0.1）的参考实现。它把核心运行时（数据模型、Capsule Manager、Runtime Executor、Repair Engine、Map Builder）以及 MCP server / CLI 落地为 TypeScript，平台原生能力通过 sidecar JSON-RPC helper 接入（接口与协议已固定，Windows/macOS helper 可独立交付）。

完成度：

| 模块 | 状态 | 说明 |
| ---- | ---- | ---- |
| Schema + Map IO + Patch overlay | ✅ 完整 | 见 `packages/core/src/schema/*`、`map/*`、`schema/vision-mcp.schema.json` |
| Capsule Manager / Geometry Contract / Input Lease | ✅ 完整 | `packages/core/src/capsule/*` |
| Platform Adapter（mock + Windows + macOS JSON-RPC 桥） | ✅ 接口完整 | mock 适配器开箱可用；Windows/macOS helper 协议见 `skill/references/platform-*.md` |
| Locator（Accessibility / OCR / nearby_text / image_patch / bbox_norm / VLM） | ✅ 完整 | `packages/core/src/locator/*`，含 dHash 视觉相似度 |
| Runtime Executor + postcondition + audit trace | ✅ 完整 | `packages/core/src/runtime/*` |
| Repair Engine L0–L3 + patch overlay | ✅ 完整 | `packages/core/src/repair/*` |
| Map Builder + WorkflowRecorder | ✅ 基础完成 | `packages/core/src/builder/*` |
| MCP Server（§13.2 全部工具 + §13.3 资源） | ✅ 完整 | `packages/server/src/*` |
| CLI | ✅ 完整 | `packages/cli/src/cli.ts` 提供 init/validate/build/run/workflow/repair/trace/serve/schema |
| **macOS SCKit window capture** | ✅ 完整 | `capture.window` 用 ScreenCaptureKit 抓窗口（2560×1600 retina） |
| **macOS AX-press**（高级输入） | ✅ 完整 | `input.ax_press` BFS 找窗口元素发 AXPerformAction("AXPress")，对有 AXPress action 的元素零鼠标干预 |
| **CLI 命令族** | ✅ 完整 | `vision-mcp displays / capsule / restore / live-view / ax-press` |
| Skill 文档 / 示例 map / trace 样例 | ✅ 完整 | `skill/`、`examples/`、`apps/activity-monitor/` |
| 测试覆盖（schema, capsule, locator, runtime, repair, trace, workspace, MCP server e2e） | ✅ 43 个 vitest 测试全部通过 | `packages/*/tests/*.test.ts` |

不在交付范围内（设计文档明示 P2 / 长期研究项）：

- Windows IDD（Indirect Display Driver）虚拟显示器（设计文档 §8.4：MVP 不实现）。
- macOS 系统级虚拟显示器（设计文档 §9.5：public API 不支持，MVP 不做）。
- 生产级 OCR / VLM 实现：当前提供接口（`OcrProvider` / `VlmProvider`），生产可注入 Tesseract / PaddleOCR / Apple Vision / OpenAI VLM 等。
- 独立 GUI Live View app（已用 HTTP server + 浏览器实现 MVP）。

## 快速开始

```bash
# 安装依赖、构建
npm install
npm run build

# 创建一个新 app map
node packages/cli/dist/index.js init demo-erp --name "Demo ERP" --platform any

# 看看示例
node packages/cli/dist/index.js describe example-erp --apps-root examples
node packages/cli/dist/index.js validate example-erp --apps-root examples

# 启动 MCP server（stdio）
node packages/cli/dist/index.js serve --apps-root examples

# 跑测试
npm test

# 重新导出 JSON schema 到 ./schema
node packages/cli/dist/index.js schema export
```

## 仓库结构

```
vision-mcp/
├── packages/
│   ├── core/                 # 数据模型 / Capsule / Runtime / Repair / Locator / Trace / Builder
│   ├── server/               # MCP server：tools + resources + stdio transport
│   └── cli/                  # vision-mcp CLI
├── examples/
│   ├── example-erp/          # Windows ERP 示例（含 patch + trace 样例）
│   └── example-notes/        # macOS Real-window Capsule 示例
├── skill/
│   ├── SKILL.md              # agent 操作手册
│   ├── references/           # schema、repair、safety、platform-* 参考
│   └── assets/               # JSON Schema + 审阅模板
├── schema/                   # 自动导出的 JSON Schema
├── docs/                     # 部署、权限、错误码、验收清单
├── tsconfig.base.json / tsconfig.json
├── vitest.config.ts
└── README.md
```

## 包目录说明

- **@vision-mcp/core**：纯 TypeScript，没有原生依赖；可被 Node 服务、Electron、其他 MCP server 复用。
- **@vision-mcp/server**：基于 `@modelcontextprotocol/sdk@1.29`，对外提供 `capsule.*` / `vision_map.*` 工具与 `vision-mcp://` 资源族。
- **@vision-mcp/cli**：本地命令行；同时把 server 封装成可启动的 stdio 进程。

## 接入 MCP 宿主

Claude Desktop / Cursor / 其他 MCP 客户端配置示例：

```json
{
  "mcpServers": {
    "vision-mcp": {
      "command": "node",
      "args": ["/abs/path/to/vision-mcp/packages/cli/dist/index.js", "serve", "--apps-root", "/abs/path/to/maps"],
      "env": {
        "VISION_MCP_NATIVE_HELPER": "/abs/path/to/vision-mcp-helper",
        "VISION_MCP_PLATFORM": "auto"
      }
    }
  }
}
```

若不便集成 native helper（例如做 demo / e2e 测试），设置 `VISION_MCP_FALLBACK_MOCK=1` 或加 `--fallback-mock`：runtime 会降级到 mock 平台适配器并清晰标记，不会破坏 map 数据。

## 文档导览

- `AGENT-USAGE.md`：**agent 工具速查表 + Apple Music 实战示例 + macOS workspace 模式（v0.4）**。
- `docs/deployment.md`：跨平台安装与 native helper 部署。
- `docs/permissions.md`：Windows / macOS 权限清单与卸载流程。
- `docs/errors.md`：错误码、recoverable 标志、默认处理建议。
- `docs/acceptance.md`：对照设计文档 §17 的 MVP / Beta 验收对照表。
- `skill/SKILL.md`：agent 操作手册（注册到 host 后 agent 第一时间应读这一份）。
- `skill/references/platform-macos.md`：**macOS workspace 体系、virtual cursor、AX-press、SCKit 详解**。
- `skill/references/safety.md`：高风险动作、prompt injection 防护、workspace 安全约束。
- `vision_mcp_windows_macos_design.md`：原始设计文档。

## 协议

Apache-2.0（见 `LICENSE`）。
