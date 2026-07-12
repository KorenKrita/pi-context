# pi-context

> 让 Pi agent 主动管理自己的上下文。

**Agentic Context Management (ACM)** 让 agent 按任务语义管理 context working set：checkpoint 建立恢复点，timeline 展示会话树，travel 把完成阶段或失败方向折叠成可恢复的 handoff branch。旧路径仍保留在 session tree 中，之后可以恢复。

本仓库是 KorenKrita 维护的 [`omp-context`](https://github.com/KorenKrita/omp-context) 的 Pi 迁移版，并保留 Pi 独有的 `/context` token 可视化命令。`omp-context` 是个人维护的第三方 OMP 插件，不是 OMP 官方实现。

## 支持版本

当前精确支持 **Pi `0.80.6`**。所有 `@earendil-works/pi-*` peer dependencies 和真实 host fixture 都固定为该版本；live AgentSession compatibility seam 不会对其他版本猜测私有结构。

## ACM 工具

| 工具 | 作用 |
|---|---|
| `acm_checkpoint` | 给某个会话节点追加语义 alias。不会分支、摘要或改变当前 context |
| `acm_timeline` | 查看 active path、checkpoint catalog、全树搜索或完整 tree，并显示 context/live-sync HUD |
| `acm_travel` | travel 到 checkpoint 或 node ID，用七槽 handoff 创建 continuation branch；原路径成为可恢复 archive |

### Timeline：严格单视图

```ts
{ view: "active", limit?, verbose? }
{ view: "checkpoints", limit?, filter? }
{ view: "search", limit?, query }
{ view: "tree", limit? }
```

省略 `view` 等价于 `active`。默认视图只显示模型实际使用的 active spine；off-path summaries 以分支脚注呈现。旧的 `list_checkpoints` / `full_tree` / `search` boolean 参数不受支持。

### Travel handoff

`acm_travel.summary` 必须包含七个槽位：

```text
Goal: <当前目标>
State: <已经确定的状态和结论>
Evidence: <文件、命令、URL、commit、node/checkpoint 等恢复指针>
External: <磁盘、进程、浏览器、远端等外部副作用>
Exclusions: <已排除方向及原因>
Recover: <archive checkpoint 或 node ID>
NEXT: <一个可立即执行的动作>
```

travel 改变的是 Pi 会话历史树及后续模型 context，**不会**回滚文件系统、进程、浏览器或远端服务。

## Travel 后的双重同步

一次结构验证成功的 travel 会触发两条互补路径：

1. **Persistent context rebuild**：下一次 `context` event 从 active SessionManager branch 重建并 sanitize provider messages；失败最多重试 3 次。
2. **Live AgentSession sync**：匹配的 `tool_execution_end` 后，把同一 SessionManager 对应 AgentSession 的 stored messages 替换为 rebuilt active branch，使 Pi 的 native context accounting 不再继续计算已折叠历史。

live sync 按 SessionManager 对象身份隔离，使用 WeakMap/WeakRef，不按目录、模型或 session 文件名猜测关联。若精确 host capability 不可用或 replacement 失败，travel 本身仍保持有效，persistent rebuild 继续提供正确 provider context，HUD 会显示状态并建议 reload。

live sync 状态包括：`unavailable`、`pending`、`applied`、`failed`、`skipped`。

## Context 与 compaction

- `turn_end` 缓存最近一次真实 prompt usage，供 timeline HUD 使用。
- `session_before_compact` 只在 Pi 真正发起 native compaction 时追加唯一的 `pre-compact-*` checkpoint。
- successful live sync 会缩减 Pi 的 stored message accounting，避免因为 travel 前的 stale message array 立即误触发 native compaction。
- `session_start`、`session_shutdown`、`session_compact` 按 session 清理 runtime state。
- `fixOrphanedToolUse()` 删除孤立 tool result，并为被 travel 中断的 tool call 合成 `[Interrupted by context travel]` result。

### Integrated-consumer compatibility

The named export `fixOrphanedToolUse(messages)` follows the canonical ACM contract: it returns a sanitized message array and does not mutate the caller's array. Consumers of the legacy in-place/boolean helper must use the returned array after upgrading.

## `/context`

`src/context.ts` 注册 Pi 独有的 `/context` TUI，用于查看 token 构成。它与 ACM 分工如下：

- `/context`：观察 token 占用
- `acm_timeline`：观察 session tree、checkpoint、refresh/live-sync 状态
- `acm_checkpoint` / `acm_travel`：主动改变会话结构

## 安装

```bash
# 本地
pi install .

# GitHub
pi install git:github.com/KorenKrita/pi-context
```

## 开发验证

```bash
bun install
bun run verify:acm
```

`test/host-fixture/` 会独立安装精确的 Pi `0.80.6`，构建 source-first fixture，并验证：

- host version contract
- AgentSession adapter capability、弱关联与幂等安装
- successful shrinking travel 与完整 in-flight tool call/result
- provider context、tree archive 与 native compaction accounting
- unavailable/failure fallback
- repeated travel、off-path restoration、persistence/resume
- lifecycle cleanup、多 session 与 parent/subagent isolation

## 代码结构

| 路径 | 责任 |
|---|---|
| `src/index.ts` | 短 composition root |
| `src/*-tool.ts` | checkpoint / timeline / travel behavior modules |
| `src/travel-coordinator.ts` | backup、branch、verification、compensation transaction |
| `src/host-bridge.ts` | SessionManager capability boundary |
| `src/runtime.ts`, `src/runtime-lifecycle.ts` | session-scoped refresh、usage、live sync 与 lifecycle |
| `src/live-agent-session-adapter.ts` | pinned Pi AgentSession synchronization seam |
| `src/lib.ts` 等 | dependency-light domain logic |
| `skills/context-management/CORE.md` | canonical normal-path guidance |
| `src/generated-guidance.ts` | generated runtime guidance |
| `src/context.ts` | Pi 独有 `/context` TUI |

详细维护约束见 [`AGENTS.md`](./AGENTS.md)，实现决策与 provenance 见 [`implementation-notes.html`](./implementation-notes.html)。

## 参考

- [pi-context (ttttmr)](https://github.com/ttttmr/pi-context) — 原始设计
- [omp-context](https://github.com/KorenKrita/omp-context) — KorenKrita 维护的第三方 OMP 适配版，也是本仓库 ACM 实现的迁移源
- [让 AI 主动管理自己的上下文](https://blog.xlab.app/p/6a966aeb/) — 设计思路
