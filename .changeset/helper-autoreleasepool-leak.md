---
"@vision-mcp/core": minor
"@vision-mcp/server": minor
"@vision-mcp/cli": minor
---

修复 macOS native helper 长驻运行时的无界内存泄漏。

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
