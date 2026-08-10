# scripts/review — 定性 session 复盘管线

对真实 Pi session 做 ACM 采纳行为的定性复盘:一个 session 进,一份中文备忘(memo.md)出。备忘回答四个问题——任务相位如何演变、每次折叠的得失、哪里该折没折(带归因分类)、理想操作者会怎么做——并附机器可读 YAML 摘要供跨备忘汇总。

## 用法

```bash
# 一步到位(推荐)
python3 scripts/review/run-review.py <session.jsonl> <outdir>

# 只探测,不产出(选材用;打印 manifest,含 acm_active)
python3 scripts/review/render.py <session.jsonl> --probe

# 换模型 / 换分段大小
python3 scripts/review/run-review.py <s.jsonl> <outdir> --model local-openai/deepseek-v4-flash --max-bytes 1500000
ACM_REVIEW_MODEL=... python3 scripts/review/run-review.py ...
```

退出码:`0` 成功;`2` session 不可复盘(ACM 扩展未激活,见下);其他为错误。

## 设计要点(为什么长这样)

- **ACM 未激活即拒绝**:transcript 里既无 gauge 行也无 acm_* 调用时,复盘评的是"没人收到的指引",结论必然作废(memo6 教训)。`--force` 可覆盖,但产出的备忘不应计入观测。
- **强制全读契约**:提示词把渲染脚本统计的结构事实(条目数、首末 ID、BRANCH_SUMMARY/LABEL 清单)写进 prompt,要求 reviewer 在第 0 节提交覆盖证明(末段+中段短引文)、第 1 节交无缝相位表。跳读会在这两处露馅。
- **超窗分段**:超过 `--max-bytes`(默认 1.5MB ≈ 400K token 内)的 session 切成多段,逐段产阅读笔记(部分模板),最后一步综合(synthesis 模板)。综合步骤只见笔记不见原文,所以部分模板强制记录五类关键事件,漏记即永久丢失。
- **干净的 reviewer**:所有 LLM 调用走 `pi -p --no-session --no-extensions --no-skills`,reviewer 自己不跑 ACM,不产生递归观测。
- **机器可读摘要**:每份备忘末尾的 YAML 块(folds_observed、missed_folds 归因 A/B/C/D、checkpoints_set/used 等)让多份备忘可以脚本化汇总,与 boundary ledger 的定量数据互补。

## 文件

| 文件 | 作用 |
|---|---|
| `render.py` | JSONL → 无损 transcript(单份或分段)+ manifest(结构事实、acm_active、分段边界);`--probe` 只打 manifest |
| `prompt-template.md` | 单份完整 transcript 的复盘提示词 |
| `prompt-template-part.md` | 分段管线的逐段阅读笔记提示词 |
| `prompt-template-synthesis.md` | 分段管线的综合提示词 |
| `run-review.py` | 编排:渲染 → 激活检查 → 选管线 → 调 `pi -p` → 写 memo.md |

## 归因分类(第 3 节 taxonomy)

- **A 跨请求跳过**:boundary 出现、上一段已消化,未自问 fold test 直接开工;
- **B 长请求内无钩子**:请求内部相位转换点(探索→编辑等)无自问;
- **C 低压静默**:压力 <40% 且段落已消化,因"还不需要"而不折(CORE 不承认此豁免);
- **D 其他**。

这套分类来自 2026-08-10 首轮五份有效备忘的归纳;它是观测标签,不是 CORE 文案的一部分。
