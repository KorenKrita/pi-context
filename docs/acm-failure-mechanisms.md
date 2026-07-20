# ACM Failure Mechanism Registry v0

## 目的

本 registry 把真实使用与 eval 中观察到的坏结果还原为可单独验证的底层机制。现实任务无需完整复现；只有机制需要形成可控 analogue。

每项区分：

- **Confirmed** — 可由当前代码、host contract 或原始 event 直接证明；
- **Strong evidence** — 多个运行样本支持，但尚未完成隔离实验；
- **Hypothesis** — 合理解释，仍需单变量验证。

Registry 不直接规定生产行为。正确行为由 `docs/acm-judgment-contract.md` 决定。

## FM-01 — Free-form handoff DSL friction

**状态**: Confirmed interface friction; behavioral frequency has committed historical evidence

**现象**:
模型第一次调用 `acm_travel` 时可能因 `missing`、`empty`、`duplicate` 或顺序问题被拒绝。历史本地快照中，16 个 run 出现 invalid handoff，其中 15 个之后完成了成功 travel；该统计跨越多个旧版本，只用于证明失败形状，不代表当前生产率。

**底层机制**:
七字段结构被编码在一个自由字符串中。Validator 只接受从行首开始的精确英文 slot，并把冒号同行后的文本作为非空判断。自然的多行写法如 `Evidence:\n- ...` 被判为空；复杂 State 分成多个 `State:` 被判重复。

**可观察信号**:

- `details.error === "invalid_handoff"`；
- 首次 travel 失败，紧接着重试成功；
- validation 集中在 `empty Evidence`、`duplicate State`、missing optional-seeming slots。

**可控 analogue**:

- 同一语义分别使用单行 slot、header + bullets、重复 State block；
- 比较自由字符串与候选的结构化输入方式的首调用成功率；
- 保持模型、任务和 handoff 内容不变。

**正确性质**:
Agent-facing handoff 应允许自然表达需要保留的信息；机械格式不得成为首次 travel 的主要失败源。

**候选修复**:

- 结构化 handoff object；
- tolerant parser + canonicalization；
- 其他能够保持 future-self 信息质量的低摩擦接口。

**证据**:

- `src/lib.ts:40-70`
- `src/travel-tool.ts:77-82,172-183`
- `eval/evidence/invalid-handoff-summary.json`

## FM-02 — Checkpoint catalog clutter and ritual density

**状态**: Ritual density remains Strong evidence; catalog display layer resolved by entry grouping

**现象**:
存在 ritual checkpointing 与 checkpoint catalog clutter 的强行为证据；大量 alias 可能淹没 checkpoint view。单个 checkpoint 是否最终产生 recoverability 或 activation 价值，不能仅按本次 session 是否发生 timeline/travel 事后否定。

**底层机制**:
Checkpoint 调用成本低、参数简单，模型容易把 milestone 或“我做过一次 ACM”误当成独特恢复状态。Timeline 当前按 alias 逐项展示，同一 entry 的多个 alias 也分别占据结果。

**可观察信号**:

- 多个 checkpoint 没有形成不同的恢复、检索、baseline、fork 或 Activation Foothold 价值；
- 多个 alias 指向同一 entry；
- checkpoint view 的有效 candidate 被旧 alias 排挤。

**可控 analogue**:

- 固定一棵 session tree，让 N 个 alias 指向同一 entry、K 个 alias 指向不同 entry；
- 固定 checkpoint view 的 `limit`，检查不同 entry 的候选是否仍可见；
- 比较按 alias 展示与按 entry 聚合，并断言 filter/search 仍覆盖全部 alias。

**正确性质**:
Checkpoint 保持自由、在判断层近似免费、无全局配额。新 checkpoint 至少具有未来返回、baseline/fork、检索或 Activation Foothold 价值之一；catalog clutter 作为独立展示问题解决。

**Catalog 解决方式**:
Checkpoint view 以 target entry 为配额与估算单位；同 entry aliases 聚合，单行只命名 filter 命中或最新 alias，并报告其他 alias 数。Machine-readable details 分开记录匹配 aliases、entry 上全部 aliases、展示 entries 与实际命名 aliases；历史 alias-only details 保持可渲染。

