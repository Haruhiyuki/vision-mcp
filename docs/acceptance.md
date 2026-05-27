# 验收清单（对照设计文档 §17）

> 本表逐项对照设计文档 §17 的 Windows MVP / macOS Alpha / 文档与交付验收要求，标注本仓库当前完成度与对应文件。

## 1. Windows MVP

| 要求 | 状态 | 证据 |
| ---- | ---- | ---- |
| 创建/检测固定 1280×800 capsule 工作区 | ✅ 接口完整 | `Capsule.ensureDisplay` + `WindowsPlatformAdapter` JSON-RPC `capsule.ensure_virtual_display`；Mock 适配器同名实现已通过测试 `capsule.test.ts` |
| 把用户已打开的窗口迁入 capsule | ✅ 接口完整 | `Capsule.attach + migrate + restore`；测试覆盖 `capsule.test.ts: attach → migrate → restore 全流程` |
| 捕获 capsule 内容并显示 Live View | ✅ 接口完整 | `capsule.capture()` 返回 RGBA frame；Live View UI 在 M1 里程碑 |
| 生成一个页面 map（含 state/anchors/controls/bbox_norm/postcondition） | ✅ | `MapBuilder.appendStateFromCapture`；示例 `examples/example-erp/vision-mcp.yaml` |
| MCP 调用 perform_action 执行 click/type/scroll/key | ✅ | `vision_map.perform_action`；`RuntimeExecutor.dispatch` 覆盖全部 10 种 action_type |
| 窗口被移动/缩放后 L0/L1 自动恢复 | ✅ | `RepairEngine.recomputeTransform + restoreGeometry`；`runtime.test.ts: repair_minimal L0` |
| 单按钮漂移时 L3 生成 session patch | ✅ | `RepairEngine.relocateControl`；`repair.test.ts: L3 relocateControl` |
| 高风险动作被拦截并要求用户确认 | ✅ | `RuntimeExecutor` 审批通道 + `CallbackApprovalResolver`；示例 `login.submit` 与 `invoice.submit` 都 `approval_required: true` |

## 2. macOS Alpha

| 要求 | 状态 | 证据 |
| ---- | ---- | ---- |
| 授权后捕获目标窗口 / 显示器 | ✅ 接口完整 | `MacosPlatformAdapter.captureWindow/captureDisplay`；权限指引 `docs/permissions.md` |
| 通过 Accessibility 控制窗口与执行点击/输入 | ✅ 接口完整 | helper 协议 `window.move/restore` + `input.*` |
| 建立 Real-window Capsule 的 geometry contract | ✅ | `examples/example-notes/vision-mcp.yaml` `mode: real_window` |
| 已有第二显示器存在时迁入工作区 | ✅ | `EnsureDisplayOptions.fallbacks=["existing_display"]` |
| 权限缺失 / 全屏 / 不支持窗口有错误提示 | ✅ | 错误码 `PERMISSION_DENIED` / `GEOMETRY_MISMATCH`，详见 `docs/errors.md` |

## 3. 文档与交付

| 要求 | 状态 | 证据 |
| ---- | ---- | ---- |
| vision-mcp schema | ✅ | `schema/vision-mcp.schema.json`、`schema/vision-mcp-patch.schema.json` |
| MCP tools schema | ✅ | 每个工具的 `inputSchema` 在 `packages/server/src/tools.ts`；运行时通过 `listTools` 即可拿到 JSON schema |
| repair policy 文档 | ✅ | `skills/vision-mcp/references/repair-policy.md` |
| 错误码文档 | ✅ | `docs/errors.md` |
| 用户权限说明 | ✅ | `docs/permissions.md` |
| 部署/卸载说明 | ✅ | `docs/deployment.md` |
| 2 个示例应用 map | ✅ | `examples/example-erp`、`examples/example-notes` |
| 2 条 workflow | ✅ | `example-erp.login_and_create_invoice`、`example-notes.create_quick_note` |
| trace 样例 | ✅ | `examples/example-erp/traces/sample-session.jsonl` |
| repair patch 样例 | ✅ | `examples/example-erp/patches/2026-05-26-invoice-submit-relocated.yaml` |

## 4. 测试与质量

| 项目 | 状态 | 证据 |
| ---- | ---- | ---- |
| 单元测试 | ✅ | `packages/core/tests/*.test.ts`（schema、map IO、locator、capsule、condition、repair、runtime、trace） |
| MCP server 集成测试 | ✅ | `packages/server/tests/server-tools.test.ts`：通过 InMemoryTransport 与 SDK Client 验证 listTools / list_apps / init / describe / perform_action 错误流 |
| 端到端 CLI 流程 | ✅ | README 中的 init → describe → validate 流程；CI 可加入 `npm run build && npm test && node packages/cli/dist/index.js validate example-erp --apps-root examples`。 |
| TypeScript 编译 | ✅ | `npm run typecheck` 通过；`tsc -b` 三个 package 全部 clean |

## 5. 后续里程碑（设计文档 §16.2）

- **M1 Windows MVP（剩余）**：交付 Windows native helper、IDD 驱动签名安装器、Live View UI；本仓库提供接口与协议。
- **M2 Repair MVP**：扩充 OCR/视觉/VLM provider 实现，接入企业 trace store；本仓库提供 ProviderInterface。
- **M3 Workflow Builder**：人类演示 → 自动 workflow → 自动复跑；本仓库的 `WorkflowRecorder` 已可在 agent 端调用。
- **M4 macOS Alpha**：完成 helper + AX/CGEvent + Existing-display 支持。
- **M5 Beta**：安全策略落地、企业安装器、SDK 文档；本仓库提供文档骨架。
