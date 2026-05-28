# 安装与分发

Vision-MCP 同时是一个 **MCP server**（暴露 `capsule.*` / `vision_map.*` tools）和一个 **Claude Skill**（agent 操作手册 + 持续修正方法论）。本文档给出三种分发路径。

## 选择路径

| 你是… | 推荐路径 |
| ----- | -------- |
| Claude Code 用户，想一条命令装上 skill + MCP server + helper | [A. Claude Code Plugin](#a-claude-code-plugin推荐) |
| 用 Codex / Cursor / Cline 等 MCP host | [B. npm + 手动配置](#b-npm--手动配置) |
| 想 hack / 提 PR | [C. 源码克隆](#c-源码克隆) |

---

## A. Claude Code Plugin（推荐）

> Plugin 仓库自带 `.claude-plugin/plugin.json` + `.mcp.json` + `skills/vision-mcp/` + `examples/`。
> MCP server 不在 plugin 仓库里——`.mcp.json` 用 `npx -y @vision-mcp/cli@latest serve` 从 npm registry 拉，
> npm 包的 `postinstall` 又会自动跑 `install-helper` 编 / 检 native helper。一条 `/plugin install` 跑通整链。

### A.1 从 GitHub 直装

```bash
# Claude Code 内
/plugin marketplace add Haruhiyuki/vision-mcp
/plugin install vision-mcp@vision-mcp
```

第一条命令把 `Haruhiyuki/vision-mcp` 仓库当成单 plugin marketplace 注册；
第二条 `vision-mcp@vision-mcp` 的格式是 `<plugin-name>@<marketplace-name>`。
首次安装会 git clone 到 `~/.claude/plugins/vision-mcp/`，自动加载 `.claude-plugin/plugin.json`。

### A.2 从官方 marketplace（待提交）

```bash
# 待提交到 anthropics/claude-plugins-community 后
/plugin install vision-mcp
```

提交入口：[claude.ai/settings/plugins/submit](https://claude.ai/settings/plugins/submit)。

### A.3 安装后

`.mcp.json` 的 `command: npx -y @vision-mcp/cli@latest` 在 plugin enable 时拉 cli 包（首次 ~30s 下载），
npm install 触发 `@vision-mcp/cli` 的 postinstall 自动跑 `install-helper --silent`：
- **macOS**：需要 `swiftc`（Xcode Command Line Tools），自动编译 `native/macos/vision-mcp-helper`。第一次操作时系统会弹 Screen Recording / Accessibility 权限对话框，按引导授权。
- **Windows**：使用 PowerShell helper（自动 wrap `powershell.exe`）。安装期只验证 PowerShell 5.1 是否可用，不需要 ps2exe。

验证安装：
```bash
# Claude Code 内
/mcp                            # 应显示 vision-mcp 已 connected
/skill vision-mcp               # 加载 skill

# 终端
npx -y @vision-mcp/cli doctor   # 一键自检：OS / Node / helper / displays
```

---

## B. npm + 手动配置

### B.1 安装

```bash
# 全局安装（cli 包提供 vision-mcp bin；server 通过 cli 的 dep 自动装）
npm install -g @vision-mcp/cli

# 或单次运行（不安装到全局，每次冷下载 ~30s）
npx -y @vision-mcp/cli@latest serve
```

> ⚠️ 当前仓库**尚未发布**到 npm registry。`@vision-mcp/{core,server,cli}` scope 已抢注但 0.1.0 未 publish。
> 发布前用路径 C 源码安装；发布后本节即可用。

cli 的 `postinstall` 自动跑 `install-helper --silent`：
- **macOS**：检测 `swiftc`（Xcode Command Line Tools）后自动编译 helper。`xcode-select --install` 装好开发工具后再装 cli 一次（或事后跑 `vision-mcp install-helper --force`）。
- **Windows**：检测 Windows PowerShell 5.1（pwsh 7 不行）。helper 走 `.ps1` 由 NativeBridge 自动用 `powershell.exe -File` 包一层，不需要 ps2exe（默认 PS host 拦 `[Console]::In` 不能做 stdio sidecar）。

postinstall 任何失败都不会染红 `npm install`；事后用 `vision-mcp doctor` 看详情。

### B.2 在各 host 中配置

> 不需要设 `VISION_MCP_NATIVE_HELPER`：cli 的 `resolveBundledHelper()` 会自动找
> npm 安装目录的 helper；只在你想覆盖默认时才设。

#### Claude Code（`~/.claude/settings.json` 或项目级 `.mcp.json`）

```json
{
  "mcpServers": {
    "vision-mcp": {
      "command": "npx",
      "args": [
        "-y",
        "@vision-mcp/cli@latest",
        "serve",
        "--apps-root",
        "${HOME}/.vision-mcp/apps"
      ]
    }
  }
}
```

#### Codex CLI（`~/.codex/config.toml` 或项目级）

```toml
[mcp_servers.vision-mcp]
command = "npx"
args = ["-y", "@vision-mcp/cli@latest", "serve", "--apps-root", "/Users/you/.vision-mcp/apps"]
```

#### Cursor（`~/.cursor/mcp.json`）

同 Claude Code 格式：

```json
{
  "mcpServers": {
    "vision-mcp": {
      "command": "npx",
      "args": ["-y", "@vision-mcp/cli@latest", "serve", "--apps-root", "/Users/you/.vision-mcp/apps"]
    }
  }
}
```

#### OpenClaw / Cline / 其他 stdio MCP host

通用模式：`command: npx` + `args: [-y, @vision-mcp/cli@latest, serve]`，或全局装 cli 后直接 `command: vision-mcp` + `args: [serve]`。详见各 host 的 MCP 配置文档。

### B.3 准备 apps 目录

`--apps-root` 指向放 `vision-mcp.yaml` 的目录（用户自己的 map data；仓库 `apps/` 已加进 .gitignore，是用户专属工作区）。仓库 `examples/` 提供了参考 maps：
- `examples/apple-music/` — Apple Music（macOS）
- `examples/notes/` — macOS 备忘录
- `examples/activity-monitor/` — 活动监视器（macOS）
- `examples/example-erp/` — 虚构 Windows ERP demo（架构完整展示）
- `examples/steam-windows/` — Steam Windows 真机实测 demo（6 workflow + 1 destructive 卸载链）

复制示例到你的 apps-root：

```bash
mkdir -p ~/.vision-mcp/apps
cp -r ./examples/* ~/.vision-mcp/apps/
```

---

## C. 源码克隆

```bash
git clone https://github.com/Haruhiyuki/vision-mcp ~/vision-mcp
cd ~/vision-mcp
npm install                   # 触发 cli 的 postinstall 自动跑 install-helper
npm run build
npm test                      # 应显示 53 tests passed

# 把本地路径配到 host
# 参考 B.2 的配置，把 npx -y @vision-mcp/cli@latest 改成
#   node /Users/you/vision-mcp/packages/cli/dist/index.js
```

---

## 权限引导（macOS）

第一次操作真窗口时，macOS 会弹两个授权对话框：

1. **屏幕录制**（Screen Recording）：截图能力必备
2. **辅助功能**（Accessibility）：读写窗口位置、AX 树、CGEvent 注入

授权方式：
- 系统设置 → 隐私 → 屏幕录制 → 勾选 `vision-mcp-helper`（或运行它的终端 / Node）
- 系统设置 → 隐私 → 辅助功能 → 同上

授权后**重启 MCP host**让权限生效。

---

## 验证安装

```bash
# 列出当前显示器（确认 helper 已就绪）
vision-mcp displays

# 列出已建立 vision-mcp 的 apps
ls $VISION_MCP_APPS_ROOT  # 或 --apps-root ./apps

# 单跑一个 workflow
vision-mcp workflow notes --id new_note --approve-all
```

预期输出：`displays` 显示主显示器；`workflow` 在备忘录里创建一条新备忘录。

---

## 升级 / 卸载

### 升级

```bash
# Plugin
/plugin update vision-mcp

# npm
npm update -g @vision-mcp/cli @vision-mcp/server

# 源码
cd ~/vision-mcp && git pull && npm install && npm run build
```

升级 native helper：

```bash
vision-mcp install-helper --force
```

### 卸载

```bash
# Plugin
/plugin uninstall vision-mcp

# npm
npm uninstall -g @vision-mcp/cli @vision-mcp/server

# 清理用户数据（traces / patches）
rm -rf ~/.vision-mcp/apps
```

macOS 系统设置中**手动**取消屏幕录制 / 辅助功能授权。

---

## 故障排查

| 现象 | 原因 | 处理 |
| ---- | ---- | ---- |
| `CAPSULE_PLATFORM_UNAVAILABLE` | helper 未找到 | 检查 `VISION_MCP_NATIVE_HELPER`；运行 `vision-mcp install-helper` |
| `PERMISSION_DENIED` | 缺 Screen Recording / Accessibility | 见上节权限引导，重启 host |
| `npx -y` 卡住 | 网络问题 | 先 `npm install -g` 全局装好；host config 改用 `command: vision-mcp` |
| `CAPSULE_DISPLAY_MISSING` | helper 启动失败 | 终端跑一次 `vision-mcp-helper`，看 stderr 报错 |
| `GEOMETRY_MISMATCH` | 窗口被用户拖移 / 全屏 | 退出全屏；`vision-mcp restore <app>` |

详细错误码见 [`docs/errors.md`](docs/errors.md)。

---

## 分发渠道（持续推进）

- [x] **npm scope 抢注**：`@vision-mcp` scope 已占
- [ ] **npm publish 0.1.0**：`@vision-mcp/{core,server,cli}` 上 npm registry（依赖顺序 core→server→cli）
- [ ] **GitHub Release v0.1.0**：tag + release notes
- [ ] **Claude Code Plugin Marketplace**：提交到 `claude-plugins-community`（[提交入口](https://claude.ai/settings/plugins/submit)）
- [ ] **GitHub Release prebuilt helper artifacts**：CI 跑 macOS x64/arm64 + Windows x64 预编译 helper，随 release 分发供网络受限环境用
- [ ] **smithery.ai / mcp.so / glama.ai**：MCP server registry 同步发布
- [ ] **Homebrew Formula**：`brew install vision-mcp`（macOS 用户最熟悉的安装方式）
