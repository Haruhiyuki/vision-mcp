# 实战避坑（agent 失败时按需查）

这些坑都来自真实跑 vision-mcp 时踩过的，整理成快速对照。

## 1. macOS 焦点是异步的

Click / type / key 在窗口失焦后会发到其它 app。规则：

- `vision_map.click_at` / `type_text` / `press_key` 内部已自动 `capsule.raise`
- 两次 RPC 间隔较长（>1s）时仍可能失焦——必要时显式 `capsule.raise`
- Windows 同理：UIPI 锁前台时 `SwitchToThisWindow` 也不一定生效（要求 vision-mcp 进程是终端前台子进程）

## 2. 中文 / Unicode 输入

| 平台 | 实现 | 注意 |
| ---- | ---- | ---- |
| macOS | NSPasteboard 粘贴 | 暂用剪贴板，helper 自动备份+恢复 |
| Windows | SendInput VK_PACKET（KEYEVENTF_UNICODE）| 绕过 IME，不污染剪贴板 |

不要用 SendKeys（macOS System Events keystroke / Windows SendKeys）传中文 — 只支持 ASCII。

## 3. AX 树取自首个真窗口

`window.list` 给的 handle 是 `pid:0`（macOS）或 HWND（Windows）。当目标 app 弹 popup（如搜索建议下拉）时，helper 自动按 **pid 内面积最大窗口** 匹配主窗口，不会把 popup 当主窗口（避免 `client_size 397x28 ≠ 1280x800` 错误）。

agent 调 `attach_window` 后默认拿到的是主窗口；要操作 popup 需显式 listWindows + 选择。

## 4. 容器节点的 name（macOS 特有）

Sidebar 的 AXCell `name="主页"` 是 helper 从子 AXStaticText 反推的（macOS AX 本身在 cell 的 AXTitle 为空）。

- 看到 AXCell name=null → 多半 dump 用了 osascript 路径；切到 swift helper（默认）即可
- 写 locator 时优先用 `description`（更稳）；不行才用 `name`

## 5. 何时 commit_state / commit_control

- snapshot 返回 `state_match=null` 或 score < 0.7 → 大概率新页面，可 commit_state
- 多次访问同一 page 拿到一致的 visual_hash + AX signature → 可信赖此 state，commit
- 单页面同类 cell（8 张专辑卡片）：**不要每个 commit 一条 control** —— 用 collection + enumeration 一条声明，靠 index 区分（参 [`map-design.md §3`](map-design.md)）

## 6. 返回路径优先级

跨平台优先级（写 transition 或 agent 临时返回时）：

1. `Escape` —— modal / popup 最常用，跨平台通用
2. **macOS** `cmd+[` —— Apple 系 Back（Finder / Safari / Music / Photos）；**Windows** `alt+left`
3. AX 树里 description ∈ {返回, Back, ◁, ‹, <, 上一} 的 AXButton
4. 不行就告诉用户 —— 不要瞎 click

## 7. CEF / Chromium app 的 UIA 空壳（Windows 特有）

Steam / Discord / VS Code / Edge 这类 CEF/Chromium app：

- UIA 只看到 `Chrome_RenderWidgetHostHWND` 空壳容器，**完全拿不到 DOM 元素**
- 写 locator 不要 `accessibility` 档（会一直 miss）
- 必走 `ocr_text exact + min_confidence: 0.7+ → ocr_text contains → bbox_norm` 三档
- `click-text` 在 Windows 自动走 `recognize_window`（PrintWindow 路径），屏外 / 后台窗口也能 OCR
- 参 [`platform-windows.md §6`](platform-windows.md) + [`map-design.md §4`](map-design.md)

## 8. 窗口最小尺寸（Steam / Discord 等）

部分 app 有最小窗口约束，capsule.migrate 后实际尺寸 > visual_box.display 期望：

- Steam 实测最小 ~1364×810（不是默认 1280×800）
- 解决：`visual_box.display` 写实测尺寸 + `tolerate_client_size_delta_px` 放宽到 60-100
- doctor / validate 跑出 `GEOMETRY_MISMATCH` 时检查这条

## 9. destructive 流程不要 auto-repair

`repair_policy.destructive_actions.auto_repair_before_action: false` 是默认，但容易忽略：

- 卸载 / 删除 / 提交付款类 control 必须 `risk_level: destructive` + `approval_required: true`
- workflow step 加 `on_failure: abort`（不是 `repair` / `ask_user`） —— destructive 出错绝不重试
- 参 [`map-design.md §7`](map-design.md) 和 [`safety.md`](safety.md)

## 10. patch trust 不要默认 trusted

写 patch 时默认 `trust=session_only`（仅本会话）：

- 跑通 workflow 后告诉用户"我发现了 X 偏差并已临时修复"
- 用户确认后 `--trust trusted` 升级，写入 git
- 复杂 / 高风险用 `--trust untrusted_proposal` 不自动应用等人审
- 参 [`patches.md`](patches.md) §"Trust 渐进"

## 11. action_types 顺序决定默认动作

`action_types: [click, type]` vs `[type, click]` 结果完全不同：

- 编辑区 / textbox：用 `[type, click]` —— click 反而可能丢焦点（Notes / SwiftUI 编辑器常见）
- 小按钮：`[key, click]` —— 快捷键比小按钮 click 稳
- 列表行：`[double_click, click]` 双击启动 / 单击选中
- 写错就 patch：`vision-mcp patch <app> --partial '{"action_types":["type","click"]}'`