**证据**:

- `src/timeline-tool.ts:72-102,342-402`
- `eval/PHASE7-LOG.md`
- `eval/PHASE8-LOG.md`

## FM-03 — ACM Skill unavailable in the evaluation environment

**状态**: Bare eval unavailable and current full-env snapshot unavailable: Confirmed

**现象**:
Bare eval 明确禁用全部 Skills；2026-07-20 固化的当前 full-env harness `get_commands` 快照包含 52 个 Skill commands，但没有 `skill:context-management`。历史 event 中也没有该 Skill 或 references 的读取记录。

**底层机制**:
Bare mode 使用 `--no-skills`。Full-env mode 删除已安装的 `pi-context` package，只用 `-e src/index.ts` 注入 extension；该加载方式不会带入 package manifest 声明的 `skills/`。

**可观察信号**:

- RPC `get_commands` 不包含 `skill:context-management`；
- event log 没有 Skill 路径读取；
- run 被用于评价 advanced behavior，却没有记录 `skillAvailable`。

**可控 analogue**:

- 分别启动 core-only、ACM-product-isolated、production-full-env；
- 启动时断言 Skill discovery；
- 在相同 advanced scenario 下比较 Skill available/unavailable。

**正确性质**:
任何关于 progressive disclosure 的实验结论都必须先证明 Skill 实际可用。Skill unavailable 与模型选择不读取必须分开记录。

**证据**:

- `package.json:43-50`
- `eval/driver.mjs:37-54`
- `eval/setup.mjs:63-109`
- `eval/evidence/full-env-skill-discovery.json`

## FM-04 — Progressive-disclosure pointer miss

**状态**: Confirmed pointer/level mismatch; user-reported production non-use; causal explanation is Hypothesis

**现象**:
用户报告真实使用中 agent 很少主动加载 advanced Skill。当前接口可以确认 pointer 名称、触发层级与双跳读取存在摩擦，但尚未隔离这些因素各自对 production non-use 的因果贡献。

**底层机制**:
Available Skill 名称是 `context-management`，运行时 cue 却使用 `Advanced Target Selection` 等内部 reference 标题。Skill description 又以“CORE 无法完成判断”为内省门槛，并要求 router → reference 两次自愿读取。

**可观察信号**:

- cue 出现但没有读取 `context-management/SKILL.md`；
- 已读取 router 但未读取 matching reference；
- advanced case 发生时，available Skill description 与运行时 leading words 不一致。

**可控 analogue**:

- 比较当前 pointer、exact Skill-name pointer，以及明确定义为“在 loaded Skill 存在时注入其 exact name/path”的 discovery bridge；
- 分别测试普通路径、ambiguous target、archive round trip、exceptional outcome；
- 记录 false positive 与 advanced-path miss。

**正确性质**:
Advanced guidance 在真正需要时应可被可靠发现，同时保持普通路径轻量；由 model pull、runtime push 还是混合 routing 实现仍是开放设计问题。

**证据**:

- `skills/context-management/SKILL.md:1-16`
- `src/lib.ts:73-80`
- `skills/context-management/TOOL-CONTRACTS.md`
- `writing-great-skills/GLOSSARY.md` 的 Context Pointer 定义

## FM-05 — In-flight target survives as an unfinished old task

**状态**: Confirmed structural hazard; stale-task replay causality is Hypothesis with observed examples

**现象**:
用户报告过 post-travel 重放旧任务；当前代码确认 in-flight/dangling target 可以保留未闭合旧请求与工具序列。现有 committed eval evidence 尚未证明两者直接关联，也未确认相关样本的 Goal/NEXT 均正确。

**底层机制**:
`branchWithSummary(target, ...)` 保留 target 与全部祖先。当前 meaningful-entry 规则可能把包含普通 tool calls、但尚无可见最终回答的 assistant turn 作为 checkpoint/target。Context sanitation 还会为被截断的 tool calls 合成 interrupted results。

**可观察信号**:

- target assistant 的 `stopReason === "toolUse"` 或包含 tool calls；
- surviving prefix 的最后一个 USER 请求尚未得到 closed assistant answer；
- post-travel 第一项动作重做旧请求，而不是执行 handoff `NEXT`。

