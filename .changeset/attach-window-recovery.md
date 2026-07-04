---
"@vision-mcp/core": patch
"@vision-mcp/server": patch
"@vision-mcp/cli": patch
---

修复 quick-look 吸附失败后被永久卡死的问题，并让 WINDOW_NOT_FOUND 可诊断：

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
