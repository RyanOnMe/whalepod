# DSH client UI vendored 出处台账

本文件是 **vendored 代码的出处与许可登记册**，不是验收报告：它回答「这段代码从哪来、什么版本、许可义务在哪落实、上游变了怎么办」。

权威来源（冲突时以它们为准）：

1. [ADR-0008](../adr/0008-fork-dsh-client-ui.md) — Fork DSH client UI 源码的分层决策与落地约束（**决定布局**）；
2. Issue [#138](https://github.com/RyanOnMe/whalepod/issues/138) — 仓库所有人 2026-09-10 裁决与尽调事实（**决定范围与品牌剥离**）；
3. [NOTICE](../../NOTICE) / [TRADEMARKS.md](../../TRADEMARKS.md) — 本仓的分发与商标政策。

> ADR-0008 的引用状态（写作时核实）：该 ADR 已提交在分支
> `chore/p1-138-adr-fork-dsh-client-ui`（commit `9690cf1`），**尚未合入 `main`**
> （写作时本分支基线 `main` HEAD = `b5187d7`）。因此上面第 1 条链接在 ADR 合入前
> 于 `main` 上是悬空的——本台账引用的是**已评审待合入**的决策文本，不是虚构文件；
> ADR 合入后本注可删。

> **状态：映射已按实测回填（哈希三列核对，锚点 `069b2f1` = 实现线冻结点）。** 首批 L1+L2 切片已提交在 `feat/p1-138-vendor-ui-primitives` 分支：`ee9c4b5` 落地 vendored 子树与 L1 token → `f3452f0` 补 Q5 判据 → `8490228`（AA 重映射 + 出处头改①/②分类）→ **`069b2f1`（修正两处计数）**。第 3 节的路径、**三列 blob SHA**、字节数与改动分类均**实测自锚点 `069b2f1` 的提交内容**（`git rev-parse <commit>:<path>` + 按注释块剥出处头 + diff，方法见 §3.4），不是从任务描述或工作区快照推测的。
>
> **哈希是锚，commit 号是锚点的名字**：本台账早期版本曾对**工作区**取值，而该分支随后又改了 vendored 文件，导致整列记录失效而仍标"已实测"——**凡本台账的数字都应能在标明的 commit 上复算出来**，工作区值不作为依据（§3.4 有对账纪律）。锚点前移时**整套重算**，不要只改个别格子。另注意两条读表前提：**上游 blob ≠ 本仓 blob**（每个文件都带出处头块），比较必须用「剥出处头后」那一列；**出处头行数不是固定的 5 行**（①/② 分类陈述后为 5–7 行），剥头按注释块剥，见 §3.2。

---

## 1. 上游钉版

| 项 | 值 |
|---|---|
| 上游仓库 | `https://github.com/deepseek-ai/deepseek-harness` |
| 默认分支 | `master` |
| **取用 commit** | `c291e7961a515f6d7af9304e7fd1d257929aef26` |
| 取用日期 | 2026-09-10（UTC） |
| 上游许可 | MIT |
| 上游 `LICENSE` blob | `c1f7a78e89e4e4dc7b86664c3b3c76eb5eee1785`（1065 B） |
| 版权行 | `Copyright (c) 2026 DeepSeek` |
| 取用版本 | `@deepseek-ai/dsh-client-ui-theme` / `-ui-primitives` 均 `0.1.5-rc.2` |

取用命令与输出（2026-09-10，本机 GitHub CLI，账号凭据不入库）：

```console
$ gh api repos/deepseek-ai/deepseek-harness --jq '{full_name,default_branch,license:.license.spdx_id}'
{"default_branch":"master","full_name":"deepseek-ai/deepseek-harness","license":"MIT"}

$ gh api repos/deepseek-ai/deepseek-harness/commits/master --jq .sha
c291e7961a515f6d7af9304e7fd1d257929aef26
```

**上游仍在 developer preview**（ADR-0008 §6）：这个 SHA 是「我们分叉出去多远」的唯一基准。ADR-0008 §3 明确要求**先钉 SHA 再取源**，且 npm 分发物是编译后的 JS（CSS 打进 JS）——**只能从源码仓按这个 SHA 取，不能从 `node_modules` 提取**。

### 1.1 取源纪律（ADR-0008 §3 逐条）

- 只从上游源码仓按上表 SHA 取；**禁止**从 `node_modules` 或 npm tarball 提取（那里没有源码）。
- 人工比对 + 更新 SHA 是唯一的同步方式，**不存在自动合并**。
- 「可复跑取源脚本」与 L3 视图一起评估；**脚本未落地前不得声称可复现**。目前本台账的取源可复现性 = 上表命令 + 第 3 节的逐文件 blob SHA 核对，仅此而已。

---

## 2. 本仓落地位置

ADR-0008 §3 的硬约束：vendored 代码是**复制品，不是依赖**。

| 角色 | 本仓路径 | 说明 |
|---|---|---|
| vendored 源码子树 | `apps/web/src/vendor/dsh-ui/` | 应用内专用子树；**不进** `packages/*`、**不进** workspace |
| 上游 MIT 全文副本 | `apps/web/src/vendor/dsh-ui/LICENSE` | 许可承载点（见 §5.2） |
| 出处清单（机器可读） | `apps/web/src/vendor/dsh-ui/manifest.json` | 上游 repo + 取用 SHA + 逐文件映射 |
| 出处台账（本文件） | `docs/agent/dsh-ui-vendoring.md` | 人读的汇总登记 |
| L1 主题 token | `apps/web/src/styles/dsw-tokens.css` | 从 `ui-theme` 设计 token 剥离 cordis 后的产物 |

为什么**不做成 workspace 包**：它必须是「看起来就知道是复制品」的东西，而不是一个能被别人当依赖装的包。只能按本仓**相对路径** import，**不得**以包说明符或 `@deepseek-ai/ui-*` 名义解析。

---

## 3. 逐文件映射表

**读法**：`blob sha` 一列是上游在该 commit 下的 blob SHA，用来在回填时逐字节核对取到的确实是钉住的那一份。

### 3.1 L1 主题 token（已实测回填）

本仓只有一个 L1 产物：`apps/web/src/styles/dsw-tokens.css`（**6033 B**，实测）。它是对上游 `design-platform.css` 的**派生白名单**，不是逐字节复制。

| 上游路径 | blob sha | 字节 | 本仓产物 | 实际关系（已核实） |
|---|---|---|---|---|
| `packages/client/ui-theme/src/styles/design-platform.css` | `bc4712b223be682a6066ed706d25b1aadb9254a4` | 19109 | `apps/web/src/styles/dsw-tokens.css` | **派生**：见下方变量账 |
| `packages/client/ui-theme/src/styles/base.css` | `4c801b8d4dddd3c7a1e619ad8ee0d58eb3a55b11` | 836 | 无（未复制） | 仅用于**确认** `body[data-ds-dark-theme]` 的明暗切换语义，未取任何声明 |
| `packages/client/ui-theme/src/styles/gradient-shadow-text.css` | `36fee4941590cbc09a15a67a8fb4e2c577ea2952` | 14722 | 无 | 未取用 |
| `packages/client/ui-theme/src/styles/scrollbar.css` | `d61bcbcedbdb2459d86220667faf9ed885d3100b` | 4343 | 无 | 未取用 |
| `packages/client/ui-theme/src/styles/corner-shape.css` | `70197aa6a34fc52ef510f247acf11aef024ce98a` | 1135 | 无 | 未取用 |
| `packages/client/ui-theme/src/styles/shiki.css` | `c7a3c5d27219d146d965d0fb37fcc0445d32b089` | 1181 | 无 | 未取用 |

**变量账（实测复算，三个数要分清）**：

| 口径 | 数量 | 复算命令 |
|---|---|---|
| 6 个组件 CSS **引用**的 `--dsw-*` 变量 | **23** | `grep -hoE '\-\-dsw-[a-z0-9-]+' apps/web/src/vendor/dsh-ui/*.module.css \| sort -u \| wc -l` |
| `dsw-tokens.css` **声明**的 `--dsw-*` 变量 | **26** | `grep -oE '^\s*--dsw-[a-z0-9-]+' apps/web/src/styles/dsw-tokens.css \| sed 's/^ *//' \| sort -u \| wc -l` |
| 上游 `design-platform.css` 的静态色阶 `--dsw-static-*` | **73** | `gh api -H 'Accept: application/vnd.github.raw' …/design-platform.css?ref=$SHA \| grep -oE '\-\-dsw-static-[a-z0-9-]+' \| sort -u \| wc -l` |

26 与 23 的差是 3 个**仅被 alias 声明消费**的静态色阶（`--dsw-static-amber-900` / `-green-900` / `-red-900`）；即"引用 23、声明 26"不矛盾。**关键正确性属性（实测）**：组件引用的 23 个**全部**在 `dsw-tokens.css` 里有声明——`comm -13` 的差集为空，即**没有未解析引用**，不会静默落到 CSS fallback。`dsw-tokens.css` 文件头写的"共 23 个"指的就是**引用口径**。

> **两处计数错值已由 `069b2f1` 修掉（原「待转实现线」项，现销账）**：`apps/web/src/styles/dsw-tokens.css` 文件头与 `manifest.json` 的 `tokens[0].adaptations` 此前均写"上游静态色阶 **78** 个"，实测为 **73**；`manifest.json` 的 `components[]`（`index.ts` 条）写"上游桶文件含整包 **43** 个原语"，而 **43 是 `packages/client/ui-*` 的包数**，`ui-primitives/src` 顶层实测 **29 个 `.tsx`**。这些错值都属实现线文件，**本台账无权修改**，当时只登记正确值；`069b2f1` 已把实现线文件一并改正（现为 73 / 29 `.tsx` / 30 原语 / 43 包数，见 §3.4）。白名单口径本身（23 个引用变量）与 `dsw-tokens.css` 实测吻合，无需改动。

**派生形态与声明义务**：`dsw-tokens.css` 的文件头自带来源声明（上游 repo / 上游文件路径 / 取用 commit / MIT 与版权行），符合 ADR-0008 §3「子树内保留上游 LICENSE 全文与 `Copyright (c) 2026 DeepSeek`」的要求。派生**不豁免** MIT 的声明义务——MIT 覆盖 "copies or substantial portions of the Software"，被抄的 token 取值正是 substantial portion。见 §5。

**L1 的已知边界（已核实，非遗漏）**：`DisclosureRow.module.css`（出处头之外与上游逐字节一致）引用了两个 **`--dsh-`** 前缀变量——`--dsh-content-font-size-secondary` 与 `--dsh-content-font-delta`。这两个属上游 `body` 发布的 **content 轴**，**不在**本白名单的 `--dsw-*` 范围内，L1 有意不提供；其每一处引用都带 CSS fallback，实测确有（`var(--dsh-content-font-delta, 0px)`、`var(--dsh-content-font-size-secondary, 13px)`），故缺 token 时降级正确、不会渲染错乱。**含义**：L1 的变量面由「被 vendored 的组件 CSS 实际引用」反向定义，不是全量继承——将来 L3 取新组件时，须按同一份 manifest 口径重新推导白名单。

**命名不冲突（已核实）**：上游原语的 token 命名空间是 `--dsw-*`（`packages/client/ui-primitives/src/index.ts` 文档注释原文：*"Cordis-free React primitives styled only through `--dsw-*` tokens."*），本仓既有视觉变量是 `apps/web/src/styles/tokens.css` 里的 `--color-*` / `--space-*` / `--radius-*`。两套前缀不交叠，这是 L1 token 与 WhalePod 自有 token 能并存而不互相覆盖的机制（`dsw-tokens.css` 文件头亦把它记为「双轨并存的已知代价」）。

### 3.2 L2 原语组件（6 个，已实测回填）

首批 L2 实测取用 **6 个组件**：`Button`、`Pill`、`Tag`、`StateDot`、`DisclosureRow`、`Switch`。全部落在 `apps/web/src/vendor/dsh-ui/`。

> 说明：ADR-0008 §2 只给了范围描述（「按钮/弹层/输入」）而**未点名具体 6 个**；下列 6 个是**从切片工作区实测得到**的，不是从文档推断的。注意实际取用的 6 个与 ADR 那句举例并不完全对应（取的是原子级原语，**未取** `Modal` / `Menu` / `Tooltip` / `HoverCard` 等弹层类）。

**哈希锚点（读表前必读）**：下表三个哈希列全部对应 **vendored 子树的提交状态 `069b2f1`**（`feat/p1-138-vendor-ui-primitives` 分支，实现线冻结点；`manifest.json` 与 Q0 单测也钉在这个状态上）。复算用 `git rev-parse <commit>:<path>` 或 `git show <commit>:<path> | git hash-object --stdin`——**不要**对**工作区**跑 `git hash-object`：分支历史上多次出现"工作区值 ≠ 提交值"，本台账早期版本正因此记下整列错值。**凡本台账的哈希都以"某 commit 的 blob"为单位**，不以下一时刻的工作区为单位。

**出处头（全目录统一，这是读哈希表的前提）**：vendored 目录里**每个文件**顶部都有一段出处注释块（`/* … */` 或 `/** … */`）：上游路径 + 取用 commit SHA + 本仓改动说明。因此**本仓 blob 必然不等于上游 blob**——关系式是：

```
本仓 blob = 上游 blob + 出处头块注释 (+ .tsx 的功能性改动)
```

**出处头不是固定行数**：内容按「①工程口径」与「②功能性改动」分类陈述，行数随说明长度在 **5–7 行**之间浮动（见表中"头行数"列）。所以**剥出处头必须按注释块剥，不能写死 `tail -n +6`**——用 `sed '1,/^[[:space:]]*\*\/[[:space:]]*$/d'`（删到第一个 `*/` 行为止），§3.4 有命令。

所以本台账用**三列**分开记，不把两种值混在一列：**上游 blob**（钉住 commit 下的原文）、**本仓 blob**（`069b2f1` 里实际提交的那份）、**剥出处头后 blob**（本仓文件去掉出处头块后的内容哈希，用于判断"除出处头外还改了什么"）。

**`.module.css`（6/6：剥掉出处头后与上游逐字节一致）**

| # | 组件 | 上游 blob | 本仓 blob@`069b2f1` | 剥头后 blob | 头行数 | 剥头后 vs 上游 |
|---|---|---|---|---|---|---|
| 1 | `Button` | `9fa1712a669602fb6ec393a3bbe2e25a60d4ee98` | `3e20c84e05da61bae691e7e5adb5e41ef29b0e37` | `9fa1712a669602fb6ec393a3bbe2e25a60d4ee98` | 5 | **相等** |
| 2 | `Pill` | `8fb6cc0bda1a769759cfe645b61c8db51c92f4e8` | `3acb0759ae921bf89fa6a96a6e3a5afb76036f53` | `8fb6cc0bda1a769759cfe645b61c8db51c92f4e8` | 5 | **相等** |
| 3 | `Tag` | `65380320ac1cec80459f3d5fdcdce152c59bfe90` | `b5c36db88c08404e4619bf4b5245f13aff60ba31` | `65380320ac1cec80459f3d5fdcdce152c59bfe90` | 5 | **相等** |
| 4 | `StateDot` | `265dd1b0a68680f5002a1064bd46a716c05ac853` | `d1c46d01eabd892951470ee81728cf5dad694bfc` | `265dd1b0a68680f5002a1064bd46a716c05ac853` | 6 | **相等** |
| 5 | `DisclosureRow` | `fed453f34575197535098b3bab3466c8aac02b0b` | `e7e803ea5057aa782765148f6f510a07114fe0b6` | `fed453f34575197535098b3bab3466c8aac02b0b` | 7 | **相等** |
| 6 | `Switch` | `c038331a6604cd98a3ff72622a62f4d0377704fd` | `50e3a205723876b157a5b91cdb947f376598c147` | `c038331a6604cd98a3ff72622a62f4d0377704fd` | 5 | **相等** |

**结论（带条件）**：6 个 `.module.css` 是「**剥掉出处头后**与上游逐字节一致」——**不能**简写成"与上游逐字节一致"（提交 blob 与上游 blob 不相等，如 `Button.module.css` 本仓 2056 B vs 上游 1720 B，差的正是出处头）。样式声明本身一字未改，该结论对 6/6 成立。

> **值得记一笔（`8490228` 的 AA 重映射没有污染 vendored CSS）**：该提交改了 `StateDot.module.css` 与 `DisclosureRow.module.css` 的 blob，但重算显示**两者的"剥头后 == 上游"依然成立**——即改动**只在出处头块内**（说明文字变长），CSS 声明一字未动。AA 重映射动的是 `apps/web/src/styles/dsw-tokens.css` 的**取值**（本仓 L1 产物，非 vendored 文件）。这条是"别看 blob 变了就以为内容变了、要按剥头后比"的实例。

**`.tsx`（6/6：剥掉出处头后**仍**与上游不同——因为含功能性改动）**

| # | 组件 | 上游 blob | 本仓 blob@`069b2f1` | 剥头后 blob | 头行数 | 剥头后 vs 上游 | 剥头后仍然存在的改动 |
|---|---|---|---|---|---|---|---|
| 1 | `Button` | `d2e39dbf23867bcfdc4f163fc84c9775e3dbb59a` | `c26bf3e20c84bcbe888a09795978d87546f28b66` | `174dad08ff480bcf5e5cbf1291fb29ac972da1ff` | 5 | 不同 | ① `clsx` → `./cx.js`（import + 1 处调用） |
| 2 | `Pill` | `8e2762c714e3a377b60d143e6b2166408865a34d` | `f85616791e975b405bb41dfbbba46ce1d3254b05` | `e079841243929dbcc512b860116531bbe29b5022` | 5 | 不同 | ① `clsx` → `./cx.js`（import + 2 处调用） |
| 3 | `Tag` | `b99e9ba2080ed83edd37e2803c77286c4a5e6cb6` | `45f58d86e313d0fe1be4d163e2407bce5399f0b8` | `79115307d4f122d8979e2e2749f45d9db9901e33` | 7 | 不同 | ① `clsx` → `./cx.js`；② **可测性**：新增根属性 `data-vendored="tag"` + 允许调用方覆写 `data-testid` |
| 4 | `StateDot` | `0cc825e75ad8689858226b10372ab95bc47b8283` | `99bca475b15f575eb7208f8c5246b0dc3705bcef` | `da99913bec5b7d338c48cea0626265c0547affa5` | 7 | 不同 | ① `clsx` → `./cx.js`；② **可测性**：**两个渲染分支**都新增 `data-vendored="state-dot"` + 可覆写 `data-testid` |
| 5 | `DisclosureRow` | `f04ad8986a36bc2845446f3aeb211f6fecaf281c` | `46a7b2d6b536b8b692367338a96c4fd1bb629c6c` | `b67092dd6cc0a6c7c50aaaa733de02d0237d978e` | 7 | 不同 | ① `clsx` → `./cx.js`（6 处）；② **依赖收缩**：chevron 图标从上游 119 KB 的 `./icons/index.tsx` 桶文件改指本目录 `./icons.js` |
| 6 | `Switch` | `980a08f6beb1c489ca9b68244a4c991edc350cfa` | `ca35c85f7798eb0cc6172d906137be1e9983940b` | `1a7d44e7964fde1eef439341a3649bbf252311c4` | 5 | 不同 | ① `clsx` → `./cx.js`（import + 1 处调用） |

**改动分类与实现线出处头逐字对齐**（`069b2f1` 的最终版）：出处头把每处改动归入两类，本台账右列沿用同一口径——

| 分类 | 说明 | 落在哪些文件 |
|---|---|---|
| **①工程口径** | `clsx` → `./cx.js`、import 补 `.js` 后缀 | 6/6 全部 |
| **②功能性改动** | 子类 A **可测性**：新增根属性 `data-vendored` + 允许调用方覆写 `data-testid`（**API 面改动，非纯格式差异；视觉与行为未改，但同步上游时必须保留**） | `Tag.tsx`、`StateDot.tsx` |
| | 子类 B **依赖收缩**：chevron 图标改从本目录 `./icons.js` 引入（上游是 119 KB 的 `./icons/index.tsx` 桶文件，本仓只 vendored 那一个符号） | `DisclosureRow.tsx` |

> **上一版的一处不实已由实现线修掉**：本台账曾记录 `Tag.tsx`/`StateDot.tsx` 出处头写作「仅工程口径，未动视觉与行为」与 diff 不符。`8490228` 已把这三个文件的出处头改成「①工程口径 + ②功能性改动」分类陈述（② 明确标注"是 API 面的改动而不是纯格式差异…视觉与行为未改，但同步上游时它属于要保留的改动"）。**本台账与实现线的口径现已一致**，不再有措辞分歧。

**MIT 合规判断（结论不变）**：MIT 允许修改与再分发，义务只是保留版权与许可声明——`LICENSE` 已随子树保留（§5.2），故**合规**。但因存在修改，**不能**把本子树描述为"未修改的上游副本"。

**同目录支撑文件（一并被取用，`manifest.json` 已登记）——blob 均为 `069b2f1` 的提交值**：

| 本仓文件 | 本仓 blob@`069b2f1` | 字节 | 上游来源 | 关系 |
|---|---|---|---|---|
| `apps/web/src/vendor/dsh-ui/icons.tsx` | `678c5a2b2792ada36f64449bc6245e51bff050a5` | 1985 | `ui-primitives/src/icons/props.ts` + `ui-primitives/src/icons/index.tsx` | **合并 + 裁剪**：只留 `IconChevronDownOutline14` 一个符号（路径数据照抄），上游其余图标不取 |
| `apps/web/src/vendor/dsh-ui/index.ts` | `3a146a2a7d4bf092976cd34ffafe3a66d4a9f0e6` | 992 | `ui-primitives/src/index.ts` | **裁剪**：只留 6 个原语与其类型的导出 |
| `apps/web/src/vendor/dsh-ui/LICENSE` | `c1f7a78e89e4e4dc7b86664c3b3c76eb5eee1785` | 1065 | **仓库根** `LICENSE` | 全文照抄，未改一字（与 `f3452f0` 相同——冻结期间没动过） |
| `apps/web/src/vendor/dsh-ui/README.md` | `b2388bbb6d223bcf41a441806adce77dd2211d08` | 2691 | **无**（本仓新增） | 用法与纪律说明（含「不含 DSH 品牌资产」声明） |
| `apps/web/src/vendor/dsh-ui/cx.ts` | `3d105dce12f0dee538f9c74c5d854b90136459af` | 1046 | **无**（本仓新增） | 替代上游 `clsx` 调用，避免引入新第三方依赖 |
| `apps/web/src/vendor/dsh-ui/manifest.json` | `6aa92623fb1981211e6f708aecc7377b09309e93` | 7041 | **无**（本仓新增） | 机器可读台账自身（`069b2f1` 更新了两处计数，见 §3.4） |

**L1 产物（在 vendored 目录之外）**：`apps/web/src/styles/dsw-tokens.css` blob@`069b2f1` = `4d886ed4a41c9912cf38d60579ec9c8681fa9459`，**7080 B**。它随 `8490228` 的 AA 重映射变过（取值），变量账不变（§3.1）。

**`LICENSE` 的来源路径要说准**：上游 **`packages/client/ui-primitives/` 下没有 LICENSE 文件**（已实测：该目录列目录无任何 license 项）。我们复制的是**上游仓库根**的 `LICENSE`（`LICENSE`，blob `c1f7a78e…`）——这是覆盖整个 monorepo 的那一份 MIT 全文。出处头与 `manifest.json` 里 `"upstream": "LICENSE"` 即指仓库根路径，读者不要误以为取自 `ui-primitives/src/`。

**`cx.ts` 的归属（已由实现线落实）**：`cx.ts` 在 `manifest.json` 里登记为 `"upstream": null`，且其文件头已标明「**本仓新增代码，非上游代码**：WhalePod 自有实现，许可为 Apache-2.0」。即**著作权归属与许可与 vendored 部分不同**：本仓自有代码按 Apache-2.0（ADR-0006），MIT 那套义务只覆盖 vendored 部分。原「建议加标注」的待办**已销**。

**上游候选清单（已核实，供 L3 后续切片选取）**：`packages/client/ui-primitives/src/` 顶层组件与其样式，blob SHA 取自钉住 commit。**本批已取用其中的 6 个——`Button` / `Pill` / `Tag` / `StateDot` / `DisclosureRow` / `Switch`（见 §3.2）**；下表其余条目是 L3 候选，尚未取用，回填时按 §3.2 的表格式登记本仓哈希与复制形态：

| 上游组件（`.tsx` / `.module.css`） | blob sha（`.tsx`） | 字节 | blob sha（`.module.css`） | 字节 |
|---|---|---|---|---|
| `Button` | `d2e39dbf23867bcfdc4f163fc84c9775e3dbb59a` | 1190 | `9fa1712a669602fb6ec393a3bbe2e25a60d4ee98` | 1720 |
| `Input` | `3af60f9d184be4c734e92f0d1231a90c81e11bd1` | 809 | `5102c3291f4d08e4bd4a5ba775d90370a23ae0cd` | 693 |
| `Modal` | `fd33a8724cd635547cee33b553ef9464500891e8` | 2963 | `44ec4b7d932d8a14c68b89b86f089aa4c7abee26` | 2103 |
| `Menu` | `db8b5588fee8490fce5c41cd9f4e989f23bf518a` | 14318 | `a63209665966d9502373ab46267e03bd6dd921cf` | 5758 |
| `Tooltip` | `a1893a1d39a34c00d1354cf495a3560a6d0411fb` | 7414 | `031c45f02f4cc8335a3a45b32856d53fff198edf` | 1008 |
| `HoverCard` | `216df4c5d59a72397e4271034e194dd12fd6693e` | 7657 | `8d425ca85c3af19fb9ed02b9d8eb735da68f9e1e` | 1266 |
| `Pill` | `8e2762c714e3a377b60d143e6b2166408865a34d` | 1297 | `8fb6cc0bda1a769759cfe645b61c8db51c92f4e8` | 568 |
| `Tag` | `b99e9ba2080ed83edd37e2803c77286c4a5e6cb6` | 1592 | `65380320ac1cec80459f3d5fdcdce152c59bfe90` | 1858 |
| `Switch` | `980a08f6beb1c489ca9b68244a4c991edc350cfa` | 1523 | `c038331a6604cd98a3ff72622a62f4d0377704fd` | 1366 |
| `StateDot` | `0cc825e75ad8689858226b10372ab95bc47b8283` | 1866 | `265dd1b0a68680f5002a1064bd46a716c05ac853` | 1824 |
| `DisclosureRow` | `f04ad8986a36bc2845446f3aeb211f6fecaf281c` | 3256 | `fed453f34575197535098b3bab3466c8aac02b0b` | 2089 |
| `RiskConfirmation` | `8990cb8e5bf49385b4a40971129c7ab9a90ad487` | 2160 | `016eeee1d0bc9b6b5078ba6eca51385d645718db` | 1177 |
| `OnboardingSurface` | `bc43dcd7f0dd1206960a0e1232882db1075d3bc5` | 891 | `e019061c21902cd8b9c3377d343b8915019df1ba` | 593 |
| `ConnectionIndicator` | `2c549661df0e17aac49aec47f1f1ed70102ad6fc` | 3281 | `bf0e653740112587c65bf6e708fca0f2f5f37374` | 1835 |
| `Toast` | `0a50e47230889e21e5c5edb0a73ab7c3e97d85d0` | 3041 | `793cbe23a1f1d29a28b002d8f21a246cdf41a2e1` | 1959 |
| `JsonTree` | `8399f3681e9a94a6de39fd9d29b1b94b5bb41537` | 21633 | `33ec3f30d36c5cfe72c4c78d9d9a8792c91077c5` | 4152 |
| `TerminalBlock` | `173a7e317fe9dc5e19ab9acf201889b1c33aca8e` | 11351 | `5198a5148a537b1cfbd6ed6602cd16e11c0f5d90` | 6745 |
| `ReadBlock` | `6c1b2eaec97ab8f3e73913ae72a54a9d334b2b8a` | 5915 | `2c4cf0370d861b2ebe318e4d6d2a4125f31fc7cc` | 2502 |
| `DiffBlock` | `01a080bbfccaaf652dbd12c9687a60b88efeaa19` | 7610 | `4f64417d0cfa54472be8ada03d4c98784a5d9ce3` | 2590 |
| `SearchBlock` | `c2328d6a9d16ed29c1cc0a5b8e293cdf5aa6d559` | 11308 | `467e23b709bba66659dda40cd558022175f9549a` | 2340 |
| `WebBlock` | `93cd334c50d448aa6ff6979f8c04a91eda294db0` | 7719 | `514403ab2860af759b57be3549abe2ff04ca57fb` | 3410 |
| `FileTypeIcon` | `0a88317401ef0d730f08d24476b869fbe96068b8` | 16001 | `4de4d946e08ac80e26883e3be91752f99a8e53fa` | 1056 |
| `user-text` | `b52f7a01970b28a898491765221a87b4a335d671` | 6903 | `3654d6f990d48aab7938bc3def4f050df19f2d54` | 1716 |

（`LinkIcon.tsx` 18578 B / `ReferenceIcon.tsx` 2041 B / `CodeFileIcon.tsx` 1174 B / `FoldToggle.tsx` 866 B / `icons/index.tsx` 119245 B 无同名 `.module.css`；`BrandWordmark.tsx` 与 `FishLogo.tsx` 见 §3.3，**禁止取用**。）

### 3.3 品牌资产排除清单（**不得进仓**）

ADR-0008 §5 与 TRADEMARKS.md 的红线：`ui-brand-official` 与**任何 DSH 商标、鲸鱼 logo 资产**不 Fork。

**关键风险（已核实）**：品牌资产**混在我们要取用的包里**——`packages/client/ui-primitives/src/` 同时含有官方品牌图形，且它们**从 `index.ts` 公开导出**：

| 上游路径 | blob sha | 字节 | 判据 |
|---|---|---|---|
| `packages/client/ui-primitives/src/FishLogo.tsx` | `8621f17273c0d192feb14a988816c8052360b908` | 4486 | 上游文档注释：*"Render the fish logo."*；导出 `FISH_LOGO_PATH` / `FISH_LOGO_VIEWBOX` 的官方标的 SVG path |
| `packages/client/ui-primitives/src/BrandWordmark.tsx` | `a9df992179c7cc8f0792142f2dde66dbbb3b5464` | 16327 | 上游文档注释：*"the official brand wordmark"*、*"decorative brand art"*，含 "leading whale mark" |
| `packages/client/ui-brand-official/**` | 整包 | 整包 | ADR-0008 §5 点名排除；`src/client/Brand.tsx` 即品牌组件 |

**审查动作**：L2 取源时**逐个资产过**，上表三项一律不取；若某个被选中的组件 import 了 `FishLogo`/`BrandWordmark`，必须改为 WhalePod 自有标识（ADR-0008 §5：「L1/L2 交付物带 WhalePod 自身视觉标识」），**不得**以「反正是 MIT 代码」为由带进仓。MIT 许可的是著作权，**不许可商标**——这是两件事（见 §6.1）。

**本批执行结果（已实测核对）：通过——判据是「无品牌图形与品牌符号」，不是「文本零命中」。**

- **事实澄清**：对 `apps/web/src/vendor/dsh-ui/` 全目录按品牌标识 grep，**并非零命中**——`FishLogo` / `BrandWordmark` 会出现在 `README.md:12-13` 与 `manifest.json:22`，但那些是**声明"未取用"的说明文字**；另有 `whale` 命中 `@whalepod` / `WhalePod` 字样（本仓自己的名字，属模式误伤）。所以"零命中"的写法**不准确**，不能用它当判据。
- **真正的判据（可复跑）**：查的是**品牌图形与品牌符号是否存在**，而非标识词是否出现：

  ```console
  $ grep -rn "FISH_LOGO_PATH\|export function FishLogo\|export function BrandWordmark" \
      apps/web/src/vendor/dsh-ui/
  # 无输出 ⟹ 目录内没有品牌图形与品牌导出符号
  ```

  实测**无输出**：18 个文件中没有任何品牌 SVG path、没有 `FishLogo` / `BrandWordmark` 的实现或导出。
- `icons.tsx` 只含 `IconChevronDownOutline14` 一个通用 chevron 符号（非品牌资产）；`manifest.json` 的 `scope.excluded` 亦显式登记了这两个品牌文件"未取用，逐资产过审后才能取"。

即 §3.3 的红线在本批**已落实**，不是待办。

### 3.4 哈希核对方法与 Q0 断言现状

**复核命令（每次跟版后重跑，任一漂移即须更新本台账）**：

```console
SHA=c291e7961a515f6d7af9304e7fd1d257929aef26   # 上游钉住 commit
C=069b2f1                                        # 本仓 vendored 子树的锚点 commit（实现线冻结点）

# 1) 上游侧：取原文并本地算哈希（不依赖 tree API 的 .sha 字段，独立可证）
$ gh api -H 'Accept: application/vnd.github.raw' \
    "repos/deepseek-ai/deepseek-harness/contents/<upstream-path>?ref=$SHA" | git hash-object --stdin

# 2) 本仓侧：**锚在 commit 上**，不要对工作区跑 hash-object
$ git rev-parse "$C:apps/web/src/vendor/dsh-ui/<file>"

# 3) 剥出处头：按**注释块**剥，不要写死行数（出处头 5–7 行不等）
$ git show "$C:apps/web/src/vendor/dsh-ui/<file>" \
    | sed '1,/^[[:space:]]*\*\/[[:space:]]*$/d' | git hash-object --stdin
```

第 3 步是判定"除出处头外还改了什么"的关键：**剥头后 == 上游** ⟹ 只有出处头之差（本批 6/6 `.module.css`）；**剥头后 ≠ 上游** ⟹ 另有实质改动（本批 6/6 `.tsx`）。

> **别写死行数（本轮实测踩到的）**：`f3452f0` 时出处头统一是 5 行，`tail -n +6` 够用；`8490228` 把 `Tag.tsx`/`StateDot.tsx`/`DisclosureRow.tsx` 的出处头改成「①工程口径 + ②功能性改动」分类陈述后变成 **7 行**，`StateDot.module.css` 变成 **6 行**。写死行数会得到**错的剥头值**。用上面的 `sed` 按注释块剥，对 5/6/7 行都成立。

> **工作区≠提交值（实测的坑）**：本台账写作期间该分支多次出现"工作区值 ≠ 提交值"（如 `Button.tsx`：`f3452f0` 提交值 `f5a8c63f…` → 当时工作区 `c26bf3e2…` → 最终 `069b2f1` 提交值也是 `c26bf3e2…`）。所以"我在那台机器上 `git hash-object` 得到的是另一个值"**不代表台账错**，只代表锚点不是一个 commit。**对账时先确认工作区是否干净**，不干净就取 commit 值。这条是本台账曾经出错的根因，别再踩。

**`LICENSE` 的比对**：在锚点 `069b2f1` 上 `git rev-parse 069b2f1:apps/web/src/vendor/dsh-ui/LICENSE` 得 `c1f7a78e89e4e4dc7b86664c3b3c76eb5eee1785`，与上游**仓库根** `LICENSE` blob 完全相等，1065 B——这是唯一要求"一字不改"的文件，**逐字节一致，已核实**，且该 blob 自 `ee9c4b5` 起**从未变过**。（它也是全目录**唯一**没有出处头的文件——它是原文本身，不需要标注自己。）

**Q0 断言现状：覆盖缺口已收口（PR #151 落地，`069b2f1` 复核仍成立）。** ADR-0008 §3 要求 Q0 断言「登记文件覆盖 vendored 目录的每个文件」。现行口径把登记面拆成两组，并集必须等于目录全部文件：

| | 数量 |
|---|---|
| `components[]`（源码与样式：`.ts`/`.tsx`/`.module.css`） | 15 |
| `meta[]`（元文件：`README.md` / `LICENSE` / `manifest.json`） | 3 |
| **并集** | **18** |
| `apps/web/src/vendor/dsh-ui/` 实际文件 | **18** |

实测对照（本台账在 `069b2f1` 上独立复算）：`MISSING=[]`、`EXTRA=[]`——**18 对 18，恰好全覆盖**。口径本身写在 `manifest.json` 的 `coverage` 字段里，并由 Q0 单测钉死：`apps/web/tests/vendor-dsh-ui.spec.tsx`（`069b2f1` 下 26047 B）的用例「manifest.json 覆盖口径：components[] = 全部源码与样式文件，meta[] = 元文件（并集 = 目录全部文件）」断言 `[...components, ...meta].sort()` 与 `readdirSync` 的目录列表**逐项相等**；同一用例还**反向钉住了上游 commit**（`manifest.upstream.commit === 'c291e796…'`），所以第 1 节的钉版 SHA 被机器守住，不会在同步上游时被静默改掉。

> 历史说明：本台账曾在此处登记「已登记 16 / 目录 18，`README.md` 与 `manifest.json` 未登记」的缺口。那是 PR #151 **之前**的中间态；现况已由上述 `meta[]` + Q0 单测收口，原三选一收口方案**不再需要拍板**。

**两处计数错值已由 `069b2f1` 修掉（原待转实现线项，现销账）**：`manifest.json` 的 `tokens[0].adaptations` 与 `components[]`（`index.ts` 条）此前分别写作"上游静态色阶 **78** 个"与"上游桶文件含整包 **43** 个原语"。`069b2f1` 已改为 **73** 与「上游 `ui-primitives/src` 顶层 **29** 个 `.tsx` / 桶文件导出 **30** 个原语；**43 是 `packages/client/ui-*` 的包数**，别混」。本台账独立复算确认：静态色阶 **73**、顶层 `.tsx` **29**、UI 包数 **43**（"30 个原语"取自实现线登记值；本台账按"首字母大写的值导出减去 `DEFAULT_*` 与 `FISH_LOGO_*` 常量"计得 29 个 React 组件，差 1 属"原语"定义边界，不影响"43 是包数"这一纠正）。

**注**：本台账（`docs/agent/dsh-ui-vendoring.md`）是**人读汇总**，Q0 断言解析的机器可读输入是 `manifest.json`。两处的钉版 SHA 与覆盖面必须一致——改动任一处都要同步另一处。

---

## 4. 同步纪律

### 4.1 上游更新时怎么跟

人工、逐个文件比对、更新 SHA：

1. `gh api repos/deepseek-ai/deepseek-harness/commits/master --jq .sha` 取上游新 SHA；
2. 用 git 定位**本仓已取用文件**在上游钉住 SHA 与最新 SHA 之间的变化（逐文件 `git log --oneline <old>..<new> -- <upstream path>`）；
3. **逐个文件**读 diff，判断该 patch 是否适用于我们的派生版本（L1 token 已被裁剪、L2 已去掉 cordis，**patch 往往不能直接落**）；
4. 落完更新本台账 §1 的钉住 SHA、§3 的 blob SHA 与体量，并在本文件末尾「变更记录」追加一行（日期、旧 SHA → 新 SHA、取了哪些文件、为什么）；
5. DSH 版本升级若同时动 `dsh.lock.json`，走 skill `dsh-upgrade` 的独立 PR——**UI 跟版与 DSH 运行时升级不混在一个 PR**。

### 4.2 跟版成本高的文件（预期长期冲突）

| 文件 | 为什么贵 |
|---|---|
| `design-platform.css`（19109 B，L1 最大件） | token 表是全局视觉契约：上游加一个变量会波及我们所有裁剪过的组件；且我们自己的 `tokens.css` 也要跟它对齐 |
| `gradient-shadow-text.css`（14722 B） | 纯视觉实验性样式，上游改动频繁、与 WhalePod 自有视觉语言重叠度高，多半要么整取要么整弃 |
| `Menu.tsx`（14318 B）/ `HoverCard.tsx` / `Tooltip.tsx` | 交互细节多、依赖定位与外部点击 hook，上游修 bug 的频率高于其他原语 |
| `icons/index.tsx`（119245 B） | 单文件巨型图标表；**若不取用则无需跟版**，这是「少取即少税」的例子 |

### 4.3 禁止事项（红线）

- **禁止 `git subtree`**：会把上游历史拉进本仓，与「看起来就知道是复制品」的设计意图冲突，且让逐文件出处登记失去意义。
- **禁止 git submodule**：vendored 代码必须随本仓分发，submodule 会让构建依赖外部网络与上游可用性。
- **禁止在业务代码里直接 import `@deepseek-ai/*`**：AGENTS.md 红线逐字有效，只有 `packages/runtime-dsh/` 与 `apps/runtime/` 可以（ADR-0008 §3）。
- **禁止把 vendored 子树当包解析**：不得以包说明符或 `@deepseek-ai/ui-*` 名义 import，只能按本仓相对路径。
- **禁止从 `node_modules` 取源**：npm 分发物是编译 JS，取到的不是源码。

---

## 5. 许可与商标义务落实

MIT 的硬性义务只有一条：**保留版权声明与许可文本**。本仓三个承载点：

### 5.1 `NOTICE`（分发面汇总）

在既有的 Apache-2.0 声明**之后追加**第三方 MIT 组件声明（只追加、不改既有内容）：上游项目名、版权行 `Copyright (c) 2026 DeepSeek`、许可名与获取方式、被复制范围。`NOTICE` 是分发时随二进制/镜像一同给出的那份，**面向"拿到东西的人"**。

### 5.2 `apps/web/src/vendor/dsh-ui/LICENSE`（许可全文所在处）

上游 MIT 全文副本**放在 vendored 子树内**（ADR-0008 §3：子树内保留上游 LICENSE 全文与 `Copyright (c) 2026 DeepSeek`）。本文件负责**核对并说明**这一承载点，不复制其内容。

**核对结果（已实测）：通过。** 在锚点 `069b2f1` 上 `git rev-parse 069b2f1:apps/web/src/vendor/dsh-ui/LICENSE` 得 `c1f7a78e89e4e4dc7b86664c3b3c76eb5eee1785`，与上游钉住 commit 的**仓库根** `LICENSE` blob **完全相等**，1065 B，首行 `MIT License` / `Copyright (c) 2026 DeepSeek`。即**逐字节一致**——没有漏字、没有被本地改写。核对命令见 §3.4。

**三处 MIT 表述一致性（本轮逐字核对，结论：一致）**：

| 承载点 | 对 vendored 部分的许可表述 |
|---|---|
| `NOTICE` | "Licensed under the MIT License"、`Copyright (c) 2026 DeepSeek`、全文见 `apps/web/src/vendor/dsh-ui/LICENSE`、"MIT License grants copyright permissions only and does not grant any trademark rights" |
| `TRADEMARKS.md` | 「**Which license governs the vendored code: MIT, not Apache-2.0**」——指明 vendored 源码按**上游 MIT** 再分发，并声明上一节 "Forks and redistributions"（Apache-2.0）**不适用**于 DSH 文件 |
| `docs/agent/dsh-ui-vendoring.md`（本节 + §6.1） | 本仓自身 Apache-2.0、vendored 部分 MIT、义务分层叠加；全文承载点 = `apps/web/src/vendor/dsh-ui/LICENSE` |

三处在四个关键点上**没有分歧**：①vendored 部分按 **MIT**（非 Apache-2.0）；②版权行 `Copyright (c) 2026 DeepSeek`；③MIT 全文承载点 = `apps/web/src/vendor/dsh-ui/LICENSE`；④MIT 只给著作权、**不含商标权**（品牌边界另见 §3.3 与 `TRADEMARKS.md`）。

分工（两处都要有，不能只做一处）：

| 承载点 | 面向 | 内容 |
|---|---|---|
| `apps/web/src/vendor/dsh-ui/LICENSE` | 拿到**源码**的人 | MIT 全文 |
| `NOTICE` | 拿到**分发包**的人 | 第三方组件声明（指向 MIT 与上游） |

这是上游自己的做法（`THIRD_PARTY_NOTICES.md` 的 "Vendored source (`vendor/`)" 一节：*"each directory preserves its upstream `LICENSE` file. Exact upstream commits and local modifications are recorded in `vendor/README.md`"*）——**每个 vendored 目录保留上游 LICENSE + 单独登记上游 commit 与本地改动**。本仓按同一形状落地。

### 5.3 `TRADEMARKS.md`（商标边界）

补一条指向性条款：**vendored 的是代码，不包含 DSH 名称 / logo / 品牌资产**，`ui-brand-official` 等品牌包不取。判据与排除清单见本文件 §3.3。

上游的品牌政策（`BRAND_GUIDELINES.md`，钉住 commit）对我们是**约束也是保护**，三条要点：可以用 "DeepSeek Harness" 真实描述关系（"built on" / "compatible with"）；**项目名避免直接使用 "DeepSeek Harness" 商标**（其为 DeepSeek 注册商标）；避免以可能被误认为官方背书、合作或授权的方式使用官方品牌素材。WhalePod 是独立名称，符合该政策；但因此**更**不能把 DSH logo/wordmark 带进仓。

---

## 6. 许可边界说明

### 6.1 WhalePod 本体 Apache-2.0 + 引入的 MIT 代码如何共存

- 本仓自身许可是 **Apache-2.0**（[ADR-0006](../adr/0006-apache-2-open-source-license.md)），vendored 的 DSH UI 代码是 **MIT**。
- 两者**不冲突**：MIT 是宽松许可，允许再分发、修改、再许可（sublicense）；把它并入 Apache-2.0 作品是 Apache-2.0 明确允许的（Apache-2.0 §4 允许在满足条件下分发含第三方作品的组合作品）。
- **义务是分层叠加的**，不是二选一：组合作品中 WhalePod 自有部分按 Apache-2.0 分发（保留 Apache 头、NOTICE、专利授权条款），vendored 部分继续按 MIT 分发（保留 `Copyright (c) 2026 DeepSeek` 与 MIT 全文）。ADR-0006 原文已预期此形态：「DSH 的 MIT 依赖可继续作为独立第三方组件分发」。
- **不得暗示 DeepSeek 背书**：Apache-2.0 §6 与 TRADEMARKS.md 都禁止以暗示官方身份、背书、赞助或关联的方式使用对方名称与标识。所以 vendored 代码进仓后，WhalePod 的 README / 官网 / 发布物只能做**事实性指称**（"包含来自 DeepSeek Harness 的 MIT 许可代码"），不能写 "WhalePod 由 DeepSeek 提供" / "官方合作" 之类。
- **无专利授权传递风险**：MIT 不含明示专利授权（与 Apache-2.0 不同），即我们从上游拿到的只有著作权许可；这是已知的、可接受的边界，**如果未来要主张专利面，须单独评估**。ADR-0006 选择 Apache-2.0 的理由之一正是自身获得明确专利授权。

### 6.2 「vendored 源码」与「新增 `@deepseek-ai/*` 依赖」的区别

| | vendored copy（本决策） | 新增依赖（红线禁止） |
|---|---|---|
| 形态 | 源码**复制**进本仓，随本仓版本走 | `package.json` 里加 specifier，靠 npm 解析 |
| 上游关系 | 分叉后**冻结在钉住 SHA**，上游改动不会自动到达 | 每次 install 可能拿到新版本 |
| 分发 | 我们分发复制品，MIT 声明义务落在**我们**头上 | 上游包自己带 LICENSE，义务主要在上游 |
| 依赖树 | 不引入 cordis（L1/L2 已去 cordis 化） | 会把 cordis 插件框架与整个依赖树拉进来 |
| 与 ADR-0001 | 保持 DSH 是 Runtime、不是产品权威 | UI 包即 cordis 插件，等于把产品层重新耦合回 DSH |
| 变更可控性 | 每个文件都能审、能改、能停 | 上游一发版就可能被动升级 |

`ui-primitives` 之所以适合做首个 L2 目标：它在上游 `package.json` 里 **`dependencies: []`**（已核实），即**本就不依赖 cordis**，剥壳成本最低。

`ui-theme` 的情形要说准——**"剥出 cordis"指的是把文件从 cordis 插件包里剥出来，不是那个文件本身依赖 cordis**：

- `ui-theme` **作为包**确实是 cordis 插件：`src/index.ts` 有 `import type { Context } from '@deepseek-ai/cordis'`（已核实），另外其 `package.json` 依赖 `@deepseek-ai/schemastery`（上游 `vendor/schemastery`，MIT，版权行是 `Copyright (c) 2021-present Shigma`，**不是** DeepSeek）。
- 但 L1 **实际只取一个文件**：`src/styles/design-platform.css`。实测该文件是**纯 CSS**——`import` 与 `cordis` 出现次数均为 **0**，不含任何 JS 依赖。
- 所以准确的理由是：**我们绕开 cordis 的方式是不依赖 `ui-theme` 这个包、只把其中的纯 CSS 文件拿出来**（连 schemastery 也不需要，因为 token 是静态声明而非 schema 求值）。若当初选择"整个复制 `ui-theme`"或"加 `@deepseek-ai/dsh-client-ui-theme` 依赖"，才会同时把 cordis 与 schemastery 拖进来——那正是红线禁止的形态（§6.3）。

### 6.3 为什么这个区别在 `check-boundaries.ts` 下成立

`scripts/check-boundaries.ts` 的 DSH 隔离族判据（源码第 23、82–86 行）：

```ts
const DSH_PREFIXES = ['@deepseek-ai/dsh-', '@deepseek-ai/dsh', '@deepseek-ai/cordis']
const DSH_OWNERS = ['packages/runtime-dsh/', 'apps/runtime/']
// validateImport: specifier.startsWith(prefix) 且 importer 不在 DSH_OWNERS 内 → 违规
```

成立的理由，逐条对上：

1. **依赖面零变更**：vendored 是复制，不是 specifier。本仓 `package.json` / `pnpm-lock.yaml` 里**不会出现** `@deepseek-ai/dsh-client-ui-primitives`，所以边界门**没有**东西要放行——门不需要开洞，红线的字面含义得以原样保留。
2. **即使有人误用包说明符也会被拦**：上游 UI 包的真实包名是 `@deepseek-ai/dsh-client-ui-primitives` / `-ui-theme` / `-ui-brand-official`（已核实），**全部以 `@deepseek-ai/dsh-` 开头**，因此 `specifier.startsWith('@deepseek-ai/dsh-')` 为真 → 在 `apps/web/**` 下 import 即判违规。即「改成依赖」这条退路被门堵死。
3. **相对路径 import 不触发**：vendored 代码按 `apps/web/src/vendor/dsh-ui/...` 相对路径引用，specifier 不以任何 DSH 前缀开头，门放行——这正是设计要求（它是本仓源码，不是外部依赖）。
   - **实测确认（本批）**：对 `apps/web/src/vendor/dsh-ui/` 下全部 `.ts`/`.tsx` 抽取 import 说明符，结果只有两类——`react` 与本目录相对路径（`./Button.js`、`./Button.module.css`、`./cx.js`、`./icons.js` …）。`@deepseek-ai/*`、`@whalepod/*`、`cordis`、`clsx` **零命中**。ADR-0008 §3「只能按本仓相对路径 import」在首批**已落实**。
4. **许可门不会误拦**：`scripts/license-check.mts` 只枚举 `pnpm licenses list --json`（即 node_modules 依赖），MIT 也在 `PERMISSIVE` 集合内；vendored 代码不进依赖清单。**反面**同样成立：许可门**看不见** vendored 代码，所以本台账 + `NOTICE` 是 vendored 面**唯一**的合规控制，这就是 ADR-0008 §3 说「登记文件缺失即视为未完成」的原因。

**待仓库所有人/切片作者拍板的一处口径差**（本台账核实到的真实缺口，**不是**已发生的问题）：

- ADR-0008 §3 的措辞是「业务代码零 **`@deepseek-ai/*`** import」（scope 级），而 `check-boundaries.ts` 现行 `DSH_PREFIXES` 覆盖的是 **`@deepseek-ai/dsh*` 与 `@deepseek-ai/cordis`**。两者**不等价**：`@deepseek-ai/schemastery`、`@deepseek-ai/cosmokit` 这类**不以 `dsh` 开头**的官方 scope 包既不被边界门拦（`check-boundaries.ts`），又因 MIT 在允许面而不被许可门拦（`license-check.mts`）。
- 对本次 vendoring **不构成**现实风险：被取用的三个 UI 包包名全部命中 `@deepseek-ai/dsh-` 前缀（第 2 条），且 shell/RPC 永不取用。
- 但若要把 ADR-0008 那句 scope 级红线的**字面**含义做成机器判据，Q0 的新断言应显式覆盖 `@deepseek-ai/` 整个 scope，而不是复用现行前缀表。建议由 L1/L2 切片落地时一并决定（改 `DSH_PREFIXES` 还是新增独立断言），**已记入 §7 待办**。

---

## 7. 待回填 / 待拍板清单

逐条销账；`[ ]` 未完成，`[x]` 已完成并注明日期。

**已完成**

- [x] §3.1 L1 映射回填：`dsw-tokens.css` 派生自 `design-platform.css`，其余 5 个上游 CSS 未取用；变量账 23 引用 / 26 声明 / 上游静态色阶 73 已复算（2026-09-10）。
- [x] §3.2 L2 映射回填：6 个组件（Button/Pill/Tag/StateDot/DisclosureRow/Switch）+ 支撑文件，**三列哈希**（上游 / 本仓 / 剥出处头后）逐文件已核对（2026-09-10）。
- [x] 核对 `LICENSE` 与上游**仓库根** `LICENSE` blob `c1f7a78e…`：**逐字节一致**（§5.2）。
- [x] 品牌排除清单实测：目录内无品牌图形与品牌导出符号（§3.3）。
- [x] 核对 `manifest.json` 的上游 repo / commit SHA / commitDate 与上游 API 一致（`c291e796…`、`2026-09-10T14:17:09Z`）；逐文件映射与本台账一致。
- [x] `cx.ts` 归属标注：文件头已标明「本仓新增代码，非上游代码…Apache-2.0」（§3.2）。
- [x] **Q0 登记覆盖面缺口已收口**（PR #151）：`components[]` 15 + `meta[]` 3 = 18 = 目录实有 18，`MISSING=[]`/`EXTRA=[]`，由 Q0 单测 `apps/web/tests/vendor-dsh-ui.spec.tsx` 断言；原「三选一收口方案」不再需要拍板（§3.4）。
- [x] 切片已提交（`ee9c4b5` → `f3452f0` → `8490228` → **`069b2f1`**，实现线冻结点）——顶部原「尚未提交」的观察态说明已随之更新。
- [x] **锚点前移到 `069b2f1` 并整套重算**（2026-09-10，实现线冻结后）：12 个组件文件的三列哈希 + 6 个支撑文件 + `dsw-tokens.css` 全部重算；`8490228` 改动过的 10 个 vendored blob 已更新，`.module.css` 剥头后==上游 6/6 仍成立、`.tsx` 剥头后≠上游 6/6 仍成立（§3.2）。
- [x] 出处头措辞分歧已消：`8490228` 把 `Tag.tsx`/`StateDot.tsx`/`DisclosureRow.tsx` 改成「①工程口径 + ②功能性改动」分类陈述，本台账已逐字对齐（①工程口径；②可测性 / ②依赖收缩）。
- [x] **两处计数错值已由 `069b2f1` 修掉**：静态色阶 78→**73**、桶文件「43 个原语」→**43 是包数 / 顶层 29 个 `.tsx`**（原「待转实现线」三项销账）。

**待回填（跟版时）**

- [ ] 每次跟版后**重跑 §3.4 核对命令**（锚在 commit 上，不对工作区取值；剥出处头按**注释块**剥、不写死行数）：18 个文件的三列 blob SHA 是否漂移；不一致即按实测更新 §3.1/§3.2，并把锚点 commit 一并改写。
- [ ] 锚点前移时**整套重算**，不要只改个别格子——`8490228` 一次就动了 10 个 vendored blob（含仅出处头变化者），只改格子必漏。

**待仓库所有人 / 切片作者拍板**

- [ ] **§6.3 的 scope 口径差**：ADR-0008 §3 写「零 `@deepseek-ai/*` import」，而 `check-boundaries.ts` 的 `DSH_PREFIXES` 只覆盖 `@deepseek-ai/dsh*` 与 `@deepseek-ai/cordis`。要不要把 Q0 新断言的覆盖面扩到整个 `@deepseek-ai/` scope？
- [ ] 「可复跑取源脚本」的落地时机（ADR-0008 §3 说与 L3 一起评估；在此之前**不得**声称出处可复现）。是否需要一个只做「按 SHA 取文件 + 校验 blob SHA」的最小脚本先行？
- [ ] 公开发布前是否按 ADR-0006 的约定，由项目权利人对 MIT 引入面做一次法律审阅。

---

## 变更记录

| 日期 | 变更 |
|---|---|
| 2026-09-10 | 建档。钉住上游 `c291e7961a515f6d7af9304e7fd1d257929aef26`；核实 L1 六个 CSS 与 `ui-primitives` 组件清单的路径/blob SHA/体量；登记品牌排除清单。 |
| 2026-09-10 | 按 §3.4 方法**实测回填**：6 个 L2 组件（Button/Pill/Tag/StateDot/DisclosureRow/Switch）+ `icons.tsx`/`index.ts`/`cx.ts`/`LICENSE` 的本仓 blob SHA 与复制形态；`LICENSE` 与上游 blob 逐字节一致；品牌排除清单实测通过；记入 Q0 登记覆盖面缺口（`README.md`/`manifest.json` 未登记）与 `cx.ts` 归属标注待办。 |
| 2026-09-10 | **独立审查后修正（PR #150 一审「需改」4 项 + 顺带 5 项）**。根因：上一版哈希取自切片刻**变动前**的工作区快照，切片随后加了出处头与功能改动，旧值失效而仍标「已实测」。修正内容：①§3.2 哈希表改为**三列**（上游 / 本仓 / 剥出处头后）并全部重算——旧 6/6 `.tsx` 值既非上游也非本仓，`cx.ts` 同病，均已纠正；②「逐字节一致」改为**带条件**表述（剥掉 5 行出处头后成立）并写明关系式；③`.tsx` 改动分类补上 `Tag.tsx`/`StateDot.tsx` 的 `data-vendored` 与可覆写 `data-testid`（功能性，非纯工程口径）；④§3.4 Q0 缺口改写为**已收口**（`components[]` 15 + `meta[]` 3 = 18，Q0 单测断言，PR #151）；⑤品牌核验删去不实的「grep 零命中」，改为「无品牌图形与导出符号」的可复跑判据；⑥补记实现线文件中两处待修数字（静态色阶 78→**73**、桶文件「43 个原语」→43 是**包数**、顶层实测 **29 个 `.tsx`**）；⑦L1「剥出 cordis」归因改准（`ui-theme` 包确是 cordis 插件 + 依赖 schemastery，但实取文件 `design-platform.css` 是**纯 CSS**，0 import/0 cordis）；⑧写明 `LICENSE` 取自**仓库根**（上游 `ui-primitives/` 下无 LICENSE）；⑨新增变量账 23 引用 / 26 声明并验证零未解析引用。 |
| 2026-09-10 | **锚点前移到实现线冻结点 `069b2f1` 并整套重算**（`f3452f0` → `069b2f1`；中间 `8490228` 动了 10 个 vendored blob，故不是只改个别格子）：①12 个组件文件的三列哈希全部重算（本仓 blob 一列更新 10 项，上游与剥头后两列不变——功能改动未动）；②**剥出处头的方法从 `tail -n +6` 改为按注释块剥**：`8490228` 把出处头改成「①工程口径 + ②功能性改动」分类后行数在 **5–7** 之间浮动，写死行数会得到错的剥头值；③核实 `.module.css` 剥头后 == 上游 **6/6 仍成立**（`StateDot`/`DisclosureRow` 的 blob 变化**只在出处头内**，AA 重映射动的是本仓 L1 `dsw-tokens.css` 的取值，没污染 vendored CSS），`.tsx` 剥头后 ≠ 上游 **6/6 仍成立**；④改动分类逐字对齐实现线出处头（①工程口径；②**可测性** `Tag.tsx`/`StateDot.tsx`；②**依赖收缩** `DisclosureRow.tsx`），原「出处头措辞不实」的分歧已由 `8490228` 消除；⑤支撑文件与 L1 产物哈希更新（`README.md`、`manifest.json`、`dsw-tokens.css` 7080 B）；⑥原「待转实现线」两处计数错值由 `069b2f1` 修掉，销账。 |
