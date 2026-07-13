---
"@vision-mcp/core": minor
"@vision-mcp/server": minor
"@vision-mcp/cli": minor
---

视觉操作成本大修：区域截图 / 变化短路 / 动作反馈 / 静默失败显式化。

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
