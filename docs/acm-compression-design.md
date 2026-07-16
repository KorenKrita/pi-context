# ACM：压缩智能、道术度与自主调用

> 状态：PR14 后续设计方向
>
> 本文记录 2026-07-16 讨论形成的设计结论。它定义 Agentic Context Management（ACM）的目标心智模型、工具分工、压缩节奏和评测边界，不代表当前实现已经完成这些要求。

## 结论

ACM 的目标不是让 Agent 机械执行一条 `checkpoint → timeline → travel` 流程，而是让它真正理解上下文管理，并因此积极、自主地使用工具。

核心判断是：

> **Compression is intelligence.**
>
> **Compression is continuous; folding is batched.**
>
> **Cadence follows durable representation gain, not action count.**

中文表达：

> 压缩即智能。认知压缩持续发生，显式 fold 批量提交。压缩节奏跟随持久的表示增益，而不是操作步数。

Agent 应当积极调用 ACM，但这种积极来自对 working set、representation、recoverability、attention yield 和 compression cadence 的理解，而不是固定步骤、固定后缀、固定阈值或固定调用次数。

## 已确定的设计决策

### 1. Agent 默认拥有 ACM 自主权

**决策来源：user-decided。**

Agent 默认可以自主调用 `acm_checkpoint`、`acm_timeline` 和 `acm_travel`。

只有用户明确表示**接下来不要 travel**时，才在该指令所覆盖的下一次响应或上下文转换中禁止 `acm_travel`。其他表达不构成 travel 授权门槛：

- 用户没有主动要求 travel，不代表禁止 travel；
- 用户没有明确批准某份 handoff，不代表 Agent 必须等待；
- 只要求 draft、分析或方案本身不自动禁止 travel；只有语义明确等同于“接下来不要 travel”时才暂停；
- travel 暂停期间，checkpoint 和 timeline 仍然可用；
- 禁止范围结束后，Agent 恢复默认自主权。

工具调用仍然只是 request，matching tool result 才是 receipt。自主权决定 Agent 是否可以发起请求；receipt 决定请求实际上是否 applied、not applied 或 indeterminate。两者不能混为一谈。

### 2. 保留七槽 handoff 外壳

**决策来源：user-decided。**

`acm_travel` 继续使用稳定的七槽 wire format：

```text
Goal:
State:
Evidence:
External:
Exclusions:
Recover:
NEXT:
```

七槽是跨工具、运行时和模型的稳定传输外壳，不是任务完成状态机。

`State` 可以表达进行中的认知状态，包括但不限于：

- 已知事实与已验证结论；
- 尚未解决的未知项；
- competing hypotheses；
- attribution、baseline、delta 与因果关系；
- 接下来会直接复用的 hot details；
- 判别假设所需的 discriminator；
- active 或 parked fronts；
- 当前 representation 相对旧过程发生的实质变化。

Handoff 不要求任务完成、阶段关闭或不确定性归零。它只要求新的 representation 足以让 fresh agent 继续当前认知过程。

### 3. 替换保守语义

**决策来源：user-decided。**

以下 PR14 语义会把弱模型推向保守不行动，应当替换：

| 当前语义 | 问题 | 新语义 |
|---|---|---|
| active uncertainty 必须保留 raw detail | 把“不确定”错误等同于“原始 token 必须常驻” | **uncertainty fidelity**：准确压缩未知、假设、证据和判别动作 |
| closed boundary 才能 fold | 把 fold 限制为阶段完成后的归档 | **compression seam**：任何可被更好 representation 替换的切面 |
| cold start | 容易被理解为任务已完成、NEXT 已完全确定 | **continuation fidelity**：fresh agent 能继续当前认知过程 |
| no premature travel | 以时机禁止替代压缩质量判断 | attribution integrity、task sufficiency、provenance 与 attention yield |
| Hold raw evidence | 鼓励上下文沉积 | 压缩 evidence chain，同时保留 sufficient statistics 与 direct pointers |

不存在抽象意义上的“过早 fold”。存在的是：

- 错误归因；
- 把未知压成已知；
- 丢失 task-relevant information；
- 丢失 baseline、delta 或因果链；
- 缺少 provenance 和 recoverability；
- 没有形成更好的 representation；
- fold 后立刻 recall 或 reread，产生 compression thrash。

## 道：Agent 应理解什么

### Working set 是认知表示，不是聊天记录

Working set 应承载下一段推理最有价值的 representation：

- settled knowledge；
- faithful uncertainty；
- 当前约束和外部状态；
- 下一步会直接复用的 hot set；
- 被压缩材料的 provenance；
- 一个可执行的 NEXT。

判断一段内容是否应该原样保留，不应只问“问题解决了吗”，而应问：

> 它是否仍是下一段推理所需的最佳表示？

### Compression is intelligence

Agent 在每次观察、比较、实验和决策后，都应持续进行认知压缩：

