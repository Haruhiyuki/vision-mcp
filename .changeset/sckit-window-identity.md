---
"@vision-mcp/core": minor
"@vision-mcp/server": minor
"@vision-mcp/cli": minor
---

修复 macOS helper SCKit 捕获拍错窗口：多窗口进程命中隐藏辅助窗口。

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
