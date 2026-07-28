# AGENTS.md — pi-context

## 这个仓库是什么

Pi 扩展，给 agent 三个管理自己上下文的工具：`acm_checkpoint`（存档）、`acm_timeline`(查看)、`acm_travel`（折叠）。折叠把已消化的历史替换成一份 7 字段交接单，原始历史留在会话树里可找回。

设计立场：**代码层厚，注入层薄**。实现的正确性（事务、回滚、协议校验、同步）全部由代码和测试保证；给模型的引导只有三层，互不重复——

| 层 | 管什么 | 所在 |
|---|---|---|
| CORE 注入 | 何时折、为何折（判断 + 两个案例） | `guidance/CORE.md` |
| 工具描述 | 怎么用（机制） | `guidance/TOOL-CONTRACTS.md` 工具描述段 |
| 结果提示 | 状态转移（下一步从哪继续） | 同上 CUE 段 |

没有 Skill、没有 promptSnippet/promptGuidelines、没有阈值和流程规定。模型自己判断何时使用。

## 改文案

`guidance/` 下两个 markdown 是唯一来源，改完必须跑：

```bash
bun run generate:guidance
```

生成 `src/generated-guidance.ts`（不要手改）。CI 用 `--check` 校验一致性。

文案原则：说事实不说教；每条信息只在一层出现；工具描述 10 行内；结果提示三句内。

## 不要动的东西

- **运行时机制**：travel 事务（backup → branch → verify → compensate）、host-bridge 的 guarded capability access、live sync 的 `agent_settled` 边界、boundary-ledger。改这些先读对应源文件头部注释。
- **持久化格式锚点**：handoff 七字段标签 `Goal:/State:/Evidence:/External:/Exclusions:/Recover:/NEXT:` 保持英文（`src/handoff.ts` 与 `src/context-packet.ts` 按它们解析）；`ACM_CORE_MARKER`、`ACM_CONTINUATION_MARKER` 不变。
- **details 里的错误码/枚举值**：`applied`/`not_applied`/`indeterminate`、`label_conflict` 等 snake_case 值是程序契约，永远英文。
- **版本钉死**：四个 `@earendil-works/*` 依赖精确固定 `0.82.1`（含 `test/host-fixture/`），不要改成范围版本。
- **不使用** Pi 的 `constrainedSampling`：schema 含 Optional 字段，OpenAI strict 会 400。

## 已知坑

- Pi 宿主每个节点只保留一个 label；多 alias 靠重放 label journal 实现（`src/label-journal.ts`）。
- `branchWithSummary` 成功不代表生效：必须验证真实 leaf/parent/summary，无法排除变更时报 `indeterminate` 而不是失败。
- travel 后的 native 消息替换只能发生在 `agent_settled`；`agent_end`（尤其 error）不是许可。
- 修改 `package.json` 后必须重新生成 `package-lock.json` 并验证 `npm ci --ignore-scripts`（Pi 的 git 安装走 npm）。
- 测试里断言的中文文案来自源码；改源码文案要同步测试，反之亦然。

## 命令

```bash
bun test                  # 全部单元测试
bun run typecheck         # tsc --noEmit
bun run generate:guidance # 从 guidance/ 重新生成
bun run verify:acm        # 完整 gate：guidance check + 测试 + typecheck + host fixture
```

host fixture（`test/host-fixture/`）在真实 Pi 0.82.1 上验证宿主契约，有自己的 lockfile 和构建（`bun ./build-source.mjs`），根目录 `bun test` 不包含它。

## Git

- 提交身份：`KorenKrita <KorenKrita@gmail.com>`（repo-local 配置，不动全局）。
- 上游 fork 自 [ttttmr/pi-context](https://github.com/ttttmr/pi-context)，只发布在 GitHub。
