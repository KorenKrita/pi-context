# AGENTS.md — pi-context 草根版

本项目是 [pi-context](https://github.com/ttttmr/pi-context) 的 fork，为 Pi agent 提供上下文管理工具。

## 工具

- `acm_checkpoint` — 创建存档点，给当前状态起个名字，之后可以回来
- `acm_timeline` — 查看会话历史、存档点、搜索、树结构
- `acm_travel` — 折叠旧历史，把一段过程替换成摘要

## 技术栈

- TypeScript ESM，Pi 直接加载 `src/*.ts`，不编译
- 依赖精确固定 Pi `0.82.1`
- 工具参数 schema 使用 `@earendil-works/pi-ai` 的 TypeBox

## 架构

| 模块 | 职责 |
|---|---|
| `src/index.ts` | 入口：创建 runtime、注册 prompt、工具、lifecycle |
| `src/checkpoint-tool.ts` | checkpoint 实现 |
| `src/timeline-tool.ts` | timeline 实现 |
| `src/travel-tool.ts` | travel 实现 |
| `src/handoff.ts` | handoff 格式定义和验证 |
| `src/context-packet.ts` | 上下文包重建 |
| `src/runtime.ts` | 按 session 隔离的状态管理 |
| `src/runtime-lifecycle.ts` | lifecycle 事件处理 |
| `src/host-bridge.ts` | 操作 Pi 底层 SessionManager 的唯一入口 |
| `src/travel-coordinator.ts` | travel 事务（backup → branch → verify） |
| `src/context-gauge.ts` | 仪表 `[ctx N%]` |
| `src/context-pressure.ts` | 压力计算 |
| `src/fold-estimate.ts` | fold 收益估算 |
| `src/live-agent-session-adapter.ts` | 实时 AgentSession 同步 |
| `src/boundary-ledger.ts` | 请求边界记录 |
| `src/lib.ts` | 工具函数 |
| `src/generated-guidance.ts` | 从 CORE.md + TOOL-CONTRACTS.md 生成|

## 开发

```bash
bun test
bun run typecheck
bun run test:guidance
bun run verify:acm
```

## 维护规则

- `package.json` 的 Pi 依赖精确固定版本，不要改
- 修改 `package.json` 后重新生成并提交 `package-lock.json`
- 测试 run 在 Bun 上，CI 用 Node 24.16.0 + npm 11.13.0 + Bun 1.3.14
- 不要用 `console.log`，用户可见信息用 `ctx.ui.notify()`