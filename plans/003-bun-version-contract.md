# Plan 003: 把 Bun 版本契约写进开发者前置条件

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 858d25cd..HEAD -- README.md AGENTS.md .github/workflows/verify.yml`
> On a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S（~10 分钟）
- **Risk**: LOW
- **Depends on**: none
- **Category**: dx
- **Planned at**: commit `858d25cd`, 2026-08-14

## Why this matters

所有测试与完整验证（`bun test`、`bun run verify:acm`）都通过 bun 执行，CI 在 `.github/workflows/verify.yml:43-46` 用 `oven-sh/setup-bun` 固定 `bun-version: 1.3.14`。但 `package.json` 只声明 `packageManager: "npm@11.13.0"` 与 `engines.node >= 22.19.0`，README 的「开发」节（:75-80）直接要求 `bun run verify:acm` 而从未提到 bun 的安装与版本。新贡献者本地与 CI 的 bun 版本可能不同——bun 作为测试执行器与 TypeScript loader，版本差异会造成本地不可复现的失败或假绿。

## Current state

- `.github/workflows/verify.yml`（Setup Bun 步骤，`858d25cd`）：

```yaml
      - name: Set up Bun
        uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2.2.0
        with:
          bun-version: 1.3.14
```

- `README.md`「开发」节（:75-80）：

```markdown
## 开发

```bash
npm ci --ignore-scripts
bun run verify:acm   # 生成物一致性 + 全部测试 + 类型检查 + 真实 Pi host fixture
```
```

（该节无任何 bun 安装/版本说明。）
- `package.json`：`"packageManager": "npm@11.13.0"`、`"engines": { "node": ">=22.19.0" }`，无 bun 声明。
- `AGENTS.md`「技术栈与版本契约」节列出四个 `@earendil-works/*` 0.84.0 与 node 下限，未提 bun。

仓库文档语言：中文（README/AGENTS.md 均是），保持中文。

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| 验证版本存在 | `git log --oneline -1 -- .github/workflows/verify.yml` | 有输出（文件被跟踪） |
| 完成后检查 | `bun run typecheck` | exit 0（纯文档改动，应无影响） |

## Scope

**In scope**：
- `README.md`（仅「开发」节）
- `AGENTS.md`（仅「技术栈与版本契约」节，加一行）

**Out of scope**：
- `package.json`（`packageManager` 字段已被 npm 占用，加 bun 声明没有标准机制；不引入新工具链文件如 `.bun-version`——CI 的 pin 已是唯一权威，文档只负责陈述它）
- `.github/workflows/verify.yml`
- 任何源代码

## Git workflow

- 单 commit：`docs: state the bun version contract for local development`。
- 提交身份 repo-local：`git -c user.name="KorenKrita" -c user.email="KorenKrita@gmail.com" commit`。不 push。

## Steps

### Step 1: README「开发」节补前置条件

在 `## 开发` 标题与 `npm ci` 代码块之间插入一段（措辞可微调，事实不可变）：

```markdown
本地验证依赖 Bun；CI 固定使用 `1.3.14`（见 `.github/workflows/verify.yml`），本地请安装同版本以避免测试执行器差异：

```bash
curl -fsSL https://bun.sh/install | bash   # 或 brew install bun，然后切到 1.3.14
```
```

### Step 2: AGENTS.md「技术栈与版本契约」节加一行

在该节现有条目后追加（与既有列表风格一致）：

```markdown
- 测试执行器为 Bun，CI 固定 `1.3.14`（`.github/workflows/verify.yml`）；本地复现 CI 结果需同版本
```

**Verify**: `grep -n "1.3.14" README.md AGENTS.md` → 两处命中；`bun run typecheck` → exit 0。

## Test plan

纯文档，无新测试。验证 = grep 命中 + typecheck 不受影响。

## Done criteria

- [ ] `grep -n "1.3.14" README.md AGENTS.md` 两处命中
- [ ] `git status` 只有这两个文件改动
- [ ] `plans/README.md` 状态行已更新

## STOP conditions

- `verify.yml` 里的 bun 版本已不是 `1.3.14`（以现场值为准更新文档，并在报告中说明）。

## Maintenance notes

- 升级 CI bun 版本时，这两处文档必须同步改——建议在 verify.yml 的升级 PR 里顺手带上。
