# ACM Redesign Plan v0

## 状态

本方案把以下已确认文档转成可独立实施、验证和回滚的行为边界：

- `CONTEXT.md`
- `docs/acm-judgment-contract.md`
- `docs/acm-failure-mechanisms.md`
- `docs/acm-guidance-audit.md`

本方案遵循 Effect First，不使用固定字符、token、工具调用或上下文压缩上限作为裁决条件。

## 已确定的产品判断

1. ACM 优化整体任务与注意力效果，不优化压缩率或调用频率。
2. Predictability 约束判断过程，具体 move 随上下文变化。
3. Checkpoint 在判断层近似免费，同时提供 Recovery Option 与 Activation Foothold；数量由未来用途和 catalog 可读性体现。
4. Travel 的前提是存在低 Attention Value、高噪声且可高度简练表示的 Compression Candidate。
5. Handoff 是当前自己写给未来自己的权威信息；成功 travel 后直接继续，不增加验证或重新定位仪式。
6. 对齐通过操作和任务结果评价，不要求 agent 向用户陈述 ACM reasoning。
7. Runtime 负责机械正确性与事实 evidence，不冒充语义 judge。
8. 强模型拥有创造性组合原语的 ceiling；较弱模型通过清晰接口与 runtime rails 获得安全可用的 floor。

## 目标架构

```text
ACM Judgment Contract
        │
        ├── CORE projection: always-on 判断内核
        ├── Tool contracts: agent-facing affordance 与 mechanics
        ├── Handoff module: 低摩擦输入 → 权威 durable handoff
        ├── Context Packet module: protocol integrity + continuation authority
        ├── Host Bridge: verified mutation capabilities
        ├── Advanced Skill: 按 branch 渐进披露的术
        └── Eval: task / continuity / attention / transition harm
```

复杂性应集中在少数 deep modules 后面，而不是继续分散到 `travel-tool.ts`、lifecycle、live adapter、tool result 和 guidance 中。

## Module 1 — Handoff

### Seam

新增 `src/handoff.ts`，调用者只学习一个结构化 handoff interface 和一个 canonical result。

```ts
interface HandoffInput {
  goal: string;
  state: string;
  evidence: string;
  external: string;
  exclusions: string;
  recover: string;
  next: string;
}

interface CanonicalHandoff {
  fields: HandoffInput;
  text: string;
}

type HandoffBuildResult =
  | { ok: true; value: CanonicalHandoff }
  | { ok: false; defects: HandoffDefect[] };

function buildCanonicalHandoff(
  input: HandoffInput,
  facts?: { rawArchiveAlias?: string },
): HandoffBuildResult;
```

### Agent-facing contract

已确定的 interface invariant 是：agent 不再负责脆弱的七槽 wire grammar，runtime 负责 durable handoff representation。

当前首选实验 variant 把 `acm_travel` 从：

```ts
summary: string
```

改为：

```ts
handoff: {
  goal,
  state,
  evidence,
  external,
  exclusions,
  recover,
  next,
}
```

该 variant 中七个字段全部 required：

- `goal/state/next`：trim 后必须有真实内容，不能是 `none`；
- `evidence/external/exclusions/recover`：没有内容时显式写 `none`；
- 所有字段允许自然多行；
- 不设置人为最大长度；
- production 晋级后不长期暴露 `summary` 与 `handoff` 两套接口。

需要比较的 interface variants：

1. nested structured object；
2. flat structured fields，作为弱 provider fallback；
3. conservative tolerant parser，作为 legacy control，不做语义猜测。

晋级条件：首调成功、handoff 信息保留、current obligation、post-travel continuation 与最终任务结果均不劣于 control。Nested object 是当前证据最强的候选，不是未经实验的永久约束。

### Durable representation

Runtime 负责唯一序列化，agent 不再手写 header、顺序、冒号和 line-start grammar：

```text
Goal: ...
State: ...
  multiline continuation
Evidence: ...
External: ...
Exclusions: ...
Recover: ...
NEXT: ...
```

若传入 `rawArchiveAlias`，Handoff module 采用固定 composition 规则：

- `recover === "none"` 时替换为 `Raw archive: ALIAS`；
- 否则在 Recover 尾部追加一行 `Raw archive: ALIAS`；
- 已包含完全相同 alias 时不重复；
- `CanonicalHandoff.fields` 表示 composition 后的最终字段。

### 不承担

Handoff module 不总结、不改写、不推断缺失语义，不把未提供字段自动写成 `none`，也不修正当前用户义务。

## Module 2 — Context Packet

### Seam

新增 `src/context-packet.ts`，统一所有 LLM-bound message reconstruction：

