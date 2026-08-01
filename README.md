# pi-context

让 Pi agent 自己整理自己的记忆。

## 它解决什么问题

跟 agent 做一个长任务时，对话历史会越堆越长。里面大部分是"过程"——读过的日志、试错的弯路、已经修完的报错。这些内容任务早就消化完了，却还一直占着模型的注意力，让它越来越贵、越来越钝。

Pi 自带的办法是 compaction：窗口快满时自动把历史压成一段摘要。它的问题是**单向**——压掉的细节永远回不来，时机和质量你都控制不了。

`pi-context` 换一种思路：给 agent 三个工具，让它像人整理行李一样，**自己决定**什么时候把哪段过程收起来。收起来的东西不是删了，而是放进会话树的档案里——哪天需要哪个细节，随时能回去取。

一句话：**Pi 原生 compaction 是有损压缩，pi-context 是可逆收纳。**

## 三个工具

| 工具 | 一句话 |
|---|---|
| `acm_checkpoint` | 存档点。给当前状态起个名字，之后随时能回来。 |
| `acm_timeline` | 地图。查看当前对话的主干、所有存档点、搜索整棵历史树。 |
| `acm_travel` | 收纳。把一段已经消化完的过程折叠成一份简短的交接单，历史原文留在树里。 |

安装后不需要手动调用。agent 会在合适的时机自己用；你也可以直接说"存个档"、"看看时间线"、"回到刚才那个点"。

## 交接单（handoff）

折叠不是删除，是把一段过程换成它的精华。`acm_travel` 要求 agent 写一份七个字段的交接单，写给"折叠之后的自己"：

```json
{
  "goal": "完成 parser 迁移并保持现有行为。",
  "state": "实现已完成，测试通过；仍需更新 README 示例。",
  "evidence": "bun test；src/parser.ts；test/parser.test.ts",
  "external": "src/parser.ts 已修改，尚未提交。",
  "exclusions": "不再尝试 recursive-descent 方案。",
  "recover": "parser-raw",
  "next": "更新 README 中的 parser 示例。"
}
```

- **goal / state / next** 必填：目标是什么、现在什么状态、下一步做什么。
- **evidence / external / exclusions / recover** 可选：证据在哪、改过哪些文件、放弃过哪些方向、想回头时去哪——用到才写，省略自动记为 `none`。简单场景三个字段就够。
- 每次折叠都会自动给折叠前的位置记一张"回程票"（archive alias），写进 Recover 行——想找回原文时直接 travel 过去。

合格标准只有一条：一个完全不知道前情的新 agent，只靠这张单子就能无缝接着干。写不出来这样的单子，说明这段过程还没消化完，还不到折叠的时候。

## 仪表

普通工具结果的末尾会带一行小字（`acm_*` 与出错的结果除外）。大窗口模型上：

```text
[ctx 75% budget(400K) · 300K/1M window · boundary · 3pts · fold@turn→24% -38msg · fold@task→11% -92msg]
```

小窗口（不超过 400K）模型上：

```text
[ctx 43% window · 86K/200K · boundary · 3pts · fold@turn→24% -38msg]
```

每个百分比自带它所度量的尺名：`budget(400K)` 是注意力预算（模型窗口和 400K 取小），大窗口上可以超过 100%，不截断；`window` 直接对着物理窗口读，100% 就是硬墙。旁边的裸 token 数（已用/窗口）始终报告对物理窗口的绝对位置——那是硬上限。然后是 `boundary` 标记（每个新请求的首次读数）、路径上的存档数，以及两根折叠针——折到上一段开头 / 折到最早存档点，各自显示折后剩余压力和会折掉的消息数。整数位变了才显示，每个新请求的首次读数必显示。

它只报数，从不建议做什么——什么时候整理，是 agent 自己的判断。设 `ACM_GAUGE_DISABLED=1` 可以关掉。

## 安装

```bash
pi install git:github.com/KorenKrita/pi-context
```

或者在仓库目录里本地安装：

```bash
pi install .
```

> 本 fork 只发布在 GitHub。npm 上未带 scope 的 `pi-context` 是上游项目，不要用 `npm install` 装这个 fork。

也可以不安装、临时加载：

```bash
pi -e /path/to/pi-context/src/index.ts
```

## 安全边界

- Travel 只改变 Pi 的会话树和之后发给模型的上下文，**不会**回滚文件、进程、Git 提交或任何外部系统。
- 折叠永远可逆：原始历史留在树里，一次 travel 就能回去。
- 扩展不取消、不替换 Pi 原生 compaction——真正超长的任务照样可以让原生机制兜底。
- 每次操作都返回可核对的事实回执（改了哪个节点、深度变化、同步状态）；不确定的结果如实标注 `indeterminate`，不伪装成功。

## 开发与验证

```bash
npm ci --ignore-scripts
bun run verify:acm
```

完整 gate 覆盖：生成文本一致性检查、全部单元测试、TypeScript 类型检查、以及在真实 Pi `0.82.1` 上运行的 host fixture。

架构细节、host 兼容性契约、文案宪法与维护规则见 [`AGENTS.md`](AGENTS.md)。

## 致谢

- [pi-context](https://github.com/ttttmr/pi-context) — 原始项目 by ttttmr
- [让 AI 主动管理自己的上下文](https://blog.xlab.app/p/6a966aeb/) — 设计思路

MIT License
