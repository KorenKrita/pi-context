# Plan 004: 按概念拆分 lib.ts 并删除该杂物层

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 858d25cd..HEAD -- src/lib.ts`
> On a mismatch, compare the export inventory below against the live file
> before proceeding; treat a mismatch as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED（纯搬家，但 `.js` ESM import 路径易漏；循环依赖需检查）
- **Depends on**: 001（001 会在同一批文件里加 import；先让 001 落地，本计划在成品上搬家，避免双向冲突）
- **Category**: tech-debt
- **Planned at**: commit `858d25cd`, 2026-08-14

## Why this matters

`src/lib.ts`（404 行、20+ 导出）不是 module，是五个概念的杂物抽屉：usage 估算、target 解析、refresh 调度、终端文本卫生、label 转发混放一处，被 8 个 src 模块直接 import。删除测试的答案是「散回各调用点」——它从未集中过任何复杂度，只消耗导航性与 review 聚焦（每处 `from "./lib.js"` 都不说明依赖的是哪个概念）。`src/entry-resolution.ts:3-8` 已经开始从它包装转发 `findLastMeaningfulEntry`，职责边界在反向渗漏。本计划按概念拆成具名 module，`lib.ts` 删除，**零行为变化**。

## Current state

`src/lib.ts` 的完整导出清单（`858d25cd`，grep `^export` 实测），按去向分组：

**→ `src/conventions.ts`**（命名与文本卫生 + 共享常量）：
- `ACM_INTERNAL_TOOLS`（Set）、`ANCHOR_SEARCH_WINDOW`（=200）
- `isReservedTargetName`、`sanitizeTerminalText`、`optionalString`

**→ `src/usage-estimation.ts`**（usage/估算家族）：
- 类型 `UsageLike`、`StructuralMessageDirection`、`UsageDelta`
- `formatTokens`、`formatContextUsage`、`calculateUsageDelta`、`classifyStructuralMessageDirection`
- `countActiveSummaryDepth`、`projectSummaryDepthAfterTravel`
- `sumMessageTokens`、`estimateUsageAfterMessageChange`、`estimateUsageAtTravelTarget`

**→ `src/target-resolution.ts`**（树/条目语义/target 解析家族）：
- 类型 `ResolvedTarget`、`MeaningfulSkipReason`、`SkippedEntry`、`MeaningfulResolveResult`、`SessionStructuralView`
- `isValidEntryId`、`pushTreeChildrenPreOrder`、`extractTextFromContent`
- `findInTree`、`getEntryLabel`、`formatEntryLabel`、`findCheckpointLabelOwner`、`resolveTargetId`
- `getMeaningfulSkipReason`、`findLastMeaningfulEntry`

**→ `src/context-refresh-registry.ts`**：
- `ContextRefreshRegistry`（class，~70 行）

**→ 直接从 `src/label-journal.ts` import**（lib.ts 第 6 行只是 re-export `buildLabelMaps`/`LabelMaps`，删转发）。

消费方（改 import 用）：src 侧 8 个——`checkpoint-tool.ts`、`timeline-tool.ts`、`travel-tool.ts`、`runtime.ts`（2 处）、`runtime-lifecycle.ts`、`host-bridge.ts`、`fold-estimate.ts`、`entry-resolution.ts`；test 侧 4 个——`fold-visibility.test.ts`、`timeline-hud-evidence.test.ts`、`deferred-refresh-runtime.test.ts`、`tool-execution.test.ts`（均为 `from "../src/lib.js"`）。**001 落地后 src 侧可能多出 `src/anchor-scan.ts` 等 import 方——开工前先 `grep -rn 'from "./lib.js"' src/` 和 `grep -rn 'src/lib.js' test/` 拉一份现场清单为准。**

内部依赖注意：`resolveTargetId` 内部可能用到 `isValidEntryId`/label 查询等同组函数（同文件内自然解决）；`usage-estimation` 与 `target-resolution` 互不依赖；`conventions` 不依赖任何同批新模块。

仓库约定：ESM、import 带 `.js` 后缀；禁 `console.log`。

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| 现场清单 | `grep -rln 'from "./lib.js"' src/ && grep -rln 'src/lib.js' test/` | 开工前拉取 |
| 类型检查 | `bun run typecheck` | exit 0 |
| 全部测试 | `bun test` | 全绿 |
| 循环依赖检查 | `bun run typecheck`（tsc 会报 TS2305/循环引用错误） | exit 0 |
| 残留检查 | `grep -rn 'from "./lib.js"' src/ ; grep -rn 'src/lib.js' test/ ; ls src/lib.ts` | 全部无输出/不存在 |

## Scope

**In scope**：
- 新建 `src/conventions.ts`、`src/usage-estimation.ts`、`src/target-resolution.ts`、`src/context-refresh-registry.ts`
- 删除 `src/lib.ts`（用 `git rm`，使其进入可恢复的删除记录；不使用回收站流程——git 已跟踪此文件，历史即备份）
- 上述全部 src/test 消费方的 import 行修改

**Out of scope**：
- 任何函数体逻辑改动（连格式都不要动，纯剪切粘贴）
- `src/label-journal.ts`（已有文件，只改消费方指向它）
- `src/entry-resolution.ts` 的包装函数本身（它对 `findLastMeaningfulEntry` 的增强包装保留，只改 import 来源）
- test fixture、`test/host-fixture/`（有独立 lockfile，不碰）

## Git workflow

- 建议单 commit（原子性优先）：`refactor: split lib.ts into named concept modules`。
- 提交身份 repo-local：`git -c user.name="KorenKrita" -c user.email="KorenKrita@gmail.com" commit`。不 push。

## Steps

### Step 1: 新建四个 module（纯剪切）

按 Current state 的分组把函数/类型/常量连同其 JSDoc 注释原样剪切到新文件。新文件顶部补需要的 type import（`SessionEntry`、`SessionTreeNode`、`AgentMessage` 来自 `@earendil-works/*`，`LabelMaps` 来自 `./label-journal.js`）。不导出任何原未导出的符号；不改任何签名。

**Verify**: `bun run typecheck` → 此时 src 仍在 import lib.js，两者并存应 exit 0。

### Step 2: 迁移全部消费方 import

按现场清单逐文件把 `from "./lib.js"` 改为对应新模块（一个文件可能拆成多行 import）；`buildLabelMaps`/`LabelMaps` 改指 `./label-journal.js`；test 文件同理改 `../src/<module>.js`。`src/lib.ts` 用 `git rm src/lib.ts` 删除。

**Verify**: `bun run typecheck` → exit 0；`bun test` → 全绿；`grep -rn 'from "./lib.js"' src/` 无输出；`grep -rn 'src/lib.js' test/` 无输出；`ls src/lib.ts` 报不存在。

## Test plan

零行为变化，不新增测试；既有 7470 行测试全绿即 characterization。若某测试只因 import 路径失败，修 import 即可，不许改断言。

## Done criteria

- [ ] `bun run typecheck` exit 0
- [ ] `bun test` exit 0
- [ ] `grep -rn 'lib\.js' src/ test/*.ts` 除 `label-journal.js` 的合法引用外无 `lib.js` 残留
- [ ] `src/lib.ts` 不存在（`git log --oneline -1 -- src/lib.ts` 能看到删除 commit）
- [ ] `git status` 无越界文件
- [ ] `plans/README.md` 状态行已更新

## STOP conditions

- 剪切过程中发现两个新 module 出现相互依赖或对 `conventions.ts` 之外的新 module 依赖成环——说明分组错误，报告分组冲突后停。
- 任一测试因非 import 原因失败。
- 现场清单比上文多出 001 之外的新消费方且其 import 无法按分组归位。

## Maintenance notes

- 今后新代码禁止再造 `lib.ts` 式杂物层；新函数先问属于哪个概念 module。
- review 重点：diff 里除文件移动与 import 行外应无任何其他行变化（`git diff --find-renames` 复核）。
