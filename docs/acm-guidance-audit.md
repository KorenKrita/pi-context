# ACM Guidance Audit v0

## 状态与范围

本审计使用 `writing-great-skills` 的 Predictability、leading word、context pointer、information hierarchy、single source of truth、duplication、sediment、no-op、negation 与 sprawl 框架，检查：

- `skills/context-management/CORE.md`
- `skills/context-management/TOOL-CONTRACTS.md`
- `skills/context-management/SKILL.md`
- `skills/context-management/references/`
- `src/context-usage-nudge.ts`

本审计不把字符数、token 数或旧有长度上限当作产品约束。结论只按实际行为效果、信息层级和维护一致性排序。

## 总体判断

道／术／度分层、generated guidance 与 progressive disclosure 的基本架构值得保留。当前主要问题不是篇幅，而是：

1. travel 价值判断被 `cold start` 完整性门槛取代；
2. always-on guidance 同时存在自主判断与场景默认动作两套竞争过程；
3. pressure nudge 从重新判断信号变成了动作授权；
4. successful travel 的 guidance 诱发 future self 不信任 handoff；
5. advanced Skill 的 availability、pointer 与 ownership 链路没有闭合；
6. 多轮 additive patch 形成互相抵消的动作梯度。

## P0-1 — `cold start` 被放在错误的判断层级

当前 CORE 把 `cold start` 称为 travel 的 “single test”：

- `skills/context-management/CORE.md:23`

`cold start` 只回答 handoff 是否足以继续，不回答当前 travel 是否产生正的 Representation Gain。

一份 handoff 可以通过 cold start，同时这次 transition 仍然：

- 只移走很小的 delta；
- 没有减少有害注意力竞争；
- 发生后马上需要重读；
- 比保留当前 working set 的整体效果更差。

当前最接近正确 travel 价值判断的文字反而位于 exceptional reference：

- durable representation improvement；
- larger semantic batch；
- avoid repeating tiny fold。

证据：

- `skills/context-management/references/exceptional-recovery.md:32-34`

**审计结论**:

Representation Gain 属于 always-on Judgment Kernel；cold start 属于决定 travel 后的 handoff integrity，而不是是否值得 travel 的唯一判断。

## P0-2 — 自主判断与默认动作竞争

当前 guidance 上半部分建立了 judgment language：

- working set 保留最佳表示；
- sediment 是低价值 raw process；
- timeline 只提供事实；
- sediment 与 thrash 之间存在宽阔健康区间。

证据：

- `skills/context-management/CORE.md:8-22,28-32`

但后续又出现更强的 action gradient：

> folding is the default, not an optional extra

> Skip only when you can name why the raw detail must stay live

证据：

- `skills/context-management/CORE.md:34-36`
- `skills/context-management/TOOL-CONTRACTS.md:63-65`

这形成两套不同过程：

```text
判断过程：有明显 Representation Gain 时 travel

默认动作：在列举 seam 上 fold，除非证明 raw detail 必须留下
```

不同模型会抓住不同规则，形成 pure-folder、pressure-folder、save-only、zero-ACM 与 overfold 等相反 phenotype。

**审计结论**:

Predictability 应来自统一的 ACM Judgment，而不是同时维护“自主判断”和“场景默认动作”。场景可以触发判断，不预先决定 move。

## P0-3 — Pressure nudge 偷换了价值依据

当前各档 reminder 包含明确动作梯度：

- 30%：`fold ... now`，中途则 checkpoint；
- 50%：主动寻找 fold/rebase；
- 70%：在下一个安全时机 travel。

证据：

- `src/context-usage-nudge.ts:146-166`

Pressure 只能证明 working budget 正在变紧，不能证明：

- 存在 Compression Candidate；
- 内容能够高度简练地表示；
- target 安全；
- travel 后不会重读；
- transition 有正净收益。

**审计结论**:

Nudge 应重新运行 ACM Judgment，而不是把 threshold crossing 转换成某个 move 的许可。是否以及如何改写，需要在隔离 A/B 中验证，不能直接凭审计结论修改。

## P0-4 — Success guidance 与 Trusted Handoff 冲突

