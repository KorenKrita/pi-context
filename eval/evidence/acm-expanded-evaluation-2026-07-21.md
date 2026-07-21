# ACM 扩展多模型评估与 settled-delivery 跟进（2026-07-21）

> 这是 compact evidence 索引，不复制长 transcript。每一项都回链到 `eval/.runs/` 中可复核的 report、session、event、workspace 和 judge artifact。

## 范围与版本

- 评估链路：`232cd88b`（exact advanced Skill router path）→ `2899c761`（settled-delivery production candidate）→ `3f9653fc`（settled-delivery hardening）。
- live 行为运行使用本机 Pi CLI **0.80.10**；host-contract deterministic fixture 仍严格固定为 **Pi 0.80.7**。二者分开记录，不能混作同一个版本结论。
- 最终 deterministic gate（`3f9653fc` 后）：root **256**、host fixture **50**、typecheck/guidance 均为 green。独立 review 先审 `2899c761`，发现 **4** 项；`3f9653fc` 已提交修复，随后复审范围 `2899c761..3f9653fc` 为 **0 P0-P3 findings**。

## 矩阵与可比性

| 批次 | Raw artifact | Jobs | 用途 |
|---|---|---:|---|
| expanded #1 | `eval/.runs/matrix-2026-07-21T02-15-32-122Z-acm-expanded-model-effort-v1-p64228` | 136 | 原始多模型/effort/environment 覆盖；raw 为 93 pass、32 scenario failure、1 provider failure、10 terminal failure（74.4%） |
| expanded #2 | `eval/.runs/matrix-2026-07-21T03-28-36-128Z-acm-expanded-model-effort-v1-p64085` | 136 | 第二轮 expanded 运行，位于后续 scorer/provider 校准之前 |
| serial follow-up | `eval/.runs/matrix-2026-07-21T04-56-17-781Z-acm-expanded-followup-v1-p33257` | 29 | calibrated outcome、topology timing、provider retry 分离；raw 为 15/29（51.7%） |

两个 136-job raw percentage 和 29-job raw percentage **不能作为产品前后对比的分数**。期间单独校准了 scorer 假阴性、shell/write 工具形状偏见、eval workspace 泄漏、场景时间顺序冲突，以及 provider/terminal 故障归因。下文只把校准后的 task/outcome 结论作为行为证据；provider-invalid 结果不归给 ACM。

## 校准后行为结论

| 场景 | 结果 | 解释 |
|---|---:|---|
| primary short behavior | **84/96** | 多模型、多 effort、`core-only`/`product-isolated` 的受控主场景 |
| clean-cycle restraint | **23/24** | 一次成功 transition 后，小的新任务基本不会触发仪式化 checkpoint/travel |
| unprompted pivot fold | **15/24** | 最大普通行为缺口：已有 sediment 后切换到无关 front 时，仍有模型先做新任务、错过 save/fold，或 travel 后 stale replay |
| pressure framing | **16/16** 无 travel attempt；任务比较 **12/16** | 证明 active uncertainty 下没有被 framing 推成错误 travel；它是 framing probe，不冒充真实 runtime 30/50/70 nudge |
| checkpoint precise recovery | **4/4** | Sol / Opus / DeepSeek / Kimi 都避开较近 decoy，选择语义正确 base 并直接继续 |
| rehydrate baseline follow-up | Sol pass；Opus/DeepSeek/Kimi fail | 基线 archive round-trip 显著依赖模型，推动后续 continuation/settled-delivery 试验 |

## Advanced Skill 路由

静态 location bridge（`91d26d62`）的结果是 MiMo **0/3**、Haiku **3/3**、Sonnet **2/2**：它帮助了 Haiku，却没有让 MiMo 稳定读取 router/reference。

`232cd88b` 改为只在 `getCommands()` 验证当前 session 真正有 `skill:context-management` 且 provenance 属于当前 checkout 时，向模型附上**精确 router path**。随后 product-isolated 的 router/reference 实读为：

