# ACM 合并后优化证据（2026-07-21）

> 这是 compact evidence 索引，不复制长 transcript。原始 report、session、event stream 与 workspace 保留在下文列出的 `eval/.runs/` 目录或对应 throwaway worktree；可机器读取的同名 JSON 记录了完整路径、提交和边界。

## 结论

本轮只晋级一个产品行为改动：**澄清 rehydrate 中 `target` 与 `backupCurrentHeadAs` 的角色，并在 off-path receipt 中把 extract 明确带回 handoff 指名的 return pointer。**

同时完成两项 eval 基础修正：

1. pivot 的 Recover 不再机械要求 checkpoint / raw backup；完整、travel 前已落盘并可验证的 `research-brief.md` 也可以是最有用的恢复路线；
2. deferred-wait scorer 接受 `Wait explicitly for the next user instruction` 与 `Wait for explicit next user instruction` 这类等价语序，同时继续拒绝提前 checkpoint / travel。

没有晋级的 additive prompt：checkpoint parking、pivot backup、pivot precommit、Recover artifact schema 扩张、long/short NEXT obligation、runtime inferred return pointer、target 重复说明、Recover 排序说明。它们要么没有净收益，要么把局部实验语言扩散到所有 travel，要么引入跨模型回归。

## 产品提交线

| Commit | 作用 |
|---|---|
| `c73514b7` | 提交 post-merge pivot / restraint 矩阵 |
| `cf07262f` | 让 pivot Recover scorer 对齐可验证的 handoff recovery route |
| `a7ba6470` | 澄清 rehydrate return target 与 origin backup alias 的机械语义 |
| `3e856d4f` | 接受语义等价的 explicit deferred-wait wording |
| `1b2d7eab` | 把 direct-write durable artifact 证据固定在 travel 前内容 |
| `04fe8927` | opaque shell write 必须用 travel 前 readback 证明目标内容 |

Live 行为运行使用本机 Pi CLI **0.80.10**，并发生在最终分支 rebase 到 host-upgrade commit `1e9911d9` 之前；最终 deterministic host fixture 严格固定 **Pi 0.81.1**。Live stochastic evidence 与 rebased exact-host compatibility evidence 分开记录，不把旧 CLI run 冒充 0.81.1 live run。

## Pivot scorer 校准

原 post-merge 矩阵：

- Raw artifact：`eval/.runs/matrix-2026-07-21T12-08-36-354Z-acm-pivot-restraint-post-merge-v1-p67174`
- Raw：**80/88**，8 个 scenario failure，无 provider / terminal / infrastructure / runner failure。
- 对其中 44 个 pivot report 用当前 scorer 重评：**36/44 → 38/44**。

新增通过的两条 Sonnet product-isolated run 都满足：

- `research-brief.md` 在 travel 前成功写入；
- 文件包含 Market Signals / Interview Conclusions / Operating Constraints；
- `Recover` 的主引用从该完整 artifact 开始；
- raw conversation 没有额外、必须单独 checkpoint 的恢复价值。

新 scorer 仍拒绝：

- vague “prior conversation” pointer；
- 不存在的 alias；
- unrelated checkpoint；
- 只在 Evidence / External 中出现的路径；
- source glob；
- travel 后才写入的 artifact；
- 缺失或内容不完整的 brief。

Outgoing review 发现了一个时间归因缺口：旧实现只确认 travel 前出现过 write，然后用 scenario 结束后的最终文件证明“当时已经完整”。`1b2d7eab` / `04fe8927` 改为同时要求：

- travel 前 direct write 的 `content` 已经携带三个完整 section；shell redirect/tee 本身不证明目标内容，必须在之后、travel 之前成功 readback 并读到三个 section；
- scenario 结束时 artifact 仍存在且完整。

因此 “pre-travel incomplete write + post-travel complete overwrite” 现在明确失败，不会用未来状态倒灌过去证据。

Fresh current-HEAD pivot control：`eval/.runs/matrix-2026-07-21T15-39-01-257Z-pivot-current-head-control-v1-p47129`，**8/14**。剩余失败已分解为 stochastic task failure、不可执行 Recover、一次 stale brief reread，而不是旧 scorer 的 save-point ritual。

## 被淘汰的 pivot / NEXT treatment

