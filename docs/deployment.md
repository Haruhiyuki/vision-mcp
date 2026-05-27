# 部署与安装

## 1. 安装方式

| 形态 | 命令 | 说明 |
| ---- | ---- | ---- |
| 直接源码安装 | `npm install && npm run build` | 适用于内部开发与示例。 |
| Node 直执行 server | `node packages/cli/dist/index.js serve` | 通过 stdio 暴露 MCP。 |
| 作为 dep | `npm install @vision-mcp/core @vision-mcp/server` | 在自家 MCP 网关 / Electron 主进程嵌入。 |
| CLI 全局 | `npm link packages/cli` 后 `vision-mcp ...` | 开发者本机安装。 |
| 打包发行 | `npm pack` 三个 package 后用 `npm i ./*.tgz` 安装到目标机器 | 离线交付。 |

> 当前仓库未发布到 npm registry；交付到客户时应配套提供 npm tarball 与 native helper 二进制。

## 2. Native helper

`@vision-mcp/core` 的 `WindowsPlatformAdapter` / `MacosPlatformAdapter` 通过 JSON-RPC over stdio 与外部 sidecar 进程通信。helper 协议固定，由独立子项目维护：

```
helper stdin/stdout：每行一个 JSON 消息
  -> {"id": "...", "method": "capsule.list_displays", "params": {}}
  <- {"id": "...", "result": [...]}
  <- {"event": "user_input", "data": {...}}   // 异步事件
```

支持方法见 `skill/references/platform-windows.md` 与 `skill/references/platform-macos.md`。

### Windows

- 推荐技术栈：Rust + `windows-rs` + IddCx sample。
- 安装位置：`%ProgramFiles%\VisionMCP\vision-mcp-helper.exe`。
- IDD 驱动单独签名 + MSI 安装；helper 在启动时检测驱动是否就绪。
- 启动入口：vision-mcp server 通过 `VISION_MCP_NATIVE_HELPER` 环境变量找到 helper 路径，spawn 一个子进程。

### macOS

- 技术栈：Swift + ScreenCaptureKit + Accessibility + CGEvent + IOKit + Vision + CoreImage。
- 编译命令（v0.4 起）：
  ```bash
  cd native/macos
  swiftc -O -o vision-mcp-helper src/main.swift \
    -framework AppKit -framework ApplicationServices -framework CoreGraphics \
    -framework IOKit -framework Vision -framework CoreImage \
    -framework ScreenCaptureKit
  ```
- 安装位置：`/Applications/VisionMCP.app/Contents/MacOS/vision-mcp-helper`。
- 必须授权 Screen Recording + Accessibility。建议提供 `Open System Settings` 深链：
  `x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture`
  `x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility`
- 不创建系统级虚拟显示器（设计文档 §9.5）。`capsule.migrate` 总是把窗口固定到 display 工作区中心，**完整可见**。
- helper 启动时自动 `NSApplication.shared + .accessory` 初始化（ScreenCaptureKit 必需）。
- macOS 14+ 支持完整 SCKit 抓窗口；macOS 13 及更早自动 fallback `screencapture -R`。

## 3. 部署环境变量

| 变量 | 默认 | 说明 |
| ---- | ---- | ---- |
| `VISION_MCP_APPS_ROOT` | `$CWD/apps` | 寻找 app maps 的根目录。 |
| `VISION_MCP_TRACE_DIR` | `<apps_root>/.traces` | trace JSONL 与 asset 目录。 |
| `VISION_MCP_NATIVE_HELPER` | 自动搜索 | 强制指定 helper 路径。 |
| `VISION_MCP_PLATFORM` | `auto` | `auto` / `windows` / `macos` / `mock`。 |
| `VISION_MCP_FALLBACK_MOCK` | `0` | 设 `1` 时若 native helper 不可用则降级 mock 适配器。 |

## 4. 卸载流程

1. 停止所有调用 MCP server 的 host（Claude / Cursor / Codex）。
2. 删除安装目录下的 helper / driver。
3. Windows：使用对应 MSI 卸载 + 移除驱动（`pnputil /delete-driver`）。
4. macOS：把应用扔进废纸篓即可；权限条目可在“系统设置 → 隐私”中移除。
5. 仓库本身：`npm uninstall @vision-mcp/*` 或删除源码目录。
6. 用户数据：`<apps_root>/.traces` 与 `<apps_root>/<app_id>/patches/`。先确认是否要保留 trace 后再清理。

## 5. 升级策略

- map version 字段表明数据格式版本；当前为 `0.1`。后续不兼容变更会提升 minor，并提供 `vision-mcp migrate` 子命令（占位，已规划在 M5）。
- 升级 native helper：保留 helper 协议向后兼容；server 启动时调用 `helper.version` 比对。
- patch overlay：升级 map baseline 时会自动按 `expires_at` 过滤过期 patch；trusted patch 需要人工 review。