| 模型 | 结果 | Raw runs |
|---|---:|---|
| MiMo v2.5 medium | **3/3** | `06-32-26…p10726`、`06-32-54…p11196`、`06-33-24…p11775` |
| Claude Haiku 4.5 medium | **2/2** | `06-33-55…p12603`、`06-34-16…p13133` |
| Claude Sonnet 5 high | **1/1** | `06-34-37…p13333` |
| core isolation | **2/2** | `06-35-08…p14128`、`06-35-24…p10725`；Skill 正确 absent，未泄漏 path |

完整目录名在同名 JSON artifact 的 `advancedSkillRouting.dynamicExactPathBridge.runs` 中；该 JSON 是此表的可机器读取索引。

## Continuation 与 settled delivery

- `0944da39` continuation wording prototype：**no-go**。单靠 wording neutralization 没有足够受控增益，不进入 production。
- `ab0598a7` deferred-refresh prototype：仅作为 A/B 输入，不是 production。Opus 为 control **0/3 → prototype 3/3**；Kimi 从 baseline 问题到 prototype **2/2**；Sol **1/1** 有效；DeepSeek **1/3**。provider-invalid 单列，不计为行为结果。
- 新的 production settled-delivery candidate `2899c761` fresh rehydrate：Opus **1/2 strict**（另一条 final outcome 正确，但 strict T5 未 read）；Kimi **2/2**；Sol **0/1**（backup misuse）；DeepSeek **1/2**。原始 runs 是 `08-33…` 到 `08-50…`，完整路径见 JSON。

结论：settled delivery 消除了一个已证实的 mid-run native-message replacement hazard，但它没有让 rehydrate 在所有模型族上统一成功；这仍是明确的模型/交互边界。

## 实际 pressure long flow

这些不是 wording probe，而是 40k context window 下的真实 runtime flow；但峰值只有 56%/58%/59%，也不应被夸大为覆盖所有 30/50/70 nudge transition。

| Run | 环境 | Judge | 分数 | 关键观察 |
|---|---|---|---|---|
| `eval/.runs/2026-07-21T09-01-37-137Z-flow-gpt-5.6-sol-p89668` | core-only | Opus high / `acm-outcome-v3` | overall **2**、task **3**、timing **2**、peak **56%** | handoff/任务事实强；P2 无新材料连做第二次 travel，被判 event-driven overfold，之后 recovery discipline 不完整 |
| `eval/.runs/2026-07-21T09-38-30-459Z-flow-claude-opus-4-8-p21313` | core-only | Opus high / `acm-outcome-v3` | overall **3**、task **3**、timing **3**、handoff **3**、recoverability **2**、peak **58%** | P1 先 checkpoint 再 travel；之后保持 outcome-first restraint，未出现 thrash |
| `eval/.runs/2026-07-21T09-26-19-639Z-flow-claude-opus-4-8-p12597` | product-isolated | Opus high rejudge / `acm-outcome-v3` | overall **2**、task **3**、timing **3**、handoff **3**、recoverability **1**、peak **59%**、checkpoint **0** | 一次 fold 时机好，且主动判断不再折以避免 thrash；但全程没有 checkpoint，save-before-risk/recoverability 仍弱 |

同一 Opus/high 的 core-only 与 product-isolated 对照只是一条 **single-pair stochastic observation**：这一样本中 full product 没有自动提升结果，反而 core 的 checkpoint cadence 更好。它是后续复测的线索，不是 general causal effect 或环境优劣排名。

## 外推边界

1. 行为运行是随机模型的单次或小样本观察，不构成模型/effort 的普适排名。
2. `core-only` 与 `product-isolated` 是受控 package 环境，不覆盖用户全局 extension、MCP、真实 workspace 噪声或所有会话历史。
3. raw pass rate 跨校准阶段不可比；审阅时要同时读本索引与对应 raw artifact。
4. 本轮长流真实运行但 session 长度、context peak 和模型组合仍有限；Opus core/product 的结论仅来自一对随机运行。
5. 这些证据记录已观察到的增益、失败模式与 regression target；不宣称当前版本是全局最优。
