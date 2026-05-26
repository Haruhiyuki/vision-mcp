# @vision-mcp/cli

Vision-MCP 的命令行入口：本地开发、调试、validate / build / run / repair / serve。

## 安装

```bash
npm install -g @vision-mcp/cli
# 或在仓库内
npm install
node packages/cli/dist/index.js --help
```

## 常用命令

```bash
# 初始化 map
vision-mcp init demo-erp --name "Demo ERP" --platform windows

# 校验 map（含已应用 patches）
vision-mcp validate demo-erp

# 打印 app 摘要
vision-mcp describe demo-erp

# 在 mock 平台上跑端到端（无 native helper 时）
vision-mcp build demo-erp --platform mock --mock-window

vision-mcp run demo-erp --action login.username --params '{"text":"alice"}'

vision-mcp workflow demo-erp --id login_and_create_invoice \
  --inputs '{"username":"alice","password":"x","customer_name":"ACME","amount":"99"}' \
  --approve-all

# 触发 repair ladder
vision-mcp repair demo-erp --max-level 3

# 打印 trace
vision-mcp trace demo-erp --limit 50

# 启动 MCP server（stdio）
vision-mcp serve --apps-root ./apps --fallback-mock

# 导出 JSON Schema
vision-mcp schema export --out ./schema
```

## 环境变量

- `VISION_MCP_APPS_ROOT`：默认 `./apps`。
- `VISION_MCP_TRACE_DIR`：默认 `<apps_root>/.traces`。
- `VISION_MCP_NATIVE_HELPER`：native helper 路径。
- `VISION_MCP_PLATFORM`：`auto` / `windows` / `macos` / `mock`。
- `VISION_MCP_FALLBACK_MOCK=1`：helper 不可用时降级 mock。