- 从文件和日志中提取结构；
- 从多个观察中形成已知与未知；
- 从冲突报告中形成 competing hypotheses；
- 从实验中形成 attribution、baseline 和 delta；
- 从失败方向中提取 exclusion 与仍然有效的证据；
- 从过程叙述中形成下一步可用的状态。

显式 travel 不是压缩的开始，而是把已经形成的 representation 提交为新的 working set。

### Uncertainty fidelity

不确定性本身就是可压缩的认知对象。

例如两个结论冲突时，新的 representation 应保留：

- 假设 A 与假设 B；
- 各自证据与反证；
- 尚未归因的关键变量；
- 能区分假设的 discriminator；
- 下一步验证动作；
- 原始报告的恢复入口。

压缩不能伪造确定性，但也不需要让完整原始报告持续占用 working set。

### Recoverability 使压缩可以大胆而可逆

Checkpoint 不是仪式，也不是 fold 的结束标记。它保存一个具有新返回价值的状态，使 Agent 可以大胆探索、压缩和分叉。

Recoverability 应当降低 Agent 对信息丢失的恐惧，而不是成为 travel 的审批门槛。

## 度：压缩 cadence

理论上，认知可以一步一压；工程上，每次显式 `acm_travel` 都有成本：

- tool use 和延迟；
- context reconstruction；
- 可能的 prompt-cache disruption；
- 未缓存 reread 成本；
- 新 summary layer；
- 后续 rehydration 风险；
- 对连续推理体验的打断。

因此：

> **认知压缩持续发生，显式 fold 按 semantic batch 提交。**

### Fold 跟随 representation delta

一次显式 fold 应当对应一个 coherent、material、durable 的 representation update，例如：

- broad scan 收敛为候选模块和排除项；
- 多份日志被归因为一条时间线；
- agent fan-out 被压缩为假设图和判别动作；
- 实验改变了当前问题模型；
- 大量探索过程可由更短、更精确的状态替代；
- 旧解释开始重复、过期或争夺注意力。

没有形成实质 representation delta 时，Agent 仍应持续提炼，但可以先积累为 semantic batch，而不是为微小变化支付一次 travel 成本。

### Checkpoint 跟随 recoverability delta

Checkpoint 应在返回价值发生实质变化时创建，例如：

- baseline 已验证；
- 一个高价值 fork 即将开始；
- 风险尝试前出现稳定返回点；
- 一个 front 即将 park；
- 当前成果形成耐久里程碑。

同一返回状态仍然有效时，可以继续复用已有 checkpoint，不需要一步一个。

### Carry the hot set

一次 fold 可以同时压缩 integrated process，并把未来几步会直接复用的精确内容带入新 handoff。

Working set 中的信息可以按用途理解：

| 类别 | 处理方式 |
|---|---|
| Hot | 下一段推理会直接复用；原样或低损携带 |
| Integrated | 已形成结构、归因或结论；压缩为 representation |
| Archived | 当前不需精确读取；保留 provenance 和 recovery pointer |

Fold 不必等待所有内容变冷。选择性压缩可以保留 hot details，同时让 integrated 和 archived process 退出注意力中心。

### Amortize every transition

一次好的 fold 应当被后续一段推理的注意力收益所摊销：

```text
fold value
≈ durable attention gain
− tool and latency cost
− cache disruption
− expected rehydration cost
− representation-management cost
```

这是一种语义判断，不要求运行时计算固定分数。

### Sediment 与 thrash

压缩 cadence 的两个失败极端是：

**Context sediment**：

- 更好的 representation 已经形成，raw process 仍长期占用 working set；
- 已完成、重复或被推翻的推理持续竞争注意力；
- Agent 能说出结论，却不主动更新上下文。

**Compression thrash**：

- 每个微小 tool result 后都 travel；
- 两次 fold 之间没有实质 representation delta；
- fold 后立即 recall 或 reread 刚移出的内容；
- handoff 不断微调，却没有持久 attention gain；
- tool latency、summary churn 和 cache cost 超过收益。

Healthy cadence 位于两者之间：按 semantic batch 积极压缩，每次 transition 都形成足够持久的注意力收益。

不同模型可以选择不同粒度。项目不规定全局 fold 次数，只要求行为落在可接受范围内。

## 术：工具如何服务道与度

### `acm_checkpoint`

作用：保存具有新 option value 的 return state。

调用倾向：积极，但跟随 recoverability delta，而不是每个任务步骤。

Checkpoint 名称是恢复线索，不是状态分类器。`-start`、`-done` 等后缀可以帮助人类检索，但不能驱动 runtime 或 Agent 状态判断。

### `acm_timeline`

作用：恢复 situational awareness：

- 当前 authoritative representation 在哪里；
- 哪些 checkpoint 可恢复；
- 哪些 summary 发生竞争；
- target 是否处于正确 ancestry；
- 哪些 front active、parked 或 archived。

Timeline 提供事实，不替 Agent 判断 representation quality 或 cadence。

### `acm_travel`

作用：提交一次 batched representation update。