```ts
interface ContextPacket {
  messages: AgentMessage[];
  integrity: {
    status: "complete" | "repaired";
    repairs: ProtocolRepair[];
    deepestCompleteEntryId: string | null;
  };
  continuation:
    | { status: "projected"; sourceEntryId?: string; sourceIndex: number }
    | { status: "not_present" }
    | { status: "ambiguous"; candidates: number };
}

function rebuildFromSession(
  sessionManager: ReadonlySessionManager,
  leafId?: string | null,
): HostResult<ContextPacket>;

function normalizeExistingPacket(
  messages: readonly AgentMessage[],
): ContextPacket;
```

### 深度

这两个入口对应两个真实 source adapters：

- session tree rebuild：persistent refresh、live adapter、preview；
- existing packet normalization：普通 `context` event，只处理实际收到的 `messages`，保留前序 extension 已经做出的插入、删除、替换和重排。

二者共享同一个内部 protocol analysis 与 continuation projection implementation。该 module 隐藏：

- `buildSessionContext()`；
- tool call/result protocol 检查与修复 receipt；
- marked ACM branch summary 的 authority projection；
- protocol completeness 与 deepest complete prefix；
- persistent rebuild、live adapter、reload、preview 的一致 packet。

调用者不再分别调用 `buildSessionMessages()` 和 `fixOrphanedToolUse()` 后自行猜测结果。

### Protocol inspection

内部只保留一套 protocol analysis，其 receipt 进入 `ContextPacket.integrity`：

```ts
type ProtocolInspection =
  | {
      status: "complete";
      packet: AgentMessage[];
      deepestCompleteEntryId: string | null;
      repairs: [];
    }
  | {
      status: "repaired";
      packet: AgentMessage[];
      deepestCompleteEntryId: string | null;
      repairs: ProtocolRepair[];
    };
```

Backup anchor、target evidence、persistent rebuild 与 live sync 共享该实现，不再新增第三套 protocol 判断。调用者只通过 `ContextPacket.integrity` 获取 repair 与 deepest-complete evidence。

### Authority invariant 与 variants

已确定的 invariant 是：successful travel 的 handoff 在其 authority epoch 内成为可信当前状态，future self 直接继续；具体 representation 由行为实验决定。

需要比较：

1. branch summary 内 marker/preamble；
2. 在原 branch summary 时间位置投影为 authoritative custom message；
3. durable custom continuation（仅探索 prototype，见下方 transaction 限制）；
4. 组合方案。

Projection 必须原位替换或原位解释 marked summary，不能追加到 packet 尾部。Authority 只 supersede 其之前的 surviving history；之后的新 user message、native summary、compaction 或 manual tree boundary继续按原顺序获得更新 authority。

`normalizeExistingPacket()` 只转换 actual packet 中唯一可识别的 marked message：

- 不根据 session entries 重新插入、移动或复活 message；
- 没有 marker 时返回 `not_present`；
- 多个候选或匹配歧义时保持 packet 原样并返回 `ambiguous`；
- markerless authority variant 不承诺 existing-packet projection，除非另有稳定 correlation key。

### 当前首选 projection prototype

候选实现把 marked ACM branch summary 在原时间位置投影为 hidden custom user message：

```text
[ACM CONTINUATION — AUTHORITATIVE WORKING STATE]

This is your own current memory after deliberate travel.
Trust it exactly, including stated uncertainty.
Where older surviving history conflicts, this handoff supersedes it.
Continue directly with NEXT.

Goal: ...
...
NEXT: ...
```

若该 variant 使用 marker，marker 与 handoff 通过同一次 `branchWithSummary()` 原子持久化；projection 是可重复重建的 context behavior，不增加第二次持久 mutation。

Native `/tree` summary 没有 marker，继续使用 Pi 的 archival framing。

`durable custom continuation` 需要 branch summary 之后的第二次持久 mutation，因此在设计出 verified transaction、partial-failure outcome、观察证据与恢复行为前，不具备 production 晋级资格。它只能作为探索 prototype；marker/preamble 与原位 packet projection 不增加第二次 mutation。

## Module 3 — Protocol-complete anchors

### Backup anchor

`backupCurrentHeadAs` 的职责是恢复 raw continuation，不等同于普通语义 checkpoint。

当前 resolver 跳过 tool results，可能把 backup 放在旧 assistant tool-call turn，恢复时再合成 `[Interrupted by context travel]`。

共享 protocol analysis 提供当前 travel tool-call 之前最深的 protocol-complete prefix；不再单独实现另一套纯函数。

调用侧只读取：

```ts
inspection.deepestCompleteEntryId
```

它选择当前 travel tool-call 之前最深的完整 prefix，可以落在：

- closed assistant；
- 完整 tool batch 的最后一个 toolResult；
- 其他无需 protocol repair 的合法 leaf。

### Travel target evidence variants

