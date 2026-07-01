# pi-context

> Agentic Context Management for Pi — 让 AI agent 主动管理自己的上下文。

**pi-context** 让 agent 像管理 git 分支一样管理上下文：打锚点、看时间线、穿越到任意节点留 handoff summary。不是被动等系统自动压缩，而是主动的、语义级别的上下文管理。

## 为什么需要

AI agent 在长对话中会积累大量噪音：搜索结果、调试日志、失败尝试、中间产物。自动压缩按 token 阈值触发，不理解任务语义，经常压缩掉有用的东西。

pi-context 让 agent 自己决定何时打锚点、何时穿越时间线、穿越到哪个节点。

## 工具

| 工具 | 做什么 |
|---|---|
| `acm_checkpoint` | 打锚点。零成本——不改上下文、不分支、不摘要。多打 = 后续更多选择 |
| `acm_timeline` | 看 active path 结构图 + token HUD（official + last LLM prompt）。支持 full_tree、search、list_checkpoints |
| `acm_travel` | 穿越到任意锚点，留一份 handoff summary。上下文切换到目标节点 + summary；旧路径保留 |

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

## 参考

- [pi-context (ttttmr)](https://github.com/ttttmr/pi-context) — 原始设计思路，本项目在此基础上实现 Agent 自动化上下文管理
- [omp-context](https://github.com/KorenKrita/omp-context) — 同一项目的 OMP (oh-my-pi) 版本
- [让 AI 主动管理自己的上下文](https://blog.xlab.app/p/6a966aeb/) — 设计思路
