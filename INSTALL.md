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

> Plugin 自带 `.mcp.json` 让 MCP server 在 plugin enable 后自动注册；自带 `skills/vision-mcp/` 让 agent 自动加载操作手册。一条 `/plugin install` 全装好。

### A.1 从 GitHub 直装

```bash
# Claude Code 内
/plugin install your-org/vision-mcp@main
```

这会从 `github.com/your-org/vision-mcp` 克隆仓库到 `~/.claude/plugins/vision-mcp/`，自动按 `.claude-plugin/plugin.json` 加载 skill + MCP server。

### A.2 从 marketplace（待发布）

```bash
# 待 claude-community marketplace 收录后
/plugin install vision-mcp
```

### A.3 安装后

第一次 enable 时会自动跑 `vision-mcp install-helper` 检查 native helper：
- **macOS**：需要 `swiftc`（Xcode Command Line Tools），自动编译 `native/macos/vision-mcp-helper`。第一次操作时系统会弹 Screen Recording / Accessibility 权限对话框，按引导授权。
- **Windows**：使用 PowerShell helper 或预编译 `.exe`。

验证安装：
```bash
# Claude Code 内
/mcp                            # 应显示 vision-mcp 已 connected
/skill vision-mcp                # 加载 skill
```

---

## B. npm + 手动配置

### B.1 安装

```bash
# 全局安装（提供 vision-mcp / vision-mcp-server 两个 bin）
npm install -g @vision-mcp/cli @vision-mcp/server

# 或单次运行（不安装到全局）
npx -y @vision-mcp/cli serve
```

> ⚠️ 当前仓库**尚未发布**到 npm registry。先用路径 C 源码安装。发布后此节生效。

### B.2 编译 native helper

**macOS**:
```bash
# 装 Xcode Command Line Tools（如未装）
xcode-select --install

# 编译 helper
cd "$(npm root -g)/@vision-mcp/cli/native/macos"
swiftc -O -o vision-mcp-helper src/main.swift \
  -framework AppKit -framework ApplicationServices -framework CoreGraphics \
  -framework IOKit -framework Vision -framework CoreImage \
  -framework ScreenCaptureKit
```

或一键：
```bash
vision-mcp install-helper
```

**Windows**: 使用 `native/windows/src/vision-mcp-helper.ps1`；可选用 `ps2exe` 编译为 `.exe`：
```powershell
Install-Module -Name ps2exe -Scope CurrentUser
Invoke-ps2exe vision-mcp-helper.ps1 vision-mcp-helper.exe
```

### B.3 在各 host 中配置

#### Claude Code（`~/.claude/settings.json` 或项目级 `.mcp.json`）

```json
{
  "mcpServers": {
    "vision-mcp": {
      "command": "npx",
      "args": [
        "-y",
        "@vision-mcp/cli",
        "serve",
        "--apps-root",
        "${HOME}/.vision-mcp/apps"
      ],
      "env": {
        "VISION_MCP_NATIVE_HELPER": "/usr/local/lib/node_modules/@vision-mcp/cli/native/macos/vision-mcp-helper"
      }
    }
  }
}
```

#### Codex CLI（`~/.codex/config.toml` 或项目级）

```toml
[mcp_servers.vision-mcp]
command = "npx"
args = ["-y", "@vision-mcp/cli", "serve", "--apps-root", "/Users/you/.vision-mcp/apps"]

[mcp_servers.vision-mcp.env]
VISION_MCP_NATIVE_HELPER = "/usr/local/lib/node_modules/@vision-mcp/cli/native/macos/vision-mcp-helper"
```

#### Cursor（`~/.cursor/mcp.json`）

同 Claude Code 格式：

```json
{
  "mcpServers": {
    "vision-mcp": {
      "command": "npx",
      "args": ["-y", "@vision-mcp/cli", "serve", "--apps-root", "/Users/you/.vision-mcp/apps"]
    }
  }
}
```

#### OpenClaw / Cline / 其他 stdio MCP host

通用模式：`command: node` + `args: [<path>/index.js, serve]`，或直接 `command: vision-mcp` + `args: [serve]`。详见各 host 的 MCP 配置文档。

### B.4 准备 apps 目录

`--apps-root` 指向放 `vision-mcp.yaml` 的目录。仓库的 `apps/` 提供了示例：
- `apps/apple-music/` — Apple Music
- `apps/notes/` — macOS 备忘录
- `apps/activity-monitor/` — 活动监视器

复制示例到你的 apps-root：

```bash
mkdir -p ~/.vision-mcp/apps
cp -r ./apps/* ~/.vision-mcp/apps/
```

---

## C. 源码克隆

```bash
git clone https://github.com/your-org/vision-mcp ~/vision-mcp
cd ~/vision-mcp
npm install
npm run build
npm test                      # 应显示 43 tests passed

# 编译 macOS helper
cd native/macos
swiftc -O -o vision-mcp-helper src/main.swift \
  -framework AppKit -framework ApplicationServices -framework CoreGraphics \
  -framework IOKit -framework Vision -framework CoreImage -framework ScreenCaptureKit
cd ../..

# 把本地路径配到 host
# 参考 B.3 的配置，把 npx -y @vision-mcp/cli 改成 node /Users/you/vision-mcp/packages/cli/dist/index.js
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

# 列出已建图的 apps
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

- [ ] **npm publish**：`@vision-mcp/core` / `@vision-mcp/server` / `@vision-mcp/cli` 上 npm registry
- [ ] **GitHub Release**：CI 跑 macOS x64/arm64 + Windows x64 预编译 helper，随 release tarball 分发
- [ ] **Claude Code Plugin Marketplace**：提交到 `claude-plugins-community`
- [ ] **smithery.ai / mcp.so / glama.ai**：MCP server registry 同步发布
- [ ] **Homebrew Formula**：`brew install vision-mcp`（macOS 用户最熟悉的安装方式）