**可控 analogue**:

- 同一 handoff 分别 target closed assistant、dangling user、in-flight assistant；
- 断言真实 LLM-bound messages；
- 比较 wrong-task replay 与 first-action alignment。

**正确性质**:
候选安全性质是让普通 fold/rebase 使用 continuation-safe boundary；采取 hard rejection、warning 还是其他机制仍由后续实验决定。

**证据**:

- `src/lib.ts:382-449`
- `src/tool-protocol.ts:36-115`
- `node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js:991-1007`
- `eval/PHASE8-LOG.md`

## FM-06 — Archival branch-summary framing lacks explicit continuation authority

**状态**: Confirmed host framing and loss of transient receipt; task-authority competition is Hypothesis

**现象**:
Pi 的真实 post-travel packet 采用 archival summary framing，并且 transient travel result 不属于 rebuilt branch。该 framing 是否直接造成模型继续或重放旧请求，是待隔离的行为假设。

**底层机制**:
Pi 把 `branchSummary` 转成 user message，并加固定 archival prefix：`The following is a summary of a branch that this conversation came back from:`。Travel result cue 不属于 rebuilt active branch；live replacement 后不能作为后续持久 continuation authority。

**可观察信号**:

- post-travel context 包含一个或多个 archival-prefix user messages；
- target 是旧 `branch_summary`，形成 summary competition；
- tool result 中要求执行 NEXT，但下一轮 LLM-bound messages 不包含该 receipt；
- sync 状态为 applied，行为仍回到旧任务。

**可控 analogue**:

- archival summary only 与 authoritative continuation message A/B；
- closed target、old-summary target、clean-base target 对照；
- 比较 first useful action、stale-task replay、resume latency。

**正确性质**:
用户已确认的目标性质是：post-travel context 让未来自己把 handoff 作为权威信息并直接继续。采用何种 continuation representation 仍需实验。

**证据**:

- `node_modules/@earendil-works/pi-agent-core/dist/harness/messages.js:7-11,78-83`
- `src/live-agent-session-adapter.ts:287-309`
- `test/host-fixture/travel-live-sync.test.ts:216-222`

## FM-07 — Current obligation lost in Goal/NEXT

**状态**: Historically confirmed behavior; current mechanical gap confirmed; v4.1 guidance mitigation demonstrated

**现象**:
历史样本中，handoff `State` 已包含当前答案，但 `Goal` 或 `NEXT` 写成“无待办”“等待下一请求”，travel 后模型没有交付。v4.1 已显著缓解该行为回归，但 runtime 仍只验证 shape，不验证当前义务语义。

**底层机制**:
当前 handoff 结构只校验 slot 形态，不校验当前用户义务是否仍在 Goal/NEXT 中。模型可能把“已经知道答案”误判成“已经向用户完成交付”。

**可观察信号**:

- pre-travel 用户问题未获得可见答案；
- State 包含答案；
- Goal/NEXT 否认或遗漏当前义务；
- post-travel agent 等待、总结或开始其他工作。

**可控 analogue**:

- 保持 State 相同，仅改变 Goal/NEXT 是否携带当前义务；
- 比较用户问题交付率；
- 将“知道”与“已经交付”作为独立状态。

**正确性质**:
Trusted Handoff 必须区分内部已知状态与用户已收到的交付。未来自己信任 handoff，因此当前义务必须在 handoff 中被准确表示。

**证据**:

- `src/lib.ts:40-70`
- `eval/PHASE9-LOG.md`
- `eval/PHASE10-LOG.md`

## FM-08 — Pressure reminder carries a travel-permission gradient

**状态**: Confirmed action-oriented wording; user-reported harmful behavior; direct causality remains Hypothesis

**现象**:
模型在当前工作尚未形成高质量 Compression Candidate、义务仍在进行或 target 尚不安全时，因为 30%/50%/70% reminder 急于 travel。

**底层机制**:
Reminder 文案明确包含 fold/rebase/travel action gradient，这是代码事实。用户报告 signal-dependent 模型会把 pressure crossing 当作行动许可；该文案与 premature travel 的直接因果仍需 A/B 隔离。

**可观察信号**:

