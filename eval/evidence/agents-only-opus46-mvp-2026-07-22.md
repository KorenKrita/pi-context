# agents-only Opus 4.6：400K / 1M 长 dossier 顺序 MVP（2026-07-22）

> 本文是可审阅的 compact evidence 索引。逐事件记录、session、transcript、fixture manifest、oracle 和 judge artifact 保留在 `eval/.runs/`；机器可读的完整数字和路径见同名 JSON。

## MVP 结论

**这对顺序样本为该 long-dossier flow 提供了“上下文窗口存在实质性分歧、1M 候选优于 400K”的强证据；它不是跨模型、跨任务或总体因果证明。**

- **400K**：外层 deterministic verifier **12/14**；失败在 P6 的 **premature R2**（检查要求 perturbation 从精确 R1 起步，但它已经是 R2）和 README 缺少 required final operating-contract phrase。
- **1M**：deterministic verifier **14/14**，随后由 `local-claude/claude-opus-4-8`、high、`acm-outcome-v3` 判为 **overall 3/3，tier=strong，recoverability 2/3**。唯一记录的缺口是 P3 风险门禁前未显式 fork/baseline，未改变实际交付。
- 两臂都在 P6 有 **applied** `acm_travel`，所以 400K 仍是有效 mechanics 证据，不应被重写为“ACM 完全没有工作”。

## 严格 provenance 与唯一实验变量

| 维度 | 两臂共同事实 |
|---|---|
| flow / matrix / product | `saffron-cutover-long-flow-v1` / `agents-only-opus46-20260722T035025Z` / `f5318958` |
| seed | `733a9b979d49c386890f36b7a3af27a777476d44fe5bd12547ea4926069e47c6` |
| fixture / oracle | `2026-07-22.7`，fixture SHA-256 `4ea31b49…c93d98c8`，oracle SHA-256 `b10f018f…e653f0c` |
| prompt | 10 个 phase prompt hash 完全相同；两个 `saffron-manifest.json` 删除 `requestedContextWindow` 后完全一致 |
| model | `local-claude/claude-opus-4-6`，thinking `max`，`maxTokensCap=16000` |
| Pi | 精确 **0.81.1**，执行本 checkout 的 `node_modules/@earendil-works/pi-coding-agent/dist/cli.js` |
| agents-only | 真实 global `~/.pi/agent/AGENTS.md` 已复制进 harness；fixture project `AGENTS.md` 存在；只显式加载本 checkout 的 `src/index.ts`、`src/context.ts` 和 `skills/context-management/SKILL.md` |
| 环境排除 | `packages=[]`、global extensions/skills 均为空；排除了 ambient extensions、skills、themes、agents、MCP、prompt templates 和 `session-recall.json`；session-recall package/config 均 absent |
| **唯一实验变量** | **context window：400,000 vs 1,000,000**。两臂的 `workingBudgetTokens` 都是 400,000，因此 pressure policy 相同。 |

顺序执行产生独立的 timestamp、workspace、session/run directory 和 agent label；1M 在自身 verifier 成功后执行 judge，而失败的 400K 没有伪造一个可比较的 completed-flow judge。这是正确的 outcome integrity，不是隐藏的实验变量。

## 数字结果

| 指标 | 400K arm | 1M arm |
|---|---:|---:|
| Raw run | [`03-50-26…p50617`](../.runs/2026-07-22T03-50-26-359Z-flow-claude-opus-4-6-p50617/) | [`04-05-30…p63099`](../.runs/2026-07-22T04-05-30-547Z-flow-claude-opus-4-6-p63099/) |
| Report status | `verification_failed` | `completed` |
| deterministic verifier | **12/14** | **14/14** |
| 失败 | P6 premature R2；README final phrase | 无 |
| 耗时 | 902,983 ms | 743,439 ms |
| tool calls | 78 | 70 |
| ACM calls | 1 checkpoint，1 travel | 3 checkpoints，1 travel |
| peak active tokens | 274,348 | 270,304 |
| peak hard usage | 68.587% | 27.0304% |
| peak pressure | 68.587% | 67.576% |
| P7 post-travel peak tokens | 29,723 | 13,855 |
| P7 post-travel hard usage | 7.43075% | 1.3855% |
| judge | 不执行（verifier 未通过） | Opus 4.8/high：overall **3**、strong；activation/timing/handoff/ceiling/task **3**，recoverability **2** |

