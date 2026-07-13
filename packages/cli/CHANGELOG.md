# @vision-mcp/cli

## 0.8.0

### Minor Changes

- c8f50f1: 修复 macOS helper SCKit 捕获拍错窗口：多窗口进程命中隐藏辅助窗口。

  `findWindowID` 的 SCKit 分支只按 pid 取**面积最大**的 SCWindow，完全忽略
  标题与几何。TextEdit / Electron 这类进程存在不可见辅助窗口（面板缓存、
  offscreen surface）时会拍到它——上层拿到一张 1000x1000 纯色图还以为截图
  成功（实测两次复现：Electron 应用调试会话 + TextEdit）。

  修复：同 pid 候选内按「AX bounds 几何匹配（中心+尺寸差 ≤32pt）→ 标题相等
  → 面积最大兜底」排序；CGWindowList fallback 同样加 bounds 评分。
  `capture.window` / `ocr.recognize_window` 两条调用链都传入 AX bounds。

  配合 server 侧新增的 CAPTURE_INVALID 帧几何校验形成双保险：helper 选对
  窗口，选错也会被显式拦下而非静默返回空图。

  升级后需重跑 `vision-mcp install-helper --force` 重编 helper 生效。

- 81d3cfe: 视觉操作成本大修：区域截图 / 变化短路 / 动作反馈 / 静默失败显式化。

  实测一次 GUI 调试会话读了 ~35 张整窗截图，仅图像就占会话约一半 token——
  图像读入后常驻上下文反复计费，而其中多数只为确认一小块 UI 或"有没有变化"。

  **capsule.capture**

  - `region_norm=[x,y,w,h]`：先裁剪再降采样，只付要看那块的 token
  - `only_if_changed=true`：整帧 dHash 与上次一致（汉明距 ≤2/64）时返回
    `unchanged: true` 不产新图；snapshot / 动作反馈共用同一 hash 记账
  - 默认值修正：`max_image_width` 0（原始分辨率）→ 1024（≈1k token/图）；
    输出默认 JPEG q85（磁盘小 5–10×，`format: "png"` 仍可选）
  - 结果带 `visual_hash` / `changed_since_last` / `frame_uniform`（纯色帧警示）

  **raw 动作反馈（click_at / type_text / press_key / scroll）**

  - 默认 `feedback=true`：动作前后整帧 dHash 对比 → `content_changed` +
    `visual_similarity`；false 时 summary 明确提示"画面无变化（点空/到底/焦点不对）"
  - click_at 另报 `target`：落点处的 AX 元素（点到了什么）
  - 动作后自动失效 AX 缓存，后续 snapshot 不再读到旧树
  - `settle_ms` 可调 UI 稳定等待；`feedback=false` 跳过

  **vision_map.snapshot**

  - `region_norm`：AX candidates / OCR / 图像都只看指定区域；OCR bbox 自动
    映射回整客户区坐标系，可直接传 click_at

  **静默失败显式化（capsule）**

  - capture 前刷新窗口句柄：失效 → `WINDOW_NOT_FOUND`（提示重新 attach），
    不再对幽灵句柄拍出纯色空图
  - 帧尺寸与窗口 bounds×HiDPI scale 候选不符 → 新错误码 `CAPTURE_INVALID`
    （实测故障：窗口 1240x860 却拿到 1000x1000 空白帧）

  **core 新增图像基础件**：`cropRgba` / `regionNormToPx` / `encodeRgbaToJpeg`
  （jpeg-js，纯 JS）/ `frameStats`（均匀色帧检测）。

  **文档**：新增 `references/token-economy.md`（成本模型 + 决策树 + 失败模式）；
  SKILL.md 核心原则改为"文本观察优先，看图兜底"；server instructions 同步。

### Patch Changes

- Updated dependencies [c8f50f1]
- Updated dependencies [81d3cfe]
  - @vision-mcp/core@0.8.0
  - @vision-mcp/server@0.8.0

## 0.7.0

### Minor Changes

- 33d203a: 修复 macOS native helper 长驻运行时的无界内存泄漏。

  `vision-mcp-helper` 是长寿命 JSON-RPC sidecar，主循环 `while true { handle() }`
  逐行处理 RPC 却从未包 `autoreleasepool`。handle() 内大量 autoreleased 的
  Foundation/CF/AX/OCR/截图临时对象（`JSONSerialization`、AX 属性查询返回值、
  `SCShareableContent`、`NSBitmapImageRep`、`VNRecognizeTextRequest` 结果、`Data`
  缓冲等）会永久堆在顶层 autorelease pool——进程从不退出、也没有 RunLoop 触发排空，
  于是 `MALLOC_SMALL` 堆随 RPC 次数无界增长（实测两个 helper 各涨到 ~9.5GB /
  phys_footprint，运行约 22h 与 5.5h）。

  修复：每次 RPC 处理包一层 `autoreleasepool` 逐次 drain。压测 5 万次分配型 RPC
  后 footprint 稳定在 ~12MB（此前同等负载会持续攀升）。

  升级后需重跑 `vision-mcp install-helper` 重编 helper 生效；旧进程建议手动结束。