| Treatment | 结果 | 判定 |
|---|---:|---|
| pivot backup `e27d2e5e` | 21/31 | 无稳定 uplift；还会提高 rehydrate 中 alias-as-backup 的错误显著性 |
| pivot precommit `18879e34` | 33/45 | 未改善 Haiku；把普通 signal 推成 pre-action seam |
| checkpoint parking `a7e7dbfd` | 31/39 | 未改善目标 Haiku cohort；重复 CORE 已有 parking cue |
| Recover artifact `6a1da647` | 28/39 | 全局扩张 slot 语义，无稳定收益 |
| long NEXT obligation `e47239d0` | paired overall 16/18 → 15/18；NEXT 17/18 → 17/18 | DeepSeek 5/6→6/6，但 Gemini 3/3→2/3，聚合无净收益 |
| short NEXT obligation `9cb78938` | DeepSeek pivot 6/6；首 3 条 Gemini 全失败 | 更短仍产生 Gemini stale replay / wrong first action，提前终止 |

paired raw artifacts：

- control：`eval/.runs/matrix-2026-07-21T16-09-50-471Z-next-obligation-paired-v1-p83443`
- long treatment：`/private/tmp/pi-context-next-obligation-cue-prototype/eval/.runs/matrix-2026-07-21T16-09-50-471Z-next-obligation-paired-v1-p83444`

结论：现有 `goal` + `currentUserTurnOpen` + trusted Context Packet + queue-safe steer 已经是 delivery floor。继续给所有 handoff 的 `NEXT` schema 叠加 pivot/open-turn policy，没有挣回 prompt 成本。

## Rehydrate 根因

失败不是 host mutation 或 settled delivery 不工作，而是模型混淆了两个字段角色：

- `target`：选择已存在的 destination / return checkpoint；
- `backupCurrentHeadAs`：在**当前 origin 的 exact protocol-complete pre-travel path**上创建一个 brand-new alias。

弱模型会把已有 `rehydrate-return-*` 或 `rehydrate-raw-*` 再填进 `backupCurrentHeadAs`，触发 `backup_protocol_incomplete` / retry；或者直接回更早的 `rehydrate-base-*`，而不是 recovery 前刚创建的 return point。

旧 treatment：

| Treatment | 结果 | 残余问题 |
|---|---:|---|
| return result cue `297c3c23` | 7/19 | 没处理 existing-alias-as-backup |
| always-on travel guideline `844c229d` | 13/23 | 仍有 backup misuse / wrong base；复制 advanced workflow |
| runtime verified-pointer heuristic `ba01261b` | DeepSeek 1/6，mini 1/6（partial） | 增加 runtime 推导、node ID 和 public detail，无收益 |
| target description `337db9f1` | DeepSeek 4/6，mini 1/4 valid，Sol 1/2（partial） | 与现有 cue 重复，出现 strong regression signal |
| Recover ordering `0ed1695a` | mini 0/5（partial） | 不是实际 tool-argument decision point |

## 最终 rehydrate 产品候选

`a7ba6470` 只改两个 prompt surface：

1. `backupCurrentHeadAs` 明确是 current origin 上的 **brand-new recovery alias**，绝不选择 destination；已有 checkpoint / archive / return alias 放进 `target`，只有 exact pre-travel path 需要新 alias 时才使用 backup。
2. off-path receipt 先要求执行 handoff `NEXT`；bounded rehydrate 把 extract 通过 handoff 指名的 return pointer 带回，pointer 是下一次 `target`，不是 backup，并且不能用旧 fold base 代替。runtime 不推断、不存储、不静默改写 semantic return target。

### 同时间 DeepSeek paired

| Arm | Pass | 失败形态 |
|---|---:|---|
| Control | **0/6** | 6 次 wrong base；5 次同时出现 backup protocol rejection / extra retry branch |
| Candidate | **3/6** | 只剩 3 次 wrong-base target |

- Control：`eval/.runs/matrix-2026-07-21T16-35-25-136Z-rehydrate-final-ds-v1-p5195`
- Candidate：`/private/tmp/pi-context-rehydrate-pointer-prototype/eval/.runs/matrix-2026-07-21T16-35-06-282Z-rehydrate-final-ds-v1-p4999`

精确 provenance：

- control raw `productCommit`：`9f0e5ce5`；
- candidate raw `productCommit`：`30f754e3`；
- `30f754e3` 与 rebase 后生产提交 `a7ba6470` 在 `TOOL-CONTRACTS.md`、`src/generated-guidance.ts`、`src/travel-tool.ts` 上逐字相同；最终分支另行继承 Pi 0.81.1 host-contract base，prototype 测试名也不进入 runtime prompt surface。

结构性收益比 raw pass 更重要：candidate **消除了全部 `backup_protocol_incomplete`、rejected travel 与 extra retry branch**。

