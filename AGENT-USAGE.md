# Vision-MCP — Agent 文档导览

> 历史文件：原 AGENT-USAGE.md 内容已合并进 SKILL + references。

agent 入口 / 唯一权威是 [`skills/vision-mcp/SKILL.md`](skills/vision-mcp/SKILL.md)。安装到 host 后 skill 框架自动加载，本文件 agent 通常**不会**主动看。

| 想看什么 | 去哪里 |
| ---- | ---- |
| **核心原则 + 跨平台速查 + 工具入口** | [`skills/vision-mcp/SKILL.md`](skills/vision-mcp/SKILL.md)（agent 启动 invoke 时自动加载） |
| **任务驱动 vs 探索决策树 + 4 时机 + 反模式** | [`references/workflow.md`](skills/vision-mcp/references/workflow.md) |
| **建 map 13 项 checklist + 何时用 collection/kbd/postcondition/risk_level** | [`references/map-design.md`](skills/vision-mcp/references/map-design.md) |
| **vision-mcp.yaml 字段速查** | [`references/schema.md`](skills/vision-mcp/references/schema.md) |
| **实战示例**（Apple Music / Steam / 纯视觉 / patch 实战） | [`references/examples.md`](skills/vision-mcp/references/examples.md) ⭐ 新 |
| **避坑**（macOS 焦点异步 / 中文输入 / CEF UIA 空壳 / Steam 最小窗口 / etc.） | [`references/pitfalls.md`](skills/vision-mcp/references/pitfalls.md) ⭐ 新 |
| **Windows 适配器** + UIA + MSAA + Windows.Media.Ocr + SwitchToThisWindow | [`references/platform-windows.md`](skills/vision-mcp/references/platform-windows.md) |
| **macOS 适配器** + SCKit + AX-press + Vision OCR | [`references/platform-macos.md`](skills/vision-mcp/references/platform-macos.md) |
| **持续修正（patch）** + Trust 渐进 | [`references/patches.md`](skills/vision-mcp/references/patches.md) |
| **L0-L3 repair ladder** | [`references/repair-policy.md`](skills/vision-mcp/references/repair-policy.md) |
| **safety_policy / 高风险审批 / prompt injection 防护** | [`references/safety.md`](skills/vision-mcp/references/safety.md) |
| 人类视角：英文默认入口 | [`README.md`](README.md) |
| 人类视角：中文项目介绍 + FAQ | [`README.zh-CN.md`](README.zh-CN.md) |
| 人类视角：plugin / npm / 源码安装 + MCP host 配置 | [`INSTALL.md`](INSTALL.md) |
| 设计文档（架构 + 平台决策） | [`vision_mcp_windows_macos_design.md`](vision_mcp_windows_macos_design.md) |
