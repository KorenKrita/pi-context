# ACM Judgment Contract v1

## 状态

已由用户确认的 v1 判断契约（2026-07-27 设计会修订；v0 于评测退役前确认）。本契约是 ACM 判断语义的 canonical source，定义稳定的判断过程；具体 interface、runtime representation 与 eval 方案仍由证据选择。

`skills/context-management/CORE.md` 应从本契约派生面向模型的 compact projection；`TOOL-CONTRACTS.md` 只拥有参数、mechanics、result cue 与调用时 guidance。

## 北极星

ACM 的目标是维持当前工作最有价值、可恢复的表示，从而提高整体任务表现。

折叠的存在理由是前行，不是整洁：在合适的时机丢掉包袱，让前路获得完整注意力；绝不因为历史看起来乱而折叠（用户原话：「在合适的时机丢掉一些包袱以方便更高效的继续前行」）。

**度（用户确认，2026-07-27）**：在最好效果的前提下尽可能偏积极地使用。资格线（提取完成）之下不折；资格线之上，遗憾是不对称的——沉积对之后每一步持续征税，而一次已挣得的折叠只花一次 transition 且可恢复。已挣得却推迟的折叠是拖累，不是谨慎。

Token 降幅、context 百分比、summary depth、checkpoint 数量和工具调用频率都只是诊断指标，不是产品目标。

只有当采用 ACM 后的任务认知与执行效果优于继续使用当前 working set 时，这次 move 才有价值。

## Effect First

固定字符数、token 数、CORE 长度、tool description 长度或 Skill 文件长度都不是产品约束，也不构成优化目标。

除宿主或协议的真实技术上限外，内容是否保留、删除、内联或渐进披露，只依据：

- 是否改变实际模型行为；
- 是否提高任务与注意力效果；
- 是否处于正确的信息层级；
- 是否造成冲突、sediment、duplication 或维护漂移。

短不是天然更好，长也不是天然更完整。Pruning 用于删除无效内容，而不是满足人为长度预算。

长度只有在实际降低 invocation、注意力、可读性、维护或模型行为效果时才构成问题。

## Predictability 的边界

Predictability 约束判断过程，不约束最终选择的 move。

面对不同上下文，同一个判断过程可以正确地得出不同结论：

- 不使用 ACM，继续工作；
- 创建 checkpoint；
- 查看 timeline；
- 执行 local fold；
- rebase；
- rehydrate；
- fork 并在之后返回。

各种任务、工具和 session 边界只提供判断信号；最终 move 仍由同一判断过程得出。

## 判断过程

ACM Judgment 是持续可用的判断视角。当 agent 注意到低价值高噪声内容、一个未来可能值得返回的位置，或 session topology 已开始影响工作时，运行以下判断过程。这些信号只触发判断，不预先决定 move：

1. **Candidate** — working set 中是否存在边际 Attention Value 低于其噪声、竞争或干扰成本的内容？
2. **Compressibility** — 是否能把未来自己真正需要的结论、未决点、当前义务、hot set 与必要 pointers 表达得显著更简练？
3. **Attention effect** — 移走原始过程是否会实质减少干扰、过时信息影响、跨 front 污染或与权威状态的竞争？
4. **Recovery value** — 未来返回当前状态或归档过程是否具有真实价值？
5. **Transition effect** — 预期 Representation Gain 是否大于 Transition Cost 与 Continuity Risk？

Agent 选择预期整体净效果最好的 move 或 move 组合；只有预期效果相当时，较低 Transition Cost 才作为平局条件。

## Move 判断

### Continue

当原始细节仍直接参与接下来的推理、尚不存在明显更好的表示，或改变 working set 产生的返工多于注意力收益时，继续使用当前 working set。

当前 working set 本身仍是最佳表示时，继续工作就是正确的 ACM Judgment 结果。

### Checkpoint

Checkpoint 在 ACM 判断层面近似免费、可自由使用。只要未来可能想回到这个具体位置，它就具有 Recovery Option Value；大量已完成的 legwork、独特 baseline、策略分支或探索前状态都可以形成价值，即使当前结论尚未改变。

Checkpoint 的价值是边际价值：新的 checkpoint 应创造一个未来可能有不同用途的返回位置；它不要求结论已经改变，但不应只为没有不同恢复或检索价值的同一位置重复命名。

每个有价值的 checkpoint 同时都是 Activation Foothold。想起并保存一个状态，会自然提高后续 orientation 与 travel 判断的可达性；后续 move 仍由实际 evidence 与净效果决定。

Checkpoint 的度由未来用途和 catalog 可读性共同体现，而不是由固定数量配额体现。

### Timeline

当 timeline 提供的 topology、checkpoint、branch ownership、summary authority 或 travel-effect evidence 有可能改善当前判断、恢复选择或 target 选择时，可以查看 timeline。

Timeline 只报告事实。它可以自然发生在 checkpoint 之后，并让 travel 更容易被想起；具体 move 仍由 timeline evidence 进入统一判断过程后得出。

### Travel

**提取完成是折叠资格线**：当你已能不回头重读地复述这段历史确定的一切——结论、活着的假设及其证据权重、精确热值——这段历史才可折叠。写 handoff 被迫含糊，说明理解未完成；此时折叠把半成品理解变成之后以重读潮偿还的债。资格线作用于被折叠的那段历史，不作用于整个任务：死胡同的教训已入账、弯路已交出它那一个数字、批量摄入已蒸馏完毕——即使更大的问题仍开放，这段历史也已 spent，可以折叠；`exclusions` 携带死胡同证明的东西。

