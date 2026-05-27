# 持续修正：把每次实战发现的偏差固化为 patch

SKILL §5 的扩展。**核心原则**：map 永远是渐近完善的，agent 在实战中遇到偏差**主动**写 patch，让 map 越用越好、操作成本越来越低。

## 1. 何时必须写 patch（agent 主动义务）

| 触发情形 | patch 类型 | 命令 |
| -------- | ---------- | ---- |
| **locator 命中但点错元素**（如 sidebar 第 2 项实际选中第 3 项） | `control_bbox` | `vision-mcp patch <app> --state <id> --control <id> --bbox-norm x,y,w,h` |
| **action_types 顺序导致默认动作失败**（如 click 编辑区反而丢焦点，应改 type 优先） | `control_locator` | `--partial '{"action_types":["type","click"]}'` |
| **locator 优先级错误**（如 AX name 应改 description；OCR 应替换 AX） | `control_locator` | `--partial '{"locator_priority":[...]}'` |
| **新弹窗 / 子页面未建模** | `state` (add) | 用 `vision-mcp build` 或人工补 YAML |
| **窗口尺寸/DPI 飘移** | `geometry_profile` | 让 runtime 自动 L2 修复或人工 patch |

## 2. 决策树

```
动作失败 / 命中错元素
   │
   ├─ 是 transient 失败（焦点丢失、动画未结束）？
   │     → 重试一次（带 250ms delay）
   │
   ├─ 是 geometry 问题（窗口被用户拖移/缩放）？
   │     → vision_map.repair_minimal --max-level 2
   │
   ├─ 是 map 问题（坐标偏差 / locator 错 / action_type 错）？
   │     → **必须写 patch**
   │     → trust=session_only（先验证）
   │     → 跑一遍 workflow 验证 patch
   │     → 跑通后建议用户升级 trust=trusted
   │
   └─ 是新 state / 未建模区域？
         → 告诉用户，**不要自动**写 state patch（影响面太大）
```

## 3. 实战例子

**例 1：apple-music sidebar 搜索坐标偏差**
```bash
vision-mcp patch apple-music --state sidebar --control search \
  --bbox-norm 0.0,0.05,0.04,0.025 \
  --reason "实测 sidebar 搜索 cell 在 norm (0.014, 0.065)；原中心 (0.04, 0.085) 实际指向主页"
```

**例 2：备忘录编辑区 action_types 修正**
```bash
vision-mcp patch notes --state editor --control focus \
  --partial '{"action_types":["type","click"]}' \
  --reason "实测: cmd+n 后焦点自动在编辑区，click 反而丢焦点"
```

## 4. Trust 等级渐进

- `session_only`（默认）：本次会话生效。agent 跑通后告诉用户"已临时修复"。
- `trusted`：用户确认后升级到这一级，写入 git。`vision-mcp patches <app>` 可查看。
- `untrusted_proposal`：不自动应用，要人审。复杂或高风险的 state patch 建议先用这一级。

## 5. Trace 是 patch 的证据源

每个 action 都会在 `apps/<app>/.traces/` 留下事件，含前后截图。写 patch 时在 `--reason` 引用 trace 时间戳便于审计：

```bash
vision-mcp patch <app> --state ... --control ... \
  --reason "trace 2026-05-27T14:07Z 中 click_at (353,235) 实际命中主页 cell"
```

## 6. 累积曲线（成本摊销）

- 第 1 次跑任务：失败 → snapshot → 发现偏差 → patch → 重试成功（视觉成本一次）
- 第 2 次起：直接跑，0 snapshot，0 失败

每次"必须看"的视觉投入都摊销到永久 patch + map 副产品上 —— 这是"越用越便宜"的本质。

## 7. 跟 runtime repair 的关系

| 路径 | 性质 | 触发 |
|------|------|------|
| **被动 Repair**（runtime 自动） | L0-L3 阶梯尝试低成本修复 | 每个 action 失败 |
| **主动 Patch**（agent in-the-loop） | 把实测偏差永久固化 | agent 判断是 map 问题时主动调用 |

两条路径互补：被动 repair 让本次执行尽量跑通；主动 patch 让下次跑成本降低。
