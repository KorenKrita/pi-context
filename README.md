# pi-context

> 让 AI agent 主动管理自己的上下文。

**Agentic Context Management** — agent 自己决定何时打锚点、何时穿越时间线、穿越到哪个节点。不是被动等系统自动压缩，而是主动的、语义级别的上下文管理。

## 为什么需要

AI agent 在长对话中会积累大量噪音：搜索结果、调试日志、失败尝试、中间产物。自动压缩按 token 阈值触发，不理解任务语义，经常压缩掉有用的东西。

pi-context 让 agent 像管理 git 分支一样管理上下文：

- **开始前**打个锚点（零成本）
- **做完一阶段**后回头看结构
- **觉得太乱了**就 travel 回更早的锚点，用 handoff summary 翻篇
- **需要找回旧路径**就 travel 到 off-path 节点，恢复当时的 raw context

## 工具

| 工具 | 做什么 |
|---|---|
| `acm_checkpoint` | 打锚点。零成本——不改上下文、不分支、不摘要。多打 = 后续更多选择 |
| `acm_timeline` | 看 active path 结构图 + token HUD（official + last LLM prompt）。默认只显示当前路径；`verbose: true` 可显示 ACM 工具调用。off-path 摘要以脚注标出。`search` 全树搜索（含 off-path）。`list_checkpoints: true` 列 checkpoint 清单（可配合 `search` 缩小，显示上限 50），`full_tree: true` 看整棵树 |
| `acm_travel` | 穿越到任意锚点，留一份 handoff summary。上下文切换到目标节点 + summary；token 可能降（回到过去）也可能升（前往未来）。旧路径保留，随时再 travel |

## 时间旅行

**回到过去** — travel 到更早的锚点，把当前路径的噪音替换成 summary：
- 失败的探索后重新开始
- 完成嘈杂阶段后只留结论
- 进入新阶段前整理调查过程

副作用**可能**是 context 变小（目标在噪音产生之前），也可能不变或变大——以 travel 返回的 `estimatedEffect`、`structuralEffect` 和 `sessionMessages` 为准，再用 `acm_timeline` HUD 确认官方 %。

**前往未来** — travel 到 off-path 或更晚的锚点，恢复该节点之前的 raw history：
- 通过 `backupCurrentHeadAs` 找回被离开的分支
- 比较不同方案
- 恢复 summary 里丢失的细节

旧路径永远不删除——每次 travel 创建新分支，老分支完整保留在树里。

## 事件驱动优化

| 事件 | 优化 |
|---|---|
| `turn_end` | 缓存 LLM response 的真实 prompt tokens，HUD 显示准确数值（解决 travel 后 official HUD 滞后） |
| `session_before_compact` | compaction 前自动打 `pre-compact-{timestamp}` checkpoint，事后能 travel 回来恢复细节 |
| `session_compact` | compaction 触发 replaceMessages 后同步状态（清 refreshPending + cachedUsage） |

## 安装

```bash
# 从本地
pi install .

# 从 GitHub
pi install github:KorenKrita/pi-context
```

## 与 Pi 内置功能的关系

| 内置功能 | 关系 |
|---|---|
| 自动压缩 | 互补——自动压缩按阈值触发，acm_travel 让 agent 按语义主动穿越时间线 |
| `/context` | 互补——pi-context 提供 `/context` TUI 可视化 + acm_timeline HUD 双重 token 可视化 |

## 参考

- [pi-context (ttttmr)](https://github.com/ttttmr/pi-context) — 原始设计思路，本项目在此基础上实现 Agent 自动化上下文管理
- [omp-context](https://github.com/KorenKrita/omp-context) — 同一项目的 OMP (oh-my-pi) 版本
- [让 AI 主动管理自己的上下文](https://blog.xlab.app/p/6a966aeb/) — 设计思路