Normal success cue 要求：

> Verify target, summary leaf, backup, and sync state

> inspect files and external systems directly

证据：

- `skills/context-management/TOOL-CONTRACTS.md:55-57`
- `skills/context-management/CORE.md:56-58`

Archive Recovery 还要求 return 后再次使用 timeline/context evidence 验证 rebuild：

- `skills/context-management/references/archive-recovery.md:13-17`

这些文字混合了三种责任：

1. runtime 应验证的 mutation/sync 事实；
2. agent 应读取一次的 applied/not-applied/indeterminate receipt；
3. future agent 对 handoff 与外部状态的语义重验证。

用户已确认 normal success path 的目标是：

```text
读取 applied receipt
→ 把 handoff 当作 authoritative current state
→ 直接继续实际任务
```

**审计结论**:

Mutation verification 属于 runtime。Future self 在成功 travel 后信任 handoff；只有 handoff 已记录的未决验证或之后发生的独立外部变化才进入真实任务。

## P0-5 — Verbal self-check 已产生有害动作梯度

CORE 要求 travel 前用一行回答：

- what leaves；
- what pointer；
- what NEXT。

证据：

- `skills/context-management/CORE.md:23`

Phase 9 已定位该 self-check 的问题：在 mid-obligation 状态也很容易满足，因为 `NEXT` 总能写出；它让 travel 在错误时机显得程序上可用。

证据：

- `eval/PHASE9-LOG.md:53-57`
- `eval/PHASE10-LOG.md:32-39`

**审计结论**:

用户不以 verbal rationale 评价 ACM。需要保留的信息应由 handoff contract、target evidence 与 Judgment Kernel 分别承担，不把“能否说出一行理由”作为价值判断。

## Checkpoint 审计

### 应保留

- `Save` / `save point` 是有效 leading word；
- checkpoint 不改变 active context；
- 它增加 future return、fork、exploration 与 fold 的选择；
- result cue 已建立 checkpoint 到后续 ACM move 的 affordance。

证据：

- `skills/context-management/CORE.md:21`
- `skills/context-management/TOOL-CONTRACTS.md:7-9,35-37,51-53`

### 缺失的判断

当前主要约束是名称唯一和语义命名，没有直接表达：

> 新 checkpoint 是否创造了一个未来可能有不同用途的返回位置？

用户已确认 checkpoint 还具有 Activation Foothold 价值。因此不能用“本次没有 timeline/travel”事后判定其无价值，也不应添加每任务数量配额。

### 展示层问题

Checkpoint cue 直接说 `acm_travel targeting it`，可能同时强化：

- 该 checkpoint 就是默认 target；
- 跳过 timeline；
- anchor gravity。

更稳定的 affordance 是：checkpoint 让恢复选项进入 timeline；timeline evidence 再参与 target 判断。该链路是可达性关系，不是固定三步流程。

## Advanced Skill 审计

### 文件结构成立

当前 Skill 是轻量 router：

- 一个 condition 对应一个 reference；
- 一次只加载一个；
- condition 变化时替换 reference；
- router 有 completion criterion。

证据：

- `skills/context-management/SKILL.md:8-16`

这符合 progressive disclosure、branching 与 co-location 原则。

### Invocation 链没有闭合

1. Description 最后要求模型先承认 CORE 无法完成判断；
2. runtime cue 使用 `Advanced Target Selection`，而可发现 Skill 名称是 `context-management`；
3. router 后还需要第二次自愿读取 reference；
4. 现有主要 eval 没有加载该 Skill；
5. inline recovery 已经处理很多相同 branch，模型缺乏继续读取的理由。

证据：

- `skills/context-management/SKILL.md:1-16`
- `src/lib.ts:73-80`
- `eval/driver.mjs:37-54`
- `eval/setup.mjs:63-109`
- `README.md:100-112`

### Runtime 不必判断“环境有多复杂”

Conditional guidance 可以只根据 runtime 已知的结构事实提供 pointer，例如：

- duplicate name；
- multi-root；
- off-path ownership；
- `not_applied` / `indeterminate`；
- rollback failure；
- refresh exhausted。