### Patch Changes

- c29e8fa: 修复 quick-look 吸附失败后被永久卡死的问题，并让 WINDOW_NOT_FOUND 可诊断：

  - **server**: `capsule.attach_window` 失败时丢弃缓存的 app 句柄（连同平台适配器）。
    此前首次调用若创建出坏适配器（helper 冷启动失败静默降级、权限未就绪等），
    会随 quick-look 句柄永久缓存，后续无论怎么改 `target_override` 重试都复用同一个
    坏适配器；而 `vision_map.init` 末尾恰好清缓存，造成"必须先 init 才能 attach"的假象
    （与文档承诺的"吸附看一眼不用先 init"矛盾）。
  - **core/capsule**: `attach` 匹配不到窗口时，错误信息附带"当前可枚举到窗口的进程"
    列表，或在完全枚举不到窗口时提示权限/无 GUI 的可能原因。
  - **core/darwin-osascript**: System Events 枚举到进程但全部拿不到窗口时，
    显式抛 `PERMISSION_DENIED`（此前静默返回空列表，上层只能看到误导性的
    WINDOW_NOT_FOUND）。
  - **native/macos helper**: `window.list` 在 `AXIsProcessTrusted() == false` 时返回
    `PERMISSION_DENIED` 错误而非空数组；helper 主循环透传结构化错误的 `code` 字段。

- Updated dependencies [c29e8fa]
- Updated dependencies [33d203a]
  - @vision-mcp/core@0.7.0
  - @vision-mcp/server@0.7.0

## 0.6.0

### Minor Changes

- 新增截图默认落盘与 downsample 元数据，透传 capture `via` 细节，降低 geometry violations 噪声，支持 quick-look 临时会话，并把 macOS per-window OCR 接入统一捕获管线。

### Patch Changes

- Updated dependencies
  - @vision-mcp/core@0.6.0
  - @vision-mcp/server@0.6.0

## 0.5.0

### Minor Changes

- `saveMap` 增量改：基于原 yaml Document 写回，保留**注释 / 字段顺序 / 手编格式**。

  之前 `commit_state` / `commit_workflow` / `harvest_session` 每次 save 都把手编 yaml 整文件重写，注释丢失、字段顺序乱、zod default 字段（`kind: control` / `risk_level: safe` 等）到处注入污染。

  新方案：

  - `loadMap` 用 `YAML.parseDocument` 保留原 doc source，随 `MapLoadResult.baselineDoc` 返回
  - `AppHandle` 携带 baselineDoc；`writeEffective` 走增量路径
  - `applyJsToDoc` 递归算法：原 doc 已有的 leaf path → `setIn` 更新；原 doc 没有的字段 → **跳过**（zod default 注入不会污染）；数组 → 重叠部分递归 update，超出追加，缩短截断
  - 短标量数组（≤ 8 元素）保 inline flow style

  实测保真：round-trip 自身收敛、注释 / 字段顺序 / 其他字段完全保留、harvest 加 workflow 仅 14 行 diff 全是新增内容。已知限制：首次 save 从 hand-edited 状态一次性规范化（之后稳定）。

### Patch Changes

- Updated dependencies
  - @vision-mcp/core@0.5.0
  - @vision-mcp/server@0.5.0

## 0.4.1

### Patch Changes

- `vision_map.snapshot` 返回里加 `ocr_tokens` —— 探索阶段 agent 一次拿到 AX 候选 + OCR 文字 token + bbox，OCR 作辅助定位（AX 树空 / CEF / 自绘 UI 时主力）。

  修复链：

  - snapshot inputSchema 加 `include_ocr` (default true) + `max_ocr_tokens` (default 50)
  - 返回里加 `ocr_tokens: [{text, confidence, bbox_norm}]` (filter conf ≥ 0.5, sort desc, top N)
  - 修 server ensureCapsule 自动注入 OCR provider（macOS DarwinOcrProvider + Windows WindowsOcrProvider），之前只注入 AX
  - 修 snapshot handler 主动调 `recognizeRect(client_rect_px)` — DarwinOcrProvider.recognize(frame) 故意返回 []（需要 screen rect），detectState → analyze → recognize 这条路填不到 OCR token

  真机验证（Notes 客户端）：candidates 5/110 + ocr_tokens 10/160 含 "设置"/"帮助" 等文字 + 精确 bbox，让 agent 不看图就能 click 文字位置。

- Updated dependencies
  - @vision-mcp/core@0.4.1
  - @vision-mcp/server@0.4.1

## 0.4.0

### Minor Changes

