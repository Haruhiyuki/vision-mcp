# Apple Music — 纯视觉 vision-mcp 构建笔记

> 这份 map 完全由 agent 通过截图视觉判断 + click + 看截图验证构建，未读取一行 AX 数据。
> 案例来源：在迭代过程中先做了基于 AX accessibility 树构建的 `v1-ax-based` 版本，
> 后做了纯视觉版本 `v2-vision-only`，最终合并为现在的 `apps/apple-music/vision-mcp.yaml`（v3 region+collection）。
> v1/v2 历史 yaml 已归档删除；本文档保留对比数据用作设计参考。

## 1. 构建流程

```
for each page in [home, search, search_results, artist_detail, playbar]:
    snapshot --out /tmp/visual/N-xxx.png
    Read /tmp/visual/N-xxx.png       ← 用 agent 自己的视觉能力看
    描述布局，估每个可点击元素的归一化坐标
    click 估计坐标
    snapshot 验证
    miss → 调整坐标重试
```

整个过程 ~30 张截图、~25 次 click/key 验证，共耗时约 20 分钟（含视觉判断时间）。

## 2. 实测结果

| 测试 | 实现 | 结果 | 备注 |
| ---- | ---- | ---- | ---- |
| toggle_play_via_click | click (0.28, 0.94) | ✅ | 中央暂停按钮够大，视觉估计稳定 |
| next_track | key cmd+right | ✅ | 键盘 100% 稳定 |
| prev_track | key cmd+left | ✅ | 键盘 100% 稳定 |
| goto_sidebar_home | click (0.04, 0.12) | ✅ | sidebar 实测必须点图标 (x=0.04) 才稳，点文字中央 (x=0.085) 偶尔无响应 |
| goto_sidebar_songs | click (0.04, 0.39) | ✅ | 同上 |
| goto_sidebar_artists | click (0.04, 0.31) | ✅ | |
| search_and_play (蔡依林) | 全 click + type + key 链 | ✅ | "倒带"实测播放 |
| toggle_play_via_keyboard | key space | ⚠️ | macOS 焦点切换异步偶尔失败，lease 校验报错 |
| 双击歌曲卡片播放 | click count=2 | ✅ | 在搜索结果第一行第二列（歌曲位）实测有效 |
| 双击艺人卡片进详情 | click count=2 | ❌ | Apple Music 艺人卡片需点头像或浮动 ▶ 按钮（hover-only） |

## 3. 纯视觉探索的真实局限

实测过程发现的客观问题：

### 3.1 小目标 click 精度
- 底部播放栏的"上一首/下一首"小三角按钮直径约 12px = norm 0.01
- 人眼估坐标偏 ±5px 就 miss
- → **解决**：在 control 上同时配 `action_types: [key, click]`，agent 优先用键盘快捷键，click 作 fallback

### 3.2 同类卡片的语义区分
- 搜索结果 4×2 网格的"第一行第一列卡片"在不同关键字下可能是艺人/专辑/单曲
- 双击歌曲 → 播放；双击艺人 → 进详情（甚至不响应）
- → **解决**：写 workflow 后**仍需 agent 看截图判断刚刚 click 的是什么类型**，再决定下一步（agent-in-the-loop 不是可选）

### 3.3 dHash 视觉相似度区分弱
- Apple Music 主页 vs 搜索结果页的 dHash 相似度 = 0.89
- 用 `visual_hash` 作 state anchor 区分不开
- → **解决**：单 state 容纳所有 controls，state detection 仅作 hint 用，不阻塞执行

### 3.4 hover-only 控件
- 卡片右上的浮动 ▶ 按钮只在鼠标 hover 时显示
- CGEvent click 不触发 hover 动画
- → **解决**：纯视觉操作时绕开 hover 控件，用双击卡片本体或键盘组合

### 3.5 macOS 焦点切换异步
- 连续 click → key 时，type/key 操作可能因焦点未稳定而报"窗口未处于前台"
- 已有机制：lease validate 重试 3 次 + raise，但仍偶发
- → **解决**：workflow 中 type/key 步骤后插 wait 100ms，或失败后重跑该步

## 4. 与 AX 版本的对比（历史快照）

> 这两个 yaml 文件（v1-ax-based / v2-vision-only）已合并入最终版 `apps/apple-music/vision-mcp.yaml` 并归档删除。
> 下表数据来自迭代过程，仅作设计权衡参考。

| 指标 | v1-ax-based（已归档） | v2-vision-only（已归档） |
| ---- | --------------------- | ------------------------ |
| 控件数 | 9 个 control，3 个 state | 25 个 control，1 个 state |
| 依赖 | macOS Accessibility | 仅截图 + click + 键盘 |
| state detection 准确率 | 高（AXTextField/AXList 独有 anchor） | 弱（dHash 区分不开） |
| 可移植性 | macOS only | 跨平台（Windows/Linux/任何能截图的环境） |
| 控件位置稳健性 | AX 给精确 bbox，0 估计误差 | 视觉估计 ±5-10px，密集 UI 易 miss |
| 适合自定义渲染 app | ❌（游戏/Electron/Flutter 几乎无 AX） | ✅（截图任意 app 都有） |

最终版（v3 region+collection）汲取了两者优点：双轨 locator（AX + 视觉）+ region/collection 抽象消除重复（v2 的 25 控件压缩到 v3 的 8 控件 + 1 collection）。

## 5. 推荐工作方式：**双轨混合**

```
if app 暴露完整 accessibility:
    用 AX 拿精确 bbox（构建 map）
    用视觉验证状态切换（agent-in-the-loop）
else:
    用纯视觉估坐标（每个 click 都视觉验证）
    用键盘快捷键替代小按钮 click
    state detection 弱化，agent 看图自行判断
```

这两种模式 vision-mcp 都支持。本 map 是后一种模式的完整示例。