Runtime 只报告可能有用的 reference，不替 agent 决定语义 target 或 move。Model pull、runtime push 与混合 routing 的效果仍需实验。

## Information Hierarchy 与 Ownership

### 七槽 wire grammar 层级过高

CORE 常驻：

- exact slots；
- once each；
- fixed order；
- line-start；
- `none`；
- 完整示例。

同一机械结构还出现在 tool description、tree summary prompt、schema 与 validator error 中。

判断层真正需要的是 handoff 保存哪些认知；wire format 属于 tool/schema/runtime。

### Nudge 是事实上的第四个 guidance owner

项目声明：

- CORE 拥有道与度；
- TOOL-CONTRACTS 拥有术；
- Skill 拥有复杂场景。

但 `src/context-usage-nudge.ts` 独立拥有 cadence、checkpoint、timeline 与 travel 时机文案，并与 CORE 的 “pressure as backstop” 不完全一致。

### Recovery ownership 重复

Tool result 已提供 bounded recovery，Skill reference 又拥有完整 recovery。Agent 常常从 result 已获得足够动作，不会继续加载 Skill。

后续设计需要明确：

- tool result 自己完成 branch；或
- tool result 只给 immediate safety action + exact Skill pointer。

## Duplication 与 Sediment

Generated source 解决了编辑漂移，没有消除模型实际看到的语义重复。高频重复包括：

- checkpoint cheap / save before risk；
- cold start；
- fold as normal/default；
- result is fact；
- boundary-not-anchor target selection；
- inline recovery + Skill recovery。

Git 历史展示了典型 additive patch loop：

```text
不用 → 增加积极句子
过度使用 → 增加 guard
丢 promise → 增加 never 条款
不 rehydrate → 增加 seam cue
backup 替代 checkpoint → 增加区分句
```

证据：

- `eval/PHASE6-LOG.md`
- `eval/PHASE9-LOG.md`
- `eval/PHASE10-LOG.md`

后续每个 guidance 实验应说明：

- 改变的是 judgment、invocation、mechanics 还是 recovery；
- 哪个旧动作梯度被替换或重新归属；
- 是否只改变一个可归因变量。

Effect First 不要求 replacement-only，也不设置长度预算；新增、删除、替换都由观察效果决定。

## Leading Word 审计

### 当前有价值

- `working set` — 最接近 attention-quality 目标；
- `sediment` — 识别低价值、高噪声 candidate；
- `thrash` — 识别 transition 成本超过收益；
- `save point` — checkpoint 的强模型 prior；
- `cold start` — handoff integrity，而非 travel value。

### 需要隔离实验

`Compression is intelligence` 同时可能招募：

- 抽象与 representation priors；
- 有损、不可逆、窗口不足时才压缩的 priors。

当前历史版本并非单变量，无法把 lift 或 regression 归因于这个 leading word。应单独比较 compression-first 与 reversible-attention/time-navigation framing。

`comfortable cruise` 与 30/50/70 pressure 组合后可能形成数值授权先验。应隔离比较“pressure 直接提供动作梯度”与“pressure 仅触发 ACM Judgment”两种设计，再决定其最终职责。

## 已确认与待实验

### 已有足够证据

- cold start 不能单独证明 travel 值得；
- verbal one-line self-check 产生错误动作梯度；
- v4.1 改善 promise survival，没有消除 bad timing；
- nudge 当前明确提供 threshold-driven tool actions；
- advanced Skill 没有被现有主要 eval 正确验证；
- successful travel guidance 包含 verification ritual；
- checkpoint 需要价值密度与 catalog 可读性，而不是数量配额；
- prompt 长度本身不是产品判断依据。

### 需要隔离实验

- compression-first 与 time-machine/reversible-attention framing；
- 去掉 default-fold action gradient 后的 activation；
- judgment-only nudge 对 signal-dependent 模型的效果；
- exact Skill pointer、dynamic bridge 与 conditional push；
- checkpoint return-option 语言对 spam 与 activation 的共同影响；
- successful travel 移除 verification cue 后的 first-action 质量；
- handoff interface 改造对首调成功与 continuation 质量的影响。
