# Token 经济：把视觉操作的上下文成本降一个量级

> 实测教训：一次 GUI 调试会话读了 ~35 张整窗截图，仅图像就占了整个会话
> 约一半的 token 消耗。图像一旦读入就**常驻上下文**，之后每个请求都重复计费——
> 省 token 的关键不是少干活，而是把「看图」从默认动作变成最后手段。

## 成本模型（为什么图这么贵）

- host（Claude 等）读图成本 ≈ **像素面积 / 750** token：1024 宽整窗 ≈ 1k token，
  1568 宽（host 上限）≈ 1.5k+。文件字节数（PNG/JPEG）**不影响** token，只影响磁盘。
- 图像读进上下文后**不会消失**：后续每次请求都会再次携带。30 张图 × 1.5k × 几十轮
  对话 = 会话成本的主体。
- 对比：`snapshot(include_image=false)` 返回的 AX candidates + OCR token 是纯文本，
  典型 2–4k token 一次性成本，且可被上下文压缩；一段 `content_changed: false`
  反馈只有几十 token。

## 决策树（按序问自己）

1. **动作刚执行完，想确认生效了吗？**
   → 看动作结果自带的反馈：`content_changed`（画面变没变）、click 的 `target`
   （点到了什么 AX 元素）。`content_changed: false` 明确说明没生效——不用截图。
2. **只想读屏幕上的文字/状态？**（徽标、标签、计数、菜单项）
   → `snapshot(include_image=false, include_ocr=true)`，局部加 `region_norm`。
   ocr_tokens 带文本 + bbox（已映射回客户区坐标，可直接 click_at）。零图像成本。
3. **在等某个画面变化？**（轮询加载/进度）
   → `capture(only_if_changed=true)`：内容与上次一致返回 `unchanged: true`，
   不产新图；变了才拿到新 image_path。
4. **真要看图？**
   → 能局部就局部：`capture(region_norm=[x,y,w,h])` 只付要看那块的 token。
   整窗认字 `max_image_width` 用默认 1024；只有看细节纹理才调大。
5. **要连续看多张？**
   → 先想清楚每张回答什么问题。凡是"确认类"的图都应换成 1–3 的文本通道。

## 各工具的省 token 参数速查

| 工具 | 参数 | 效果 |
|------|------|------|
| `capsule.capture` | `region_norm=[x,y,w,h]` | 只截局部，token 按面积省 |
| | `only_if_changed=true` | 内容没变返回 unchanged，不产图 |
| | `max_image_width`（默认 1024） | ≈1k token/图；调大前先想是否必要 |
| | `format`（默认 jpeg q85） | 磁盘小 5–10×（不影响 token） |
| `vision_map.snapshot` | `include_image=false` | 纯文本观察：candidates + ocr_tokens |
| | `region_norm` | AX/OCR/图像都只看该区域 |
| `click_at` / `scroll` / `type_text` / `press_key` | 默认 `feedback=true` | 返回 `content_changed`（+ click 的 `target`），代替确认截图 |
| | `settle_ms` | UI 动画慢的界面调大，避免拍到中间态误判 |
| | `feedback=false` | 批量机械操作时省 ~0.5s/动作 |

## 失败模式（这些钱最容易白花）

- **动作 → 截图 → 读图 → "哦什么都没变"**：一轮 ~1.5k token 换一个 boolean。
  用 `content_changed` 代替。
- **整窗截图确认一行字**：1k token 看 20 个字。用 `snapshot(region_norm, include_image=false)`。
- **纯色/空白图不报错**：句柄失效已改为显式 `CAPTURE_INVALID` / `WINDOW_NOT_FOUND`；
  看到 `frame_uniform: true` 提示时先 `validate_geometry`，别急着读图。
- **默认分辨率截 Retina 原图**：2480px 宽的图 host 会缩到上限再计费，白传输；
  `max_image_width` 保持默认或更小。