Travel prevalidation 先构造 target Context Packet。若保留到 target 的 prefix 需要：

- 删除 orphan tool result；
- 合成 interrupted tool result；
- 修补不完整 multi-tool batch；

则返回 repairs 与最近 protocol-complete ancestor 作为 evidence，不自动替换模型选择的 target。

需要比较三种行为：repair、warning、reject。只有宿主/provider 不能形成合法 packet 时才是确定性 hard failure；普通 target 的 policy 由 controlled analogue 与任务效果晋级。

### 暂不硬拒绝

以下先作为结构 evidence 做行为实验：

- dangling user target；
- complete tool-batch target；
- existing branch-summary target；
- off-path target。

Authority projection 是否足以解决其行为风险，决定后续是否升级为 hard gate。

## Module 4 — Clean base（deferred）

Pi `0.80.7` 原生支持：

```ts
branchWithSummary(null, summary, details, true)
```

它创建新的 top-level summary，active LLM path 不保留旧 user、tool 或 summary messages，是唯一真正的 clean-base transition。

未来存在首个真实 consumer 时，完整 transaction interface 应区分：

```ts
type TravelBase =
  | { kind: "node"; id: string }
  | { kind: "clean" };
```

当前 `target: "root"` 继续表示第一条 top-level entry，不能静默改成 clean base。Agent-facing move、名称和第一个真实 consumer 确定前，不单独增加无消费者的 Host Bridge capability。

## Checkpoint catalog

Checkpoint creation 保持自由，不增加数量配额。

Checkpoint view 改为以 target entry 为主记录：

- 同 entry aliases 聚合展示；
- active path 优先；
- 保留 alias count 与 entry count；
- filter/search 继续覆盖全部 alias；
- `limit` 约束候选 entry，而不是逐个 alias 消耗配额。

该变化只改善 catalog legibility，不评价某个 checkpoint 是否语义有价值。

## Advanced Skill

### 顺序

1. 先把 Skill 内容与 Trusted Handoff、ownership 对齐；
2. 再修 availability；
3. 再增强 invocation；
4. 最后以任务效果评价触达方案。

提高读取率前必须删除 normal success 路径中的 verification ritual，否则可能得到“Skill 读得更多、任务绕路更多”的假进步。

### Availability plane

Eval 显式加载当前 checkout：

```text
--skill skills/context-management/SKILL.md
```

每个 run 首次 prompt 前执行 `get_commands`，断言：

- core-only：0 个 `skill:context-management`；
- product-isolated：恰好 1 个，路径指向当前 checkout；
- full-env-minus-MCP：恰好 1 个当前 checkout 版本，并记录其他 Skill 数量。

Availability 不满足时 run 标记 `infrastructure_invalid`，不归因模型。

### Invocation plane

按最小强度逐级验证：

1. sharpened model-invoked description；
2. tool/result 中使用 exact `context-management` 与 exact reference pointer；
3. runtime 根据已知结构事实给 conditional pointer；
4. 只有前述方式明确漏触发并造成 branch-specific harm 时，才实验 conditional compact content。

Runtime 可以识别：

- duplicate name；
- multi-root；
- off-path ownership；
- target 类型；
- `not_applied` / `indeterminate`；
- rollback failure；
- refresh exhausted；
- restored/grown history；
- structural delta。

Runtime 不识别：

- 当前任务是否复杂；
- 原始内容是否 sediment；
- 是否值得 rehydrate；
- 哪个语义 target 最好；
- checkpoint 是否有未来价值。

Cue 使用条件式语言：报告事实，并在该事实仍妨碍判断时提供 exact reference pointer，不直接决定 move。

## Eval redesign

### Environment

1. **core-only** — extension + CORE/tools，无 advanced Skill；
2. **product-isolated** — 当前 checkout 的完整 extension + Skill，无其他用户 guidance；
3. **full-env-minus-MCP** — 真实用户配置，但 extension/Skill 固定为当前 checkout；
4. **raw-control** — 同模型、同任务，不加载 ACM。

Native-window 是整体产品效果的主证据；shrunk-window 只用于 pressure/nudge stress test。

### Outcome gates

版本裁决依次通过：

1. infrastructure validity；
2. task outcome；
3. transition harm；
4. continuation quality；
5. attention/recovery benefit；
6. ACM 与 Skill diagnostics。

工具调用数、Skill read rate、token delta、summary depth 不进入前五个 gate。

### Transition record

每次 travel 记录：

- current user obligation；
- target 与 target class；
- handoff Goal/NEXT；
- actual post-travel LLM packet；
- first useful action；
- immediate reread / stale-task replay；
- task outcome；
- Skill availability/cue/read/application funnel。

### 不可复制真实任务

证据分三层：

