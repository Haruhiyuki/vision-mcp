# 安装

Vision-MCP 由两部分组成：

- **MCP server** — 暴露 `vision_map.*` / `capsule.*` 工具给 agent
- **Claude Skill** — agent 操作手册 + 持续修正方法论

下面两条路径任选其一，5 分钟装好。

| 你用… | 走 |
| ----- | --- |
| Claude Code | [Plugin](#plugin-方式) |
| Codex CLI / Cursor / Cline / OpenClaw / Hermes Agent / 其他 stdio MCP host | [手动配置](#手动配置方式) |

---

## Plugin 方式

在 Claude Code 内执行：

```
/plugin marketplace add Haruhiyuki/vision-mcp
/plugin install vision-mcp@vision-mcp
```

装好后立刻能用——skill 自动加载，MCP server 自动启动，native helper 首次启动时自动编译。

验证：

```
/mcp                              # 应显示 vision-mcp 已 connected
```

---

## 手动配置方式

在你的 MCP host 配置里加一项：

### Claude Code (`~/.claude/settings.json` 或项目 `.mcp.json`)

```json
{
  "mcpServers": {
    "vision-mcp": {
      "command": "npx",
      "args": ["-y", "@vision-mcp/cli@latest", "serve", "--apps-root", "${HOME}/.vision-mcp/apps"]
    }
  }
}
```

### Codex CLI (`~/.codex/config.toml`)

```toml
[mcp_servers.vision-mcp]
command = "npx"
args = ["-y", "@vision-mcp/cli@latest", "serve", "--apps-root", "/Users/you/.vision-mcp/apps"]
```

### Cursor (`~/.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "vision-mcp": {
      "command": "npx",
      "args": ["-y", "@vision-mcp/cli@latest", "serve", "--apps-root", "${HOME}/.vision-mcp/apps"]
    }
  }
}
```

### OpenClaw (`openclaw.json`)

最简方式——用 [McPorter](https://openclawlaunch.com/guides/openclaw-mcporter)：

```bash
npm install -g mcporter
mcporter install vision-mcp --target openclaw
```

或手动编辑 `openclaw.json` 加：

```json
{
  "mcpServers": {
    "vision-mcp": {
      "command": "npx",
      "args": ["-y", "@vision-mcp/cli@latest", "serve", "--apps-root", "${HOME}/.vision-mcp/apps"]
    }
  }
}
```

OpenClaw 是 Node.js 持久化 agent 服务，配置文件在你启动 OpenClaw 时显示的 workspace 目录下。

### Hermes Agent (`~/.hermes/`)

最简方式——交互式添加：

```bash
hermes mcp add
```

按提示选 stdio + 填 `npx -y @vision-mcp/cli@latest serve`。

或手动编辑 Hermes 配置（YAML 格式）：

```yaml
mcp_servers:
  vision-mcp:
    command: "npx"
    args: ["-y", "@vision-mcp/cli@latest", "serve", "--apps-root", "${HOME}/.vision-mcp/apps"]
```

加完后 `/reload-mcp` 在 chat 内刷新。Hermes Agent 是 NousResearch 开源的 MIT 自托管 agent。

### 其他 stdio MCP host

通用模式：`command: npx` + `args: [-y, @vision-mcp/cli@latest, serve]`。或全局装一次：

```bash
npm install -g @vision-mcp/cli
```

之后配置 `command: vision-mcp` + `args: [serve]` 即可。

---

## 验证装好了

```bash
npx -y @vision-mcp/cli@latest doctor
```

会一行行打印 OS / Node / helper / displays 检查结果。全 ✅ 即可用。

试跑一个 workflow：

```bash
# macOS 示例
npx -y @vision-mcp/cli@latest workflow notes --id new_note --approve-all
```

预期：备忘录里新建一条空备忘录。

---

## macOS 权限

第一次操作真窗口时会弹两个授权对话框：

1. **屏幕录制** — 截图能力必备
2. **辅助功能** — 读写窗口位置、AX 树、注入鼠标键盘

授权方式：**系统设置 → 隐私与安全性 → 屏幕录制 / 辅助功能 → 勾选 `vision-mcp-helper`**（首次会出现在列表里）。授权后**重启 MCP host** 让权限生效。

> 如果列表里看不到 `vision-mcp-helper`：先跑一次 `npx -y @vision-mcp/cli@latest displays`，触发 macOS 提示加入列表。

---

## Windows 权限

不需要授权，但有两点：

- 必须用 **Windows PowerShell 5.1**（系统默认自带）。如果 `powershell` 在你的 PATH 里被解析到 pwsh 7，会启动失败——`doctor` 会指出来。
- 操作任务管理器、反作弊游戏等"高完整度"app 时需要把 MCP host 以管理员身份运行。普通桌面 app 不需要。

OCR 默认走系统 `Windows.Media.Ocr`。第一次跑会自动检测语言包；中文支持需要：**设置 → 时间和语言 → 语言 → 中文 → 添加"光学字符识别"功能**。

---

## 升级

```bash
# Plugin
/plugin marketplace update vision-mcp

# npm 全局装的
npm update -g @vision-mcp/cli

# npx 方式：什么都不用做，@latest 总是最新
```

如果升级后 helper 有问题，强制重编：

```bash
npx -y @vision-mcp/cli@latest install-helper --force
```

## 卸载

```bash
# Plugin
/plugin uninstall vision-mcp

# npm
npm uninstall -g @vision-mcp/cli

# 清理你的 map / patches / traces 工作目录
rm -rf ~/.vision-mcp/apps
```

macOS 用户记得**手动**去隐私设置里取消屏幕录制 / 辅助功能授权。

---

## 故障排查

| 现象 | 处理 |
| ---- | ---- |
| `vision-mcp doctor` 任一行 ❌ | 按红字指引操作，搞不定就贴 `doctor` 输出到 issue |
| MCP host 看不到 vision-mcp 工具 | 重启 host；`npx -y @vision-mcp/cli@latest doctor` 自检 |
| `PERMISSION_DENIED`（macOS） | 隐私设置里给 `vision-mcp-helper` 授权后重启 host |
| `CAPSULE_PLATFORM_UNAVAILABLE` | `npx -y @vision-mcp/cli@latest install-helper --force` 重装 |
| `GEOMETRY_MISMATCH` | 目标窗口被你拖移或全屏了——退出全屏，让 vision-mcp 自动迁移 |
| `INPUT_LEASE_DENIED`（Windows） | 目标 app 需要管理员权限；以管理员身份重启 MCP host |
| `npx -y` 卡 30 秒 | 国内网络问题；先 `npm install -g @vision-mcp/cli` 一次装好 |

更多错误码：[`docs/errors.md`](docs/errors.md)。