Travel 可以发生在 investigation 中途、存在不确定性时或任务尚未完成时，只要 handoff：

- 忠实表达当前认知状态；
- 保留 hot set；
- 保留 evidence chain 的 sufficient statistics 和 provenance；
- 使 NEXT 可执行；
- 具有 continuation fidelity；
- 预期带来持久 attention gain。

Travel 必须继续独占 assistant tool batch，这是 host mutation 的硬约束，不是认知工作流。

### Rebase

Rebase 处理 representation competition，而不是限制普通 fold。

当 handoff layers 重复、互相竞争或让同一 front 失去唯一权威状态时，Agent 应把 surviving state 合并成一个 authoritative representation。目标选择仍由 ancestry、representation ownership 和 continuation fidelity 决定；root 只是候选。

### Receipt

每个工具调用都是 request；matching result 是唯一 operation fact。

Receipt 必须继续暴露：

- `toolCallId`；
- `outcome`；
- `mutationState`；
- `workingSetState`。

Renderer 必须区分 applied、not applied 和 indeterminate。Agent 的自主调用权不能削弱 receipt discipline，receipt discipline 也不能变成用户授权门槛。

## 评测方向

评测不能锁定精确工具顺序或全局调用次数。它应同时发现 under-compression 和 over-compression。

### 压缩质量

- **Task sufficiency**：所有可能改变后续判断的信息仍然存在于 representation 或 direct pointer 中；
- **Uncertainty fidelity**：未知仍然是未知，竞争假设和 discriminator 没有丢失；
- **Attribution integrity**：baseline、delta、因果链和反事实仍可检查；
- **Provenance**：精确证据可恢复；
- **Continuation fidelity**：fresh agent 能继续当前认知过程；
- **Attention gain**：新的 working set 明显更清晰、更紧凑、更适合后续推理。

### 调用积极性

应验证 Agent 能在没有显式工具暗示时自主发现：

- 值得 checkpoint 的 recoverability delta；
- 值得 fold 的 representation delta；
- 需要 rebase 的 representation competition；
- 需要 rehydrate 的精确证据缺口。

### Cadence 范围

同一长任务中，模型 A 可能用两次较大 fold，模型 B 可能用四次较细 fold；两者都可以通过。

不可接受的是：

- 形成明显新 representation 后始终不 fold；
- 每一步都 travel；
- fold 后立即重新读取本应作为 hot set 携带的内容；
- 依靠固定后缀、固定阶段名或固定 tool trace 才能行动。

评测应使用不同任务结构、措辞、模型能力和上下文压力，判断是否处于合理行为区间，而不是证明某一条轨迹唯一正确。

## 必须保留的工程硬约束

新的哲学不改变以下运行时事实：

- 七槽 handoff 外壳继续由 runtime 验证；
- travel 必须独占 assistant tool batch；
- checkpoint alias 仍然 tree-wide、case-sensitive 且唯一；
- target 必须可解析并位于正确 ancestry；
- mutation 必须经过 Host Bridge 并验证真实结果；
- travel 后仍需 persistent context rebuild 和 live AgentSession synchronization；
- 每个工具结果仍需 matching structured receipt；
- public tool schemas 不增加 required execute flag；
- runtime 不以 checkpoint 后缀、固定阶段或固定调用顺序推断语义状态。

## 非目标

本设计不会：

- 恢复 mandatory task-start preflight；
- 恢复固定 transition table；
- 规定每个 phase、tool result 或 token tier 必须调用什么；
- 规定全局 checkpoint 或 fold 次数；
- 用 `-start`、`-done` 等后缀充当状态机；
- 要求用户逐次批准 travel；
- 把 context pressure 作为 travel 的自动许可或禁止；
- 把 native compaction 当作 ACM 判断的替代品；
- 宣称任何一版提示词已达到理论极限。

## 项目一体化要求

最终实现必须让以下层次表达同一个系统，而不是各自拥有一套政策：

- `skills/context-management/CORE.md`：道与度的 always-on canonical doctrine；
- `skills/context-management/TOOL-CONTRACTS.md`：工具 invocation、prompt metadata、result cues 和 recovery mechanics；
- `skills/context-management/SKILL.md` 与 references：只按需披露高级术；
- `src/generated-guidance.ts`：由 canonical Markdown 生成；
- checkpoint、timeline、travel 和 context nudge：共同强化 representation、cadence、recoverability 与 receipt；
- `CONTEXT.md`、README、AGENTS 和 implementation notes：使用同一 ubiquitous language；
- deterministic tests：验证单一真源、硬契约和生成一致性；
- model behavior eval：验证自主压缩、压缩质量和可接受 cadence，而不是精确 trace。

最终目标不是“调用越多越好”或“调用越少越安全”，而是：

> Agent 因理解压缩智能而积极管理上下文，因理解 compression cadence 而避免工具 thrash，并因 recoverability、provenance 和 receipt 保持整个过程可逆、可验证、可信。