`hard usage` 的分母不同，不能与 1M 的 hard percentage 作直接压力比较；两臂对齐的判断尺度是 `workingBudgetTokens=400K` 下的 `pressure`，P6 分别是 **68.587%** 与 **67.576%**。

## P6 travel receipt：两臂都验证 mechanics

| receipt 字段 | 400K | 1M |
|---|---:|---:|
| target / resolution | `saffron-initial-audit-complete` / checkpoint | `root` / root |
| backup | `evidence-ledger-classified`，created | `evidence-packet-raw-processed`，created |
| mutation / evidence | `applied` / `verified` | `applied` / `verified` |
| protocol | `repaired` | `complete` |
| handoff | `structured-v1`，3,188 chars | `structured-v1`，2,490 chars |
| active tokens | 269,779 → 7,384 est. | 268,755 → 956 est. |
| token delta | −262,395 | −267,799 |
| context delta | −65.59875 pp | −26.7799 pp |
| structural messages | 89 → 28 (−61) | 85 → 1 (−84) |
| summary depth | 0 → 1 | 0 → 1 |
| settled delivery | `pending_run_settle`，same run preserved | `pending_run_settle`，same run preserved |

两个 receipt 均证明 branch mutation、backup、structured handoff、summary-depth update 和 post-settle refresh/delivery scheduling 成功。最终差异来自随后任务链的 outcome，而非“有无 travel”。

## Outcome-first 解读

不以 ACM 调用次数、travel token delta 或表面压缩率替代交付结果：

1. 400K 有真实成功 travel，也在 P7 降到 29,723 tokens；但 outer verifier 直接抓到**错误的 P6 R1/R2 时序**和**README contract phrase**缺失，故为 12/14。
2. 1M 在同一 flow 中把 P6 压缩后工作集接续到 fresh control-plane 复查、HOLD、legal exclusion 和 README contract，内层 verifier 14/14；ordered transcript 的 Opus 4.8 judge 也确认没有 stale replay、遗漏或 thrash。
3. 因此本 MVP 的 claim 是该长 dossier 的 candidate superiority，而不是 “1M 总是更好” 或 “400K 没有 ACM mechanics”。

已有 **full-env** attempts 不进入本结论：它们混入了环境校准变量，只能作为 calibration-only 资料，不能替代这里 agents-only same-seed pair 的证据。

## 顺序扩展计划

1. 用 **Claude Opus 4.8** 在相同 agents-only、same seed、same fixture/prompt、400K/1M 契约下完成独立顺序 pair。
2. 再按相同契约完成 **GPT-5.6 Terra** pair。
3. 最后按相同契约完成 **GPT-5.6 Sol** pair。
4. 每个模型先走 MVP 再增加 repeats；每次保留 verifier、ordered outcome judge、travel receipt、provider/run error、环境 provenance，拒绝把 calibration-only full-env run 混进 pair verdict。

## Raw artifact 回链

- orchestration：[`400000.log`](../.runs/agents-only-opus46-mvp-2026-07-22T03-50-25Z-f5318958/400000.log)、[`1000000.log`](../.runs/agents-only-opus46-mvp-2026-07-22T03-50-25Z-f5318958/1000000.log)
- 400K：[report](../.runs/2026-07-22T03-50-26-359Z-flow-claude-opus-4-6-p50617/report.json)、[telemetry](../.runs/2026-07-22T03-50-26-359Z-flow-claude-opus-4-6-p50617/telemetry.json)、[events](../.runs/2026-07-22T03-50-26-359Z-flow-claude-opus-4-6-p50617/events.jsonl)、[manifest](../.runs/2026-07-22T03-50-26-359Z-flow-claude-opus-4-6-p50617/saffron-manifest.json)、[transcript](../.runs/2026-07-22T03-50-26-359Z-flow-claude-opus-4-6-p50617/transcript.txt)
- 1M：[report](../.runs/2026-07-22T04-05-30-547Z-flow-claude-opus-4-6-p63099/report.json)、[telemetry](../.runs/2026-07-22T04-05-30-547Z-flow-claude-opus-4-6-p63099/telemetry.json)、[events](../.runs/2026-07-22T04-05-30-547Z-flow-claude-opus-4-6-p63099/events.jsonl)、[manifest](../.runs/2026-07-22T04-05-30-547Z-flow-claude-opus-4-6-p63099/saffron-manifest.json)、[verdict](../.runs/2026-07-22T04-05-30-547Z-flow-claude-opus-4-6-p63099/verdict.json)、[transcript](../.runs/2026-07-22T04-05-30-547Z-flow-claude-opus-4-6-p63099/transcript.txt)
