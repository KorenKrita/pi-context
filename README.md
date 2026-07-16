# pi-context

让 Pi agent 主动维护自己的上下文，而不是等窗口耗尽后被动压缩。

`pi-context` 是由 KorenKrita 维护的第三方 Pi 扩展。它让 agent 能够：

- 在返回价值发生实质变化时建立 recoverability，而不是按步骤仪式性打点；
- 持续把观察压缩成 knowns、unknowns、hypotheses、attribution 与 evidence provenance；
- 携带下一段工作会复用的 **hot set**，把其余过程批量 fold 成七槽 authoritative representation；
- 让 compression cadence 跟随 durable representation gain，而不是 action count、固定阶段或 token 阈值；
- 通过 matching **receipt** 区分计划、draft、tool parameters 与真正发生的操作事实；
- 查看当前 spine、checkpoint、representation competition、projected depth 与上下文占用；
- 在 handoff 重复、竞争或失去唯一权威归属时，将它们 **rebase** 到最早安全基底；
- 在 travel 后同步持久会话树、下一轮模型上下文与 live AgentSession。

## 为什么需要它

长任务的问题不只是 token 数量。

即使每个阶段都做了局部摘要，summary 仍可能一层层堆在 active spine 上：

```text
root → summary A → summary B → summary C → current work
```

这些历史 handoff 会持续占用上下文和注意力。`pi-context` 把压缩视为智能本身：认知持续整合，显式 fold 批量��交。Agent 在 **compression seam** 用更好的 representation 替换旧过程，准确保留 uncertainty、attribution、hot set 与 provenance，并让每次 transition 的注意力收益足以摊销 tool latency、context rebuild、cache disruption 和 summary layer 成本。

## 三个工具

| Tool | 作用 |
|---|---|
| `acm_checkpoint` | 在 recoverability delta 出现时保存一个可返回的语义状态 |
| `acm_timeline` | 查看 active representation、checkpoint catalog、全文搜索、完整树和 projected depth |
| `acm_travel` | 在 compression seam 提交一次 batched fold，或把 competing handoffs rebase 为一个权威 representation |

扩展会通过 Pi 的公开 prompt hook 注入精简的 always-on CORE。CORE 是“道”：以 working set、representation、uncertainty fidelity、hot set、compression cadence、recoverability、continuation fidelity、sediment、thrash 与 anchor gravity 形成自主判断。工具合同和 advanced Skill 是“术”：按需披露七槽 wire format、target selection、isolated travel、archive rehydration 和异常 host 恢复。“度”由 attention yield 与 transition friction 的摊销关系决定，不规定固定工具轨迹或全局调用次数。项目的 ubiquitous language 见 [`CONTEXT.md`](CONTEXT.md)。

## Representation rebase

普通 fold 提交一个局部 representation update；rebase 处理 active handoff 的重复、冲突与 split authority。

Agent 在发现 representation competition 时，从最早候选开始检查 structural replacement 与 **continuation fidelity**：新的七槽 handoff 必须保存 hot set、faithful uncertainty、surviving fronts、invariants、evidence chains、external effects 与 recovery pointers，并让 fresh agent 无需重读被折叠过程即可继续当前 cognition。

Rebase 不等于强制跳到 `root`。Root 是最早的 structural candidate，不是默认答案；选择仍由 compression seam、branch topology 与 surviving state 决定。

Timeline 会提供事实证据：

- 当前 active summary depth；
- root structural candidate；
- 每个 checkpoint travel 后的 projected summary depth；
- usage、message count 与 branch topology。

Runtime 只报告 topology、usage 与 receipt fact，不伪装成能判断 representation quality、attention yield 或 continuation fidelity，也不会自动批准或执行 rebase。

## ACM 上下文占用提醒

扩展会在 active context 的 ACM working-budget pressure 首次进入 **30% / 50% / 70%** 档位时，通过 Pi 的 hidden custom message 向 agent 发送分级 ACM 提醒。工作预算按以下策略计算：

```text
workingBudgetTokens = min(contextWindow, 400K)
pressurePercent = activeTokens / workingBudgetTokens × 100
```

物理窗口不超过 400K 时沿用实际窗口；超过 400K 时统一使用 400K 工作预算。因此 200K、350K 模型的触发节奏不变，1M 模型在 120K / 200K / 280K active tokens 时分别触发 30% / 50% / 70%。真实 hard-window usage 仍单独保留，reminder details 与 `acm_timeline` dashboard 会同时展示 hard usage 和 ACM pressure，避免把工作预算误读成模型窗口容量。
- **30%**：持续整合认知，留意可形成 coherent representation update 的 compression seam；
- **50%**：检查 sediment、重复推理、competing handoffs，以及足以服务下一段工作的 representation delta；
- **70%**：优先形成携带 hot set、faithful uncertainty、provenance、external effects 与 executable `NEXT` 的最小权威 representation，并在下一处高收益 seam fold 或 rebase。

提醒对 agent 可见、在 TUI 中隐藏，并明确不是用户的新要求。Pressure 会提高 attention gain 的价值并缩短合理 cadence，但不会把每个 action 变成 travel。Agent 仍需让每次显式 fold 被后续工作摊销，避免 sediment，也避免 tiny-delta refold、immediate recall 和 reread 形成 compression thrash。