- first travel 紧跟 reminder；
- handoff/target 质量低于模型无 pressure 时的选择；
- current obligation 尚未交付；
- post-travel rework 或 wrong-task rate 上升。

**可控 analogue**:

- 相同 context 下比较无 reminder、judgment-only reminder、action-oriented reminder；
- 分别测低 pressure 高 clutter 与高 pressure 低 clutter；
- 观察 move selection 与 task outcome，而非只看激活率。

**正确性质**:
Pressure 是重新执行 ACM Judgment 的信号，不自动增加某个 move 的正当性。是否行动仍由 Compression Candidate、Compressibility 与净效果决定。

**证据**:

- `src/context-usage-nudge.ts:146-188`
- `eval/PHASE5-LOG.md`
- `eval/PHASE7-LOG.md`
- `eval/PHASE10-LOG.md`

## FM-09 — Low-yield transition followed by immediate reread

**状态**: Strong evidence

**现象**:
Travel 只移走很小一段上下文，或 handoff 未保留下一步需要的信息；模型随后重新读取刚刚 fold 的材料。

**底层机制**:
Move 以“发生过 fold”或 target 技术合法为成功标准，没有比较 Representation Gain、Transition Cost 与预期 reread。近 HEAD target、微小 delta 与不完整 hot set 都会产生负收益。

**可观察信号**:

- token/message delta 很小；
- post-travel 前几个工具调用重新读取 archive 内容；
- travel 数量多、每次 batch 很小；
- task latency 上升而 attention interference 未下降。

**可控 analogue**:

- 同一 raw trail 使用 near-HEAD、semantic-batch、deep-safe target；
- 记录 travel 后第一次 useful action 前的 reread 数与 token；
- 比较任务正确性和 stale-fact intrusion。

**正确性质**:
Travel 应产生足以覆盖 Transition Cost 的 Representation Gain；该 gain 可以来自多个噪声片段，也可以来自一次巨大上下文引入。Trusted Handoff 应让未来自己直接继续。

**证据**:

- `src/lib.ts:346-379`
- `src/travel-tool.ts:459-483`
- `eval/PHASE5-LOG.md`
- `eval/PHASE8-LOG.md`
- `eval/PHASE10-LOG.md:20-22`

## FM-10 — Guidance sediment and opposing action gradients

**状态**: Strong evidence for non-monotonic prompt behavior; model-psychology explanation is Hypothesis

**现象**:
为修复一个模型或一次 run 的失败不断追加条件后，部分模型更加保守、只 checkpoint 或完全不用，另一些模型则 overfold。

**底层机制**:
Additive patching 同时积累“更主动”和“更谨慎”的指令，这是可审计的演化事实。强模型可能利用未满足条件选择 no-op、弱模型可能抓住最便宜动作或忽略抽象 doctrine；这些心理机制仍是假设。No-op 与 leading-word 效果具有模型相对性。

**可观察信号**:

- prompt 版本语义更完整但工具行为下降；
- 单模型单样本驱动下一版句子；
- 同一句 cue 对不同模型产生 zero-use 与 overuse 两种结果；
- 长度增长主要来自修复历史 phenotype。

**可控 analogue**:

- 固定 runtime/API，只比较 current control、pruned kernel、单一 leading-word variant；
- 每次实验只改变一个可归因变量；新增、替换或删除均按 Effect First 评价；
- n≥3，跨 task shape 比较 task outcome 与 justified-use rate。

**正确性质**:
Guidance 遵循 Effect First：按实际行为保留内容，不受固定长度预算约束，也不因“加一句更安全”而默认追加。每个概念只有一个 owner。

**证据**:

- `eval/PHASE6-LOG.md`
- `eval/PHASE8-LOG.md`
- `eval/PHASE9-LOG.md`
- `skills/context-management/CORE.md`

## FM-11 — Timeline candidate rebuild failure appears as zero messages

**状态**: Confirmed; resolved by preserving the candidate build outcome

**现象**:
Checkpoint view 中某个 candidate 的 message rebuild 失败时，结果仍可能显示 `~0 msgs` 和基于空数组的 usage estimate，误导 target 判断。

