# AGENTS.md — pi-context 项目知识库

## 概述

**pi-context** 是 [pi-context (ttttmr)](https://github.com/ttttmr/pi-context) 的 fork，由 KorenKrita 独立维护。它为 Pi agent 提供主动上下文管理能力，暴露三个 ACM 工具：

| 工具 | 作用 |
|---|---|
| `acm_checkpoint` | 给会话历史节点追加语义 save point（label alias） |
| `acm_timeline` | active / checkpoints / search / tree 单一视图与 HUD |
| `acm_travel` | fold：回到较早节点，把之后的历史替换为七行 handoff |

设计立场（2026-07-31 affirmative-guidance 重构后）：**代码层厚，注入层薄，文案全部正向肯定**。运行时正确性（事务、回滚、协议校验、settled sync）由代码和测试保证；给模型的引导只有恒定面，无 Skill、无流程机器、无阈值措辞。

### 重构的实证依据

boundary ledger 记录了 202 个真实 user-request boundary、0 次真实 fold（2026-07-27 至 07-30，doctrine 时期文案）；有 session 到 68% budget、561 条 entry 仍零调用。归因：判断门槛叠加（extraction bar + cold start + 否定式警告）、七字段全必填的 schema 摩擦、skill 层自我驱逐。本次重构以「LLM 遵循肯定指令远好于否定指令」为文案第一原则，转化率由修复后的 ledger 持续观测。

## 模型可见文案的宪法

1. **正向肯定**：指令一律写"做什么"，不写"不要做什么"。幸存的禁止句必须是真实安全边界（如 travel 单独成批）。示例可以展示失败形态（定义 "vague"），指令不可以。登记在案的禁止句例外：continuation replay fence（`context-packet.ts` 投影的 continuation 中恰好一条 "Do not execute or repeat an earlier request…"，防 travel 后 phantom replay——ledger 证据只覆盖 travel 前的 fold 压制，不外推到 travel 后围栏；`test/guidance-quality.test.ts` 以渲染级测试锁定"恰好一条"）。
2. **感知面只报事实**：gauge 承载数字 + 恒定结构标记（`boundary`、`Npts`、双折叠针带消息数），零措辞、零阈值、零选时机。带判断的文字只住在 CORE。
3. **一个事实一层**：CORE=判断（何时/为何），tool description=机制（怎么用+一个关键事实），参数 description=纯机制，promptSnippet=一行场景钩子，promptGuidelines=触发词清单（自带工具名），result cue=状态转移+下一步，recovery=具体恢复动作。例外必须显式声明（现有：回程票三层各司其职、file-backup 消歧三处、target 选择规则两处）。
4. **上下文过去 ≠ 文件过去**：任何文案不得暗示 checkpoint/travel 能撤销命令或恢复文件。
5. **不折也是完整判断**：boundary 标记不是折叠命令；"Vague → continue" 与 "Concrete → fold" 同等合法。fold test（"能否不回读就写出具体 handoff"）是唯一判断标准，不得引入第二道门（cold-start 证明、任务完成度、阈值）。
6. **词汇封闭**：任何 runtime 输出（HUD、receipt、warning）中的术语必须被九面之一教过。已退役词汇（rebase、rehydrate、sediment、thrash、extraction bar、cold start、hot set）不得回到模型可见字符串；`test/guidance-quality.test.ts` 的 negative locks 锁死这一条。

文案九面：CORE、tool descriptions、参数 descriptions、result cues、promptSnippets、promptGuidelines、recovery 文案、TREE_SUMMARY_INSTRUCTIONS、gauge 后缀。第十面是 runtime 动态文本（HUD 行、receipt、动态 warning），同样受宪法约束。

## 技术栈与版本契约

- TypeScript ESM，source-first：Pi 直接加载 `src/*.ts`，生产不依赖 `dist/`
- 工具参数 schema 使用 `@earendil-works/pi-ai` 的 TypeBox `Type.*`
- 四个 `@earendil-works/*` peer/dev dependency 精确固定 **`0.82.1`**（含 `test/host-fixture/`），不要改成 range
- **不使用** Pi 的 `constrainedSampling`：handoff schema 含 `Type.Optional` 字段，OpenAI strict 要求全 properties 进 required，开启会 400
- 根目录提交 npm `package-lock.json`（Pi git 安装走 `npm install --omit=dev`）；改 `package.json` 后必须重新生成并从 committed tree 验证 `npm ci --ignore-scripts`

## 架构

`src/index.ts` 是 composition root：创建 `AcmSessionRuntime`、注册 canonical prompt injection、三个工具、lifecycle handlers。

| 路径 | 责任 |
|---|---|
| `src/checkpoint-tool.ts` | checkpoint schema、自动 protocol-complete 锚定、fold 投影回执 |
| `src/timeline-tool.ts` | strict single-view timeline、HUD、投影收益 |
| `src/travel-tool.ts` | handoff 验证、自动回程票、travel evidence、settled sync 调度 |
| `src/handoff.ts` | 三必填四可选 wire schema、"none" 缺省、canonical 七行文本、`deriveReturnTicketName` |
| `src/context-packet.ts` | LLM-bound packet 重建、tool protocol normalization、ACM continuation 投影 |
| `src/travel-coordinator.ts` | backup → branch → verify → compensate 单次事务 |
| `src/host-bridge.ts` | readonly SessionManager 到 mutation capability 的唯一 guarded seam |
| `src/runtime.ts` | 按 SessionManager 隔离 usage、refresh、gauge state（含 boundary 追踪）、settled sync |
| `src/runtime-lifecycle.ts` | context rebuild、gauge 装配（boundary/savePoints/双针）、settled sync、compaction、`/tree`、cleanup |
| `src/context-gauge.ts` | 仪表格式化、里程表节奏、boundary 强制首读 |
| `src/context-pressure.ts` | working-budget pressure（400K cap policy） |
| `src/fold-estimate.ts` | 双折叠针投影（剩余压力 + 消息数），计入 handoff 名义成本 |
| `src/boundary-ledger.ts` | 被动 append-only 观测（boundary/fold 行，fold 区分 direction） |
| `src/live-agent-session-adapter.ts` | capability-probed live sync 与 settled-boundary replacement |
| `src/generated-guidance.ts` | 生成产物，不要手改 |

### Guidance 管道

`skills/context-management/CORE.md`（道+度）与 `TOOL-CONTRACTS.md`（术）是唯一文案来源；改完必须跑：

```bash
bun run generate:guidance
```

CI 用 `--check` 校验一致性。没有 SKILL.md、没有 references/、没有 advanced routing——skill 层已整体删除（2026-07-31），不要恢复。

## 核心机制契约

### Handoff（三必填四可选）

wire 上 `goal/state/next` 必填；`evidence/external/exclusions/recover` 可选，缺省或显式空串补 `"none"`。持久化文本始终渲染七行 `Goal:/State:/Evidence:/External:/Exclusions:/Recover:/NEXT:`（解析锚点，保持英文）。必填字段不接受 "none"。unexpected field 仍是 defect。

### 自动回程票

每次 travel 都给 pre-travel head 记 archive alias，写入 handoff 的 Recover 行（`Raw archive: <name>`）：

- 名字来源优先级：`backupCurrentHeadAs` 显式覆盖 → head 已有 label 复用（不 displace）→ `deriveReturnTicketName(goal)`（slug + 序号防撞）
- 锚定规则与 checkpoint 自动锚定一致：从 pre-travel head 向后走，跳过需要 repair 的 entry，取最新 protocol-complete entry，窗口 `ANCHOR_SEARCH_WINDOW`
- 找不到 protocol-complete prefix 时 travel 整体 abort（`no_protocol_complete_backup_target`）
- receipt 的 `backupCurrentHeadAs` details 字段始终报告解析后的实际名字

### Gauge

形态（canonical 两例）：

- 大窗口：`[ctx 75% budget(400K) · 300K/1M window · boundary · 3pts · fold@turn→24% -38msg · fold@task→11% -92msg]`
- 小窗口（window ≤ 400K）：`[ctx 43% window · 86K/200K · boundary · 3pts · fold@turn→24% -38msg]`

- 单百分比：永远只有一个 pressure 百分比，自带尺名。`policy === "400k-cap"` 时为 `N% budget(400K)`（budget = min(window, 400K)），否则为 `N% window`；百分比一律从 tokens 计算（`pressurePercent`），不用 host percent（estimate 路径 clamp 到 100 且可能与裸数不一致）
- 裸 token 段 `used/window` 是 >100% 解毒剂，绝不砍；大窗口上 budget 读数可超过 100% 且不 clamp；小窗口 100% 是硬墙
- token 缩写截断不四舍五入（`399999→399.9K`，`400000→400K`），单位选择基于原始值（`999999→999.9K`）；去尾零（`1M` 不是 `1.0M`）；canonical 实现唯一（`formatTokenCount`，`src/context-pressure.ts`）
- `boundary`：每个 user request 的首个 gauge reading 上出现的恒定结构标记
- `Npts`：active path 上的 save point 数
- 双折叠针：`fold@turn→X% -Nmsg`，剩余压力与 leading 百分比同尺 + 消息 delta（`-Nmsg`；0 或未知时省略尾数，不产生 `-0msg`）；参照点不存在时省略该针；斜杠全行只表示部分/整体
- 节奏：budget（小窗口即 window）百分比整数位变化即显示（双向）+ **每个 request 首读强制显示**（boundary entry id 变化触发）
- 重置点：明确成功的 travel、`session_compact`、`/tree` 导航、`session_start`
- 豁免：`acm_*` 结果与 error 结果永不装饰
- provider-active 阶段 pressure 只采用最近 provider `turn_end` usage
- kill switch：`ACM_GAUGE_DISABLED=1`，按调用时读取
- 五面同 grammar：gauge 后缀、checkpoint 回执/renderer、travel 回执（budget 口径 details 字段 `budgetBeforePercent` 等；旧 hard-window 字段保留不改义）、timeline HUD/renderer/checkpoints 视图、ledger；每面的百分比与裸分子必须来自同一个 `ContextUsagePressure`

### Travel 事务与 settled sync

顺序：解析 target → 验证 handoff → 解析回程票 → prevalidate → coordinator（backup label + rollback token → `branchWithSummary` → verify → compensate）→ schedule persistent refresh 与 settled ticket。

- mutation outcome 三态：`applied` / `not_applied` / `indeterminate`；`indeterminate` 只 schedule observation refresh
- `agent_settled` 是 native replacement 的唯一 apply boundary；`agent_end`（尤其 error）不是
- finalized error receipt 取消 provider cutover 与 native ticket
- persistent rebuild 最多 3 次，之后 `cached_exhausted`
- travel 只改会话上下文，不回滚文件/进程/外部系统
- overflow-retry 尾部修复（`stopReason === "length"` 的 assistant 消息移除）保留

### Boundary ledger

被动 append-only 观测：每个不同 user boundary 一行、每次 applied travel 一行（`direction: "fold" | "restore"`，按 messageDelta 符号区分）。只记计数与百分比，绝不记内容；写失败一律吞掉；`MAX_LEDGER_BYTES` 上限；`ACM_LEDGER_DISABLED=1` 静默。测试经 `test/setup.ts` bunfig preload 与 fixture `ledger-guard.ts` 强制禁用。两类行都带 `gauge` cohort 字段（`ACM_GAUGE_FORMAT_VERSION`，当前 `"v2"`）；旧行缺失该字段即 legacy cohort，不写 null。

**核心观测指标**：跨 40% budget 的真实 session 中出现 ≥1 次 fold 的比例（重构前基线 0/42）。

### Checkpoint 契约

- 默认 target 是本次调用前最新的 protocol-complete active-branch leaf；紧邻 prefix 需 repair 时向前找，窗口内找不到则不写 label
- alias 大小写敏感全树唯一；同一 entry 可多 alias（journal 重放实现，host 每 entry 只存一个 label）；`root` 保留
- 显式 node ID 可指向任意 entry；非 USER/AI target 产生 warning

### Timeline 契约

strict `view` discriminator：`active`（默认）/ `checkpoints` / `search` / `tree`。HUD 报告 usage、pressure、handoff layers（模型可见术语；details 键仍为 `activeSummaryDepth`）、fold projection、sync state——只报事实，不含判断行。checkpoints 视图列出投影收益并标注 `[raw archive]`。每次调用受 context-derived entry/character budget 约束。

### Manual `/tree`

`session_before_tree` 在用户选 plain "Summarize" 时注入 `TREE_SUMMARY_INSTRUCTIONS`（七行 handoff 形态）；用户自定义 instructions 永远优先。`session_tree` 清空该 SessionManager 的易失 runtime state 并重置 gauge cycle。

## 测试与验证

测试哲学：少而狠的行为契约测试。每个测试锁一个用户可见行为或安全边界；不锁实现字符串镜像；pass 数不是质量指标。`test/guidance-quality.test.ts` 锁重构的核心赌注（三必填、fold test 唯一性、boundary 合法双向、negative locks）。

```bash
bun test                  # 全部单元测试
bun run typecheck         # tsc --noEmit
bun run generate:guidance # 从 canonical 源重新生成
bun run verify:acm        # 完整 gate：guidance check + 测试 + typecheck + host fixture
```

host fixture（`test/host-fixture/`）在真实 Pi 0.82.1 上验证宿主契约：exact version、CORE 注入、prompt metadata、三必填 schema、自动回程票锚定（含跳过受损 stretch）、travel/settled sync 全链路、multi-session 隔离。独立 lockfile 和构建（`bun ./build-source.mjs`），根目录 `bun test` 不含它。

不要使用 `console.log`；用户可见 warning 用 `ctx.ui.notify()`。

## Git

- 提交身份：`KorenKrita <KorenKrita@gmail.com>`（repo-local）
- doctrine 时期的完整教义（judgment contract、failure mechanisms、eval 装置）保留在 git 历史与 tag `eval-archive`