同一上下文周期只提醒更高的新档位：普通 usage 回落不会重新触发旧档。一次采样跨越多个档位时只发送当前最高档。只有明确成功的 `acm_travel` 或 Pi 原生 compaction 才开启新周期；transition 后先用下一次真实 LLM prompt usage 建立无提醒基线，再继续观察后续增长。Session resume/reload 会从 active branch 中已持久化的 ACM reminder 恢复本周期最高档位，不会仅因重载而重复提醒。

## `/context` 面板

Pi 版本保留独有的 `/context` 命令，用于查看当前上下文的分类占用、校准后的 token 估算和 compaction-aware 消息构成。该面板仅在 TUI mode 可用；RPC、JSON 与 print mode 会跳过 terminal UI。它是诊断界面，不会修改会话树。

## 安装

### 本地安装

```bash
pi install .
```

### GitHub

```bash
pi install git:github.com/KorenKrita/pi-context
```

也可以临时直接加载 source-first 入口。只加载 `src/index.ts` 时，Pi 会注册三个 ACM tools 和 always-on CORE，但不会读取该项目 `package.json` 中声明的 `/context` 扩展或 advanced Skill：

```bash
pi -e /path/to/pi-context/src/index.ts
```

若要让临时运行与 package 安装暴露相同的资源，请显式加载两个 extension 和 skills 目录：

```bash
pi -e /path/to/pi-context/src/index.ts \
  -e /path/to/pi-context/src/context.ts \
  --skill /path/to/pi-context/skills
```

安装后无需手动调用命令。Agent 默认有权依据 integrated doctrine 自主 checkpoint、timeline、travel、rehydrate 与 rebase；只有用户明确表示接下来不要 travel，才在该语义范围内暂停 travel，checkpoint 和 timeline 仍可用。

## 可观察性与恢复

每次操作都会返回可核对的结构事实：

- resolved target 与 entry ID；
- checkpoint aliases；
- branch summary leaf；
- backup checkpoint outcome；
- message、token、percentage-point 与 summary-depth delta；
- persistent context rebuild 和 live AgentSession sync 状态；
- 与 tool call ID 对应的 machine-readable `ACM_RECEIPT`：`outcome`、`mutationState`、`workingSetState`。

Checkpoint 名称在整棵会话树中大小写敏感且必须唯一；同一节点可以拥有多个 alias。每个 ACM tool result 都会在 provider-visible content 与 structured details 中附同一份 receipt。调用参数、draft 和 assistant 自述只代表 intent；只有 matching receipt 能证明 mutation 是 `applied`、`not_applied` 还是 `indeterminate`，避免把未知状态伪装成成功或失败。

## 安全边界

- Travel 只改变 Pi 会话树和后续模型上下文。
- 它不会回滚文件、进程、浏览器、Git commit 或远端服务。
- 扩展不会取消、替换或延迟 Pi 原生 compaction。
- 未解决的问题同样可以被压缩；handoff 必须以 uncertainty fidelity 保留 hypotheses、attribution gaps、discriminators、hot details 与 provenance，而不是把 unknown 伪装成 conclusion。
- Host 不支持 live synchronization 时，持久 branch 和公开 context rebuild 仍然保留；结果会给出明确恢复指引。

## 验证

Pi 的 git package 安装路径使用 npm，因此根目录以 `package-lock.json` 作为依赖复现契约；测试与 source build 使用 Bun。CI 固定 Node `24.16.0`、npm `11.13.0` 和 Bun `1.3.14`。

```bash
npm ci --ignore-scripts
bun run verify:acm
```

`bun test` 只运行根目录 unit/guidance suite；`bunfig.toml` 会排除需要独立依赖与 source build 的 `test/host-fixture/`。完整 gate 会依次检查 generated guidance、全部根测试、TypeScript，以及使用自身 frozen `bun.lock` 的真实 Pi `0.80.6` host fixture；该 fixture 还会通过 exact `ExtensionRunner` 加载 `/context` 并使用 exact `pi-tui` 渲染面板。

Focused checks：

```bash
bun test
bun run test:guidance
bun run typecheck
bun run test:host
```

非 CI 的开放式行为评测仍通过真实 mock ACM tool calls 观察模型行为。当前 core PR 先统一 doctrine、tool contracts 与 runtime guidance；compression quality、uncertainty fidelity、continuation fidelity、under-compression、sediment/thrash 和 acceptable cadence 场景将在后续评测更新中落地：

```bash
bun run eval:acm -- \
  --candidate local-openai/mimo-v2.5 \
  --judge local-responses/gpt-5.4-mini
```

评测场景、阈值与可选参数见 [`eval/README.md`](eval/README.md)。

开发架构、Pi host compatibility、版本升级流程和维护契约见 [`AGENTS.md`](AGENTS.md)。

## 致谢

- [pi-context](https://github.com/ttttmr/pi-context) — 原始项目 by ttttmr
- [让 AI 主动管理自己的上下文](https://blog.xlab.app/p/6a966aeb/) — 设计思路

MIT License