### Final production matrix

Committed manifest：`eval/matrix.optimization-final.mjs`

Raw artifact：`eval/.runs/matrix-2026-07-21T16-57-47-135Z-acm-rehydrate-pointer-production-v1-p20611`

该 raw batch 记录的 `productCommit` 是 `497d9885`。它与 rebase 后产品提交 `a7ba6470` 在三个 ACM runtime prompt surface 上相同；`3e856d4f` 只继续校准 deferred-wait evaluator。Raw live batch 早于 Pi 0.81.1 dependency-base rebase，因此 0.81.1 compatibility 只由最终 exact-host gate 证明。Committed matrix source 是 `eval/matrix.optimization-final.mjs`，由 rebase 后 `53206b3b` 固化。

| Model | Raw | Calibrated |
|---|---:|---:|
| DeepSeek Flash high | 2/6 | 2/6 |
| GPT-5.4 mini medium | 2/5 valid + 1 provider failure | 同左 |
| GPT-5.6 Sol high | 3/3 | 3/3 |
| Claude Opus 4.8 high | 3/3 | 3/3 |
| Claude Haiku 4.5 medium | 1/3 | **2/3** |
| **Total** | **11/20 valid (55%)** | **12/20 valid (60%)** |

Haiku 的一条 raw failure 使用了语义正确的 `Wait for explicit next user instruction`，当前 `3e856d4f` scorer 接受；另一条真实失败把 return alias 同时放进 `target` 和 `backupCurrentHeadAs`，随后无 backup retry 成功。

结论边界：修复建立了更好的 mechanical floor，但没有让弱模型的 semantic return-target 判断变成 100%。尤其 GPT mini 的失败还混合 strict-object extra fields、top-level 参数嵌套、wrong target 与 provider failure；本轮没有放宽 schema，也没有让 runtime 自动 retarget。

## 非 rehydrate 回归

Raw artifact：`eval/.runs/matrix-2026-07-21T16-52-42-539Z-rehydrate-production-regression-v1-p17412`

该 batch 的原始 `matrixSource` 是 `/tmp/rehydrate-production-regression.mjs`（SHA-256 `e1d2fa4a018a6f4b1ac2cd47a7eeaaa152ac24434c65276634ece40a63d05b70`）。其 model / thinking / environment / scenarios / repeats / contextWindow 轴与 `eval/matrix.optimization-final.mjs` 的 `*-ordinary-regression` cells 规范化后完全相同；差异只有 cell id 与 `experimentalVariable` 标签。精确 manifest snapshot 记录在同名 JSON。

- 场景：`unprompted-fold-on-pivot` + `restraint-clean-new-cycle`
- 模型：DeepSeek Flash、GPT mini、Sol、Opus、Haiku、Gemini
- 结果：**16/16**
- provider / terminal / infrastructure / runner failure：**0**

这说明新的 backup 字段说明没有把 ordinary pivot 推成 raw-backup ritual，也没有破坏 clean-cycle restraint。

## Deterministic evidence

最终产品 diff 的完整 gate：

```text
bun run verify:acm
root: 280 pass / 0 fail
exact Pi 0.81.1 host fixture: 53 pass / 0 fail
typecheck: pass
generated guidance: pass
```

最终 deferred-wait scorer focused gate：

```text
bun test eval/topology-scenarios.test.mjs
20 pass / 0 fail
```

独立 reviewer 对 final rehydrate diff 的结论：**0 P0-P2**；唯一 P3 是测试名仍写 “verified”，已在生产提交前改名。Outgoing range 初审随后发现 pre-travel artifact 时间归因、opaque shell 归因与 raw-run provenance 三项 P2；direct write 由 `1b2d7eab` 固定，shell 分支由 `04fe8927` 要求 boundary readback，provenance 由本节的 raw commit / manifest snapshot / equivalence proof 固定。分支随后 rebase 到 Pi 0.81.1 host-contract base，并在该 exact host 上重跑完整 gate，等待最终 re-review。

## 外推边界

1. 所有 live behavior run 都是随机模型样本，不构成模型排名或总体通过率声明。
2. 最强因果证据是 same-time DeepSeek 0/6 vs 3/6；其他矩阵主要是 regression / boundary evidence。
3. GPT mini 的 failure surface 已不再是单一文案问题；继续加句子、放宽 schema 或自动 retarget 都缺少正向证据。
4. Raw artifacts 在本地 `eval/.runs/` 与 throwaway worktree 中，不进入发布包；本文件与同名 JSON 是可审阅 compact index。