1. **Mechanism analogue** — 可复制地证明结构机制；
2. **Controlled paired task** — 比较 ACM 与 raw-control 的相对效果；
3. **Production fossil** — 保存不可复制真实 session 的操作与结果证据，用于发现机制和监控回归，不直接驱动一句 prompt patch。

## Guidance redesign 的进入条件

只有 execution substrate 与 eval 能分离 recognition、decision、execution、continuation 后，才进入 CORE/nudge/leading-word 实验。

已确认需要重新归属的内容：

- Representation Gain 提升为 Judgment Kernel；
- cold start 回到 handoff integrity；
- 七槽 wire grammar 下沉到 Handoff module/schema；
- normal success 移除 verification ritual；
- pressure 重新执行 Judgment，不直接授权 move；
- Skill normal/exceptional ownership 去重。

仍需 A/B 的内容：

- compression-first 与 reversible-attention/time-machine framing；
- 去掉 default-fold action gradient 后的 activation；
- judgment-only nudge 对 signal-dependent 模型的影响；
- Skill exact pointer、bridge、structural cue 的最低有效强度。

## 实施顺序与原子边界

### Phase 1 — Deterministic foundations

1. **Protocol analysis seam** — replace 现有 sanitizer/mixed-batch 分散判断，提供 repair receipt 与 deepest complete prefix；
2. **Backup anchor completeness** — 使用共享 analysis 选择 raw bookmark；
3. **Timeline unknown stays unknown** — 修复 failed rebuild 显示 `~0 msgs`；
4. **Checkpoint catalog grouping**；
5. **Handoff interface prototype** — nested / flat / conservative parser 的 interface-only evidence；
6. **Context Packet adapters** — session rebuild 与 existing packet normalization，保留 extension composition；
7. **Authority variants prototype** — 原位 authority epoch 与真实 LLM packet evidence。

每一项独立测试、独立 commit；不把多项机制合并成一次不可归因的改动。

### Phase 2 — Product availability and outcome evaluation

1. Advanced Skill normal-success / exceptional ownership 与 Trusted Handoff 对齐；
2. 三环境模式与 Skill availability gate；
3. transition record；
4. raw-control / product-isolated paired tasks；
5. outcome-first judge；
6. production fossil schema。

### Phase 3 — Production transition mechanics

1. 选择并接入胜出的 handoff interface；
2. 选择并接入胜出的 authority representation；
3. 依据 target policy analogue 决定 repair/warning/reject；
4. 只有 clean-base 有真实 agent-facing consumer 时，贯穿完整 transaction interface 实施；
5. 关闭旧 shallow seams：`buildSessionMessages()`、`fixOrphanedToolUse()` 的公开调用与旧测试迁移到 Context Packet interface。

### Phase 4 — Guidance and disclosure

1. sharpened description + exact pointers；
2. conditional structural pointer A/B；
3. Judgment Kernel projection；
4. nudge A/B；
5. leading-word A/B。

## Verification

### Deterministic

- handoff interface variant 与 canonicalization；
- target/backup protocol completeness；
- exact LLM packet projection；
- reload/live sync/persistent rebuild 一致性；
- Skill discovery path；
- checkpoint grouping；
- timeline failure truthfulness。

### Model behavior

- first-travel structural success；
- current obligation retention；
- first useful action matches NEXT；
- immediate reread；
- stale-task replay；
- justified-use rate；
- checkpoint ritual density；
- final task outcome。

### Complete gate

现有 `bun run verify:acm` 继续作为 deterministic host/runtime gate；行为实验作为独立的 outcome evidence，不把随机模型运行塞入每次 CI。

## 当前不需要用户判断的 invariant

以下均由 Effect First 与现有证据唯一或近似唯一地决定：

- agent 不负责脆弱 wire grammar，runtime 负责 durable handoff；
- production 主路径不长期保留并行 handoff interfaces；
- context reconstruction 与 normalization 共享一个 Context Packet implementation，同时保留 existing-packet composition；
- backup 使用 protocol-complete prefix；
- authority 只覆盖 handoff 之前的 history，不压过后续用户或 session boundary；
- Skill availability 在 eval 中硬断言；
- Skill read rate 只作诊断；
- native window 与 pressure stress 分开裁决。

## 仍由实验决定的技术选择

- nested object、flat fields 或 conservative parser 的晋级结果；
- authority marker only、原位 packet projection 或 durable custom cue 的行为效果；
- protocol repair、warning、reject 的 target policy；
- dangling user、complete tool-batch、old summary 是否进一步升级为 hard gate；
- clean-base 的 agent-facing 名称与默认暴露方式；
- exact pointer 是否已足够，是否需要 dynamic bridge 或 conditional compact content；
- compression-first leading word 是否保留、替换或与 time-machine framing组合。
