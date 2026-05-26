# @vision-mcp/core

Vision-MCP 的核心库：纯 TypeScript，零原生依赖。提供：

- 数据模型与 Zod 校验（schema）
- Vision Map 加载 / patch overlay 合并 / lint
- Capsule Manager + Geometry Contract + Input Lease
- Platform Adapter 抽象（mock / Windows / macOS sidecar）
- Locator（Accessibility / OCR / nearby_text / image_patch / bbox_norm / VLM）
- Runtime Executor + postcondition + audit trace
- Repair Engine（L0–L3）+ patch overlay 生成
- Map Builder + WorkflowRecorder
- 错误码 `VisionMcpError`

## 安装

```bash
npm install @vision-mcp/core
```

## 最小示例

```ts
import {
  Capsule,
  CallbackApprovalResolver,
  MockPlatformAdapter,
  RuntimeExecutor,
  loadMap,
} from "@vision-mcp/core";

const { effective: map, baseDir } = await loadMap("./vision-mcp.yaml");
const adapter = new MockPlatformAdapter();
adapter.addWindow({
  title: "Demo",
  process_name: "demo.exe",
  bounds: { x: 0, y: 0, width: 1280, height: 800 },
});
const capsule = new Capsule(map.visual_box, adapter, map.input_lease_policy);
const display = await capsule.ensureDisplay({
  geometry: map.visual_box.display,
  mode: map.visual_box.mode,
});
await capsule.attach({ target: map.visual_box.target_window! });
await capsule.migrate(display.id);

const rt = new RuntimeExecutor({
  map,
  mapBaseDir: baseDir,
  capsule,
  providers: {},
  approval: new CallbackApprovalResolver(async () => "granted"),
});
const result = await rt.performAction("login.username", { text: "alice" });
console.log(result.succeeded, result.locator?.locator_used);
```

## 公开导出

详见 `src/index.ts`。如需精细引用：

- `@vision-mcp/core/schema`：Zod 类型与 TS 接口
- `@vision-mcp/core/capsule`：Capsule、GeometryContract 工具
- `@vision-mcp/core/platform`：mock / windows / macos / factory
- `@vision-mcp/core/runtime`：RuntimeExecutor、postcondition
- `@vision-mcp/core/repair`：RepairEngine
- `@vision-mcp/core/builder`：MapBuilder、WorkflowRecorder
- `@vision-mcp/core/trace`：FileTraceStore、redact、ApprovalResolver
