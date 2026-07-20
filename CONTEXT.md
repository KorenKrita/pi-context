# Agentic Context Management

`pi-context` 管理 agent 对会话历史的注意力分配。本文件只定义领域语言；`docs/acm-judgment-contract.md` 是判断语义的 canonical source，`skills/context-management/CORE.md` 是其面向模型的投影，`TOOL-CONTRACTS.md` 只拥有工具 mechanics 与调用时 guidance。

## Language

**ACM Judgment**:
Agent 使用同一套价值判断过程，决定继续工作或采用 checkpoint、timeline、travel；过程应可预测，具体动作随语境变化。
_Avoid_: Trigger rule, transition table, mandatory workflow

**Attention Value**:
一段上下文对当前与可预见后续推理的实际贡献，包括决策信息、未决不确定性、hot set 与直接 evidence pointers。
_Avoid_: Token value, context size

**Compression Candidate**:
低 Attention Value、高噪声，并且已有或能够形成显著更简练表示的一段上下文。
_Avoid_: Old messages, large context, completed phase

**Representation Gain**:
新 working set 相比原始过程减少注意力竞争、同时保留未来决策所需信息的净改善。
_Avoid_: Token reduction, compression ratio

**Recovery Option Value**:
未来返回某个语义状态可能节省的工作、保护的 baseline 或支持的探索选择。
_Avoid_: Checkpoint count, milestone label

**Transition Cost**:
执行一次 ACM move 本身引入的工具调用、handoff 构造与上下文切换成本；无任务依据的 post-travel 重新定位属于 Transition Harm。
_Avoid_: Tool latency

**Continuity Risk**:
改变 working set 后，当前用户义务、live cognition、hot details 或执行方向发生偏移的可能性。
_Avoid_: Information loss

**Transition Harm**:
一次 ACM move 导致错误任务重放、问题被吞、无谓重读、重复探索或最终任务质量下降。
_Avoid_: Failed tool call

**Effect First**:
Guidance、接口与 runtime 只按可观察的任务效果和 ACM 行为质量取舍；固定字符数、token 数或文档长度不构成产品目标。
_Avoid_: Prompt budget, character ceiling, brevity target

**Activation Foothold**:
一个在判断层近似免费的、有真实 Recovery Option Value 的 checkpoint；它既保存返回状态，也天然让后续 timeline 与 travel 判断更容易发生。
_Avoid_: Mandatory checkpoint, ritual marker