**底层机制**:
Candidate loop 把 failed `buildSessionMessages()` 替换为空数组；root candidate 对相同失败则正确显示 estimate unavailable。

**可观察信号**:

- host rebuild failure；
- candidate 输出 `~0 msgs`；
- root 与 checkpoint candidate 对失败采用不同呈现。

**可控 analogue**:

- 需要先提供最小测试 seam：提取纯 formatter/estimate helper，或构造 current leaf 可 build、checkpoint leaf 转换失败的 malformed fixture；
- 断言结果显示 unavailable 且不生成 usage estimate。

**正确性质**:
Timeline 只报告可观察事实。未知必须保持未知，不得伪装成零。

**解决方式**:
Checkpoint candidate cache 使用 `{ ok: true, messages } | { ok: false }`，同一 entry 的 aliases 复用相同结果；只有成功构建才计算 message/usage estimate，失败显示 `message estimate unavailable`。

**证据**:

- `src/timeline-tool.ts:362-400`

## FM-12 — Model avoidance of meta-context mutation

**状态**: Hypothesis

**现象**:
即使工具可用且 guidance 明确，部分强弱模型仍持续避免 travel；加强静态文字后激活没有单调提升。

**可能机制**:

- 修改自身后续上下文不属于常见 external-tool prior；
- travel 的风险立即可见，收益延迟出现；
- `compression`、`fold away` 等 leading words 可能激活有损信息 prior；
- 当前真实的 handoff、target 与 continuation 失败使保留全部上下文成为合理策略。

**可观察信号**:

- 模型能正确解释 ACM，但不调用；
- exact actionable cue 仍不行动；
- 修复 transition safety 后使用意愿发生变化；
- alternative leading-word framing 改变 move selection。

**可控 analogue**:

- 保持工具行为相同，比较 compression-first 与 reversible-navigation framing；
- 保持 prompt 相同，比较 unsafe 与 mechanically safe travel contract；
- 区分 recognition、decision、execution、continuation 四阶段。

**正确性质**:
产品应让正收益 move 的收益和可恢复性足够可信，同时不以提高调用频率掩盖有害 transition。该假设只有经隔离实验后才能进入 guidance 决策。

## FM-13 — Raw backup bookmark lands on a protocol-incomplete prefix

**状态**: Confirmed structural behavior; replay impact is Hypothesis

**现象**:
`backupCurrentHeadAs` 可能把 raw recovery alias 放在一个旧 assistant tool-call turn，而不是该工具批次已经完成后的最深 leaf。之后恢复该 alias 时，真实 tool results 不在 active prefix 中，context sanitizer 会合成 `[Interrupted by context travel]`。

**底层机制**:
Travel backup 使用 `findLastMeaningfulEntry()`。该 resolver 跳过所有 `toolResult`，并把包含普通 tool calls 的 assistant turn 视为 meaningful。典型路径：

```text
user
assistant: read toolCall
toolResult: completed evidence
assistant: acm_travel toolCall
```

Backup resolution 跳过当前 internal-only travel turn 和 completed toolResult，最终选择前一个 `assistant: read toolCall`。

**可观察信号**:

- backup target 是 assistant `toolUse`；
- 其下一条原始 branch entry 是 matching toolResult；
- 恢复后 packet integrity receipt 包含 synthesized interrupted result；
- immediate projected packet 包含 duplicate/invalid tool-call identity；
- 模型重新执行旧工具或旧调查的行为需要进一步隔离验证。

**可控 analogue**:

- 构造完整 tool batch 后立即 travel；
- 比较当前 meaningful backup 与 immediate pre-travel projected packet；
- 恢复两种 alias，断言 LLM-bound packet 是否需要 protocol repair；
- 再用行为实验比较旧工具重放率。

**正确性质**:
Travel backup 保存的是可直接恢复的 raw continuation leaf。它应使用紧邻当前 travel call 之前的 leaf，并以该 leaf 的 compaction-aware projected packet 验证 protocol completeness；需要 repair 或包含 unrepairable defect 时阻止 travel，不静默回退旧状态。普通 checkpoint 的语义 target contract 保持独立。

**证据**:

- `src/travel-tool.ts:272-293`
- `src/tool-protocol.ts:36-213`
