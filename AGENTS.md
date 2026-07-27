# AGENTS.md - pi-context 项目知识库

## 概述

**pi-context** 是 Pi agent 的上下文管理扩展。它让 agent 可以自己管理对话历史——存档、查看、折叠。

## 三个工具

| 工具 | 作用 |
|---|---|
| `acm_checkpoint` | 存档点。给当前状态起个名字，之后随时能回来。免费，不改变任何东西。 |
| `acm_timeline` | 看地图。查看当前对话(active)、存档点(checkpoints)、搜索历史(search)、分支结构(tree)。 |
| `acm_travel` | 收纳。跳回之前某个点，把中间的过程换成一份简短的交接单。 |

## 技术栈

- TypeScript ESM
- Pi `0.82.1` 的 peer/dev dependency
- 不使用 `constrainedSampling`
- Source-first：Pi 直接加载 `src/*.ts`

## 架构

### 入口

`src/index.ts` 只负责：
1. 创建一个 `AcmSessionRuntime`
2. 注册 prompt injection
3. 注册三个工具
4. 注册 lifecycle handlers

### 模块

| 路径 | 责任 |
|---|---|
| `src/checkpoint-tool.ts` | checkpoint 工具 |
| `src/timeline-tool.ts` | timeline 工具 |
| `src/travel-tool.ts` | travel 工具 |
| `src/handoff.ts` | 交接单 schema 和验证 |
| `src/context-packet.ts` | 上下文包重建 |
| `src/host-bridge.ts` | SessionManager 的 mutation 能力 |
| `src/runtime.ts` | 运行时状态管理 |
| `src/context-gauge.ts` | 上下文用量显示 |

## 工具返回

### checkpoint 成功
返回：存档点名字、节点ID、上下文用量。

### timeline 成功
返回：对应视图的内容。

### travel 成功
返回：目标、新叶子节点、上下文变化（token数、消息数、摘要深度）。

### 失败
返回：错误类型和恢复指导。

## 安全边界

- 旅行只改变对话上下文，**不会**回滚文件、进程、Git提交或任何外部系统。
- 折叠永远可逆：原始历史留在树里，一次旅行就能回去。
- 不取消、不替换原生compaction。

## 测试

```bash
bun test
bun run typecheck
```

完整验证：
```bash
npm ci --ignore-scripts
bun run verify:acm
```