可恢复性是防意外的保险，不是给未完成提取的许可证：从未提取的东西，你不会知道该回去取什么。

Travel 可以发生在任务之间、任务内部、工具调用前后、探索前后或步骤之间。这些都是可能产生价值的机会类型，不是触发规则。

Travel 应产生有意义的 Representation Gain。这个 gain 可以来自合并多个噪声片段，也可以来自把一次巨大的上下文引入立即变成高度简练的表示。反复处理微小 delta、并且马上需要重读的 transition 属于负收益使用。

## Trusted Handoff

Handoff 是当前自己写给未来自己的权威信息。

Travel 之后，未来的自己应信任 handoff 并从中继续。正常路径不包含强制的 post-travel 验证或重新定位仪式。

Travel 本身不产生重新验证或重新定位义务。未来自己从 handoff 的权威状态直接继续。只有 handoff 已记录的未决验证，或 handoff 之后确有独立外部行为改变事实时，验证才属于真实任务，而不是 transition ritual。仅仅因为发生过 travel 而重新推导信息，说明 handoff 或 travel 判断没有挣回其成本。

## 树即答案空间

Session 曾经知道的一切——每次折叠、每个放弃的分支、每个早期阶段——都留在树里。缺失 session 曾持有的信息时，答案在树里：搜 timeline、rehydrate 分支、重读归档 handoff。向用户重问 session 已知的东西是导航失败，不是谨慎；从文件重建 handoff 已确定的东西是重做，不是验证。

## 边界自认

没有 cue 会开火（感知层只有仪表，宪法第 2 条）。自然折叠点是模型自己能感到的边界：一个请求交付了、一个阶段确定了、一个策略放弃了、一次批量读取蒸馏完了、新请求压在已完成的工作上。边界之间持续压缩（把观察随手整合成结论），让边界到来时提取已经闭合；成批折叠，以有意义的单元提交表示收益。ACM 操作本身是 overhead 不是 deliverable：不叙述、不仪式化，工作本身始终是主题。

## 可观察的对齐

Agent 无需向用户叙述 ACM deliberation。说出了正确理由，不等于做出了正确判断。

对齐通过实际行为评价：

- 使用了哪些 move；
- move 发生在什么时候；
- 它保存或移走了什么状态；
- travel 后是否继续了正确任务；
- 是否无谓重读了刚归档的内容；
- 注意力干扰是否下降；
- 最终任务结果是改善还是退化。

工具结果可以保留用于诊断的机器可读 evidence，但不应把每次 ACM 判断都变成面向用户的说明。

## 度

健康使用位于两个失败模式之间：

- **Sediment** — 明明已有更好的表示，低价值原始过程仍占据 working set；
- **Thrash** — checkpoint 或 travel 把工作切成低价值碎片，产生的 transition 或重读成本超过清理收益。

两个失败模式由同一条资格线分开：提取完成之前折叠产生 thrash，提取完成之后不折叠产生 sediment。因此度不是频率问题，是时机问题；在资格线之上偏积极（见北极星「度」条款），在资格线之下不折。

工作预算（min(窗口, 400K)）是信息，不是截止日：为完成干净提取而超过某个数字是对的，为守住某个数字而脏折是错的。数字永不携带指令；固定百分比锚点（如「舒适巡航 ≈ 1/3 预算」）已废除——它会被顺从模型当成 KPI 追逐。

度由预期净效果决定，而不是全局次数、token 阈值或流程阶段决定。

## 模型期望

guidance 只面向强模型（宪法第 1 条，2026-07-27：本项目只服务 KorenKrita + 强模型组合）。

强模型应理解判断过程，自主使用这些原语，并以 guidance 没有穷举的方式组合 save、orient、fold、rebase、rehydrate 与 fork；ceiling 是主动发现所有净收益为正的机会，并以有创造力、保持任务连续性的方式组合 ACM 原语——包括 guidance 未预见的用法（北极星的惊喜面）。runtime 的机械安全（rollback、receipt、indeterminate 区分）保护操作正确性，不承担教学职责。

## 成功与失败

### 成功

ACM 在减少注意力干扰或提高恢复、探索价值的同时，保持或改善任务正确性、连续性和效率，即为成功。

### 失败

如果 ACM 在没有补偿性任务收益的情况下造成以下任一结果，即为失败：

- 重放错误的旧任务；
- 当前用户义务丢失或被推迟；
- 立即重读刚刚 fold 的材料；
- 重复进行低收益 checkpoint 或 travel；
- 过时事实或已放弃方向重新获得权威；
- 向用户重问 session 已持有的信息，或为「确认 handoff」重读刚折叠的材料；
- 实际出现任务方向偏移、错误修改、无谓返工或其他可观察的 Transition Harm。

## 待完成的设计工作

本契约暂不决定以下实现问题：

- 如何在不设置配额的前提下保持大型 checkpoint catalog 可读；
- 如何在不要求 runtime 推断语义复杂度的前提下交付 advanced guidance；
- 如何让 handoff 构造在机械上简单，同时让未来自己收到清晰、权威、可直接执行的信息；
- 如何让真实 post-travel context 把 handoff 作为权威；
- 当真实任务不可精确复现时，如何评价 attention benefit。
