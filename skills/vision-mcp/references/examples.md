# 实战示例

3 个跨平台 + 多 UI 类型的端到端调用对照，对应 SKILL §2 的任务驱动 / 探索驱动两种入口。

## 1. macOS 任务驱动 — Apple Music 播张学友

map 已建好（`examples/apple-music/vision-mcp.yaml`）；调一条 workflow 完成完整任务，0-1 次 snapshot：

```bash
vision-mcp workflow apple-music --id search_and_play_top_song \
  --inputs '{"keyword":"张学友"}' --approve-all

# 内部自动完成：
#   sidebar.search → search_bar.input(type "张学友") → key return →
#   music.app.result_card[1]:double_click → 播放
# 全程 ~5 秒，0 次 snapshot
```

工作流结束时给用户报告的 snapshot（4 时机之"任务结束"）：

```bash
vision-mcp snapshot apple-music --out /tmp/final.png
# 把 final.png 附到回报："已开始播放，截图见附件"
```

## 2. macOS 探索驱动 — 首次建 Apple Music map

> **一次性深度投入**。建好后日常用 §1 任务驱动 ~5 秒命中。

```bash
# snapshot 看主页：PNG 落盘（返回 image_path）+ AX 候选
vision-mcp snapshot apple-music --out /tmp/home.png
# Agent 视觉看 home.png + AX：sidebar 有"搜索/主页/新发现/广播"
# AX 候选给精确 bbox：name="搜索" bbox=[0.014, 0.065, 0.141, 0.04]
# 取中心 (0.085, 0.085) → click

vision-mcp click apple-music --norm "0.085,0.085"
vision-mcp snapshot apple-music --out /tmp/v.png       # 探索时每步 snapshot 验证

vision-mcp click apple-music --norm "0.481,0.033"      # AX 给的搜索框中心
vision-mcp type apple-music --text "张学友" --clear-first
vision-mcp key apple-music --combo return
vision-mcp snapshot apple-music --out /tmp/results.png

# AX 给 AXCell desc="偷心" bbox=[0.341, 0.134, 0.131, 0.087] → 中心 (0.407, 0.178)
vision-mcp click apple-music --norm "0.407,0.178" --count 2

# 探索完成 → vision_map.commit_state 写入 + 写 workflow + 切回任务驱动
```

实测时间：探索 ~30 步 / 20 分钟；执行 ~5 秒 / 0 snapshot — 这就是 amortize 的真实收益。

## 3. Windows + CEF 任务驱动 — Steam 库导航

Steam 是 Chromium-based（CEF）—— UIA 树只看到 `Chrome_RenderWidgetHostHWND` 空壳，必走 OCR + bbox 视觉路线。完整 map 见 `examples/steam-windows/vision-mcp.yaml`（504 行：region + collection + multi-state menu/dialog + destructive workflow）。

```powershell
# 切到库
vision-mcp workflow steam --id open_library --approve-all
# → succeeded: true (1 step)

# 多步 sediment 链：切库 + 开 filter
vision-mcp workflow steam --id open_library_filter --approve-all
# → succeeded: true (2 steps)

# 用 OCR click 定位动态文字（workflow.locator 不支持 {{}}，动态文本走 click-text 命令式）
vision-mcp click-text steam --text "Soundpad"
# → ok:true, point:(749,671), 1.8s 跳到 Soundpad 详情页
# Windows 上 click-text 自动走 PrintWindow OCR，屏外 / 后台窗口都能用

# destructive：4 步链 + 每步 approval_required
vision-mcp workflow steam --id uninstall_first_installed_game \
  --inputs '{"game_name":"Portal 2"}' --approve-all
# → library → context_menu → manage_submenu → uninstall_confirm → 卸载完成
```

## 4. Windows 探索驱动 — 建 Steam map

```powershell
# 1. 自检 helper 可用 + OCR 语言装好
vision-mcp doctor
# → ✅ powershell: 5.1 / ✅ ocr.languages: en-US,zh-Hans-CN / ...

# 2. 看现状 + annotated 注释图（#N 候选 + 网格）
vision-mcp annotated steam --out /tmp/anno.png --grid-step 0.1
# Agent 看图：#3 是"库" tab，#8 是"游戏和软件"下拉

# 3. 自动建图（BFS 兜底，agent 后续仍要视觉判断 anchor / control 选择）
vision-mcp discover steam --max-clicks 20 --max-depth 2

# 4. 偏差固化（patch）
vision-mcp patch steam --state top_nav --control store_tab \
  --bbox-norm "0.034,0.054,0.024,0.022" \
  --reason "实测：annotated 后微调"
```

## 5. 纯视觉流程 — AX 不可用时

游戏 / 自绘 UI / CEF/Chromium 不暴露 AX，必须靠视觉 + OCR：

```bash
# 方法 A：纯视觉估坐标
vision-mcp snapshot apple-music --out /tmp/v1.png
# Agent 看图：sidebar 左侧第 7 项是"艺人"，估计中心 ≈ (0.085, 0.305)
vision-mcp click apple-music --norm "0.085,0.305"
vision-mcp snapshot apple-music --out /tmp/v2.png      # 验证

# 方法 B：annotated 拿"网格 + #N 候选框"——比纯估准
vision-mcp annotated apple-music --out /tmp/a.png --grid-step 0.1
# Agent 看图：第 7 个候选框是"艺人"（label 直接标在框上）
vision-mcp click apple-music --norm "0.085,0.305"
```

## 6. 持续修正 — patch 实战例

实战中遇 map 偏差时**主动** patch：

```bash
# 修正 bbox（最常用）
vision-mcp patch <app> --state <id> --control <id> \
  --bbox-norm x,y,w,h \
  --reason "实测命中错元素，新中心 ..."

# 修正 locator 字段（action_types / locator_priority / label 等）
vision-mcp patch <app> --state <id> --control <id> \
  --partial '{"action_types":["type","click"]}' \
  --reason "..."

# 列出已应用 patches
vision-mcp patches <app>
```

**Trust 渐进**：默认 `session_only`（本次会话）；用户确认后 `--trust trusted` 入库；复杂 / 高风险用 `--trust untrusted_proposal` 等人审。

**真实例**：
- `apple-music sidebar.search` 原 bbox `(0.04, 0.085)` 实际指向"主页"→ patch 改成 `(0.0, 0.05, 0.04, 0.025)` 命中真正搜索 cell
- `notes editor.focus` 原 `action_types: [click, type]` 默认 click 反而丢焦点 → patch 改为 `[type, click]`
- `steam top_nav.store_tab` 原 `(0.045, 0.054)` 偏移 → annotated 看 OCR `#3` 准坐标后 patch