- `perform_action` 返回里加 `signals` 字段——agent in-the-loop 看 raw 数据复核机械 pass/fail 之外的细节。

  字段：

  - `window_title` — 当前 window 标题（信号最便宜）
  - `state_after` — `{state_id, score, matched_anchors}` detect_state 推断详情
  - `ocr_hits` — postcondition 评估时 OCR 命中的 top 10 token（confidence ≥ 0.5）
  - `ax_matched` — postcondition 评估时 AX 命中的 top 10 node（有 name/role）
  - `visual_diff` — 动作前后 dHash 差异（0-1）
  - `visual_hash_after` — 动作后的 hash hex
  - `postcondition_reasons` — evaluator 返回的紧凑 reason 字符串列表

  设计哲学：postcondition 评估是机械 pass/fail；signals 是 raw 让 agent 自己复核（OCR 命中的字真对吗？AX node 是预期的吗？state_score 高吗？visual_diff 异常吗？）。配 postcondition 时收集全套；没配也返回 window_title / state_after / visual_diff / ax / visual_hash_after 基础信号。

  不强制 agent 看，默认不影响"沉淀-命中"零看图流程；agent 怀疑时随时能看。

### Patch Changes

- Updated dependencies
  - @vision-mcp/core@0.4.0
  - @vision-mcp/server@0.4.0

## 0.3.0

### Minor Changes

- 实现 postcondition "信号 → AX → OCR → 视觉" 短路链。前面的能验出执行成功就不付后面的成本。

  - `waitForCondition` 按 condition 类型按需收集数据：用户配 `window_title_should_match` 只付信号成本（~5ms），配 `text_should_appear` 才付 OCR，配 `state_should_be` 才全收集（capture + OCR + AX + visual_hash）。
  - `WorkflowStep` 加 `postcondition` 字段，覆盖 control.postcondition。runtime 在 runWorkflow 时优先用 step.postcondition。
  - `harvest_session` 自动给每个 step 加 `state_should_be: <next_state>` postcondition（从 perform_action 历史记录的 state_after 推断），让沉淀出来的 workflow 复用时真做视觉/AX 验证而不只看 RPC ok。
  - `text_should_disappear` 用 `atom.min_confidence`（之前硬编码 0.6 忽略 schema 字段）。
  - `visual_diff_should_be` 默认 `max_similarity` 0.95 → 0.85（之前 5% 变化就算"变了"太宽松，弹小提示就过；现在要 15% 才认为有实质变化）。

### Patch Changes

- Updated dependencies
  - @vision-mcp/core@0.3.0
  - @vision-mcp/server@0.3.0

## 0.2.2

### Patch Changes

- 修 cli `appsRoot()` 拿到含未展开 `${VAR}` 字面值（典型如 plugin .mcp.json 用 `${CLAUDE_PLUGIN_ROOT}/examples`，但 host 没在 plugin context 下 spawn server 导致变量不展开）时，直接用字面路径让 file system 操作全数 silent fail——list_apps 返空、init 写到字面目录、perform_action 找不到 action 等连锁怪问题。现在 cli 自动检测未展开 `${...}` 并 fallback 到 `~/.vision-mcp/apps` + stderr warn 指出根因，避免静默失败。
- Updated dependencies
  - @vision-mcp/core@0.2.2
  - @vision-mcp/server@0.2.2

## 0.2.1

### Patch Changes

- 修复 macOS capsule.raise 报 ok 但窗口没真切前台的死锁。Swift helper 的 `window.activate` / `window.raise` 现在内部 polling 等到目标 PID 真成为 frontmost（timeout 1500ms），超时返回 `{ok: false, reason: "foreground_timeout", target_pid, frontmost_pid, hint}`。JS adapter `raiseWindow` 检查 ok=false 直接抛 `GEOMETRY_MISMATCH` 带详细诊断。`ERROR_HINTS.GEOMETRY_MISMATCH` 改写为分情况提示，明确 foreground_timeout 是焦点窃取保护、repair_minimal 救不了，让用户手动 cmd+tab 一次。
- Updated dependencies
  - @vision-mcp/core@0.2.1
  - @vision-mcp/server@0.2.1

## 0.2.0

### Minor Changes

- P0 fix: 修复 MCP SDK 1.29 把所有工具 `taskSupport` 硬编码为 `forbidden`，导致 Claude Code 等 host 把 vision-mcp 工具集对 agent / subagent 完全锁住的问题。新版本 client 看到 `taskSupport: optional`，工具立即可用。

  P1 feat: 新增 `vision_map.harvest_session` 一键沉淀——agent 跑完一串 `perform_action` 后直接调此工具自动把成功步骤串成新 workflow，不必重述 action_id / params。

  Skill 文档加 Precondition 检查：subagent 启动后必须先 `vision_map.list_apps` 验证工具可用，不可用立即停手汇报上游。

### Patch Changes

- Updated dependencies
  - @vision-mcp/core@0.2.0
  - @vision-mcp/server@0.2.0

## 0.1.1

### Patch Changes

- 修 @vision-mcp/cli 0.1.0 中 `scripts/` 目录漏打包导致 `npm install` 时 postinstall 报 `Cannot find module 'scripts/postinstall.mjs'`，整个安装失败、cli 没装上的问题。0.1.0 完全不可用，请升级到 0.1.1。
- Updated dependencies
  - @vision-mcp/core@0.1.1
  - @vision-mcp/server@0.1.1
