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

> **状态：映射已按实测回填，但切片尚未提交。** 首批 L1+L2 切片（`apps/web/src/vendor/dsh-ui/` 与 `apps/web/src/styles/dsw-tokens.css`）已存在于并行工作线 `feat/p1-138-vendor-ui-primitives` 的**工作区**（观察时**未提交**、无 commit）。第 3 节的映射、blob SHA 与体量均**实测自该工作区**（逐文件 `git hash-object` 核对，方法见 §3.4），不是从任务描述推测的。
>
> **切片合入后须复核**：工作区内容在提交前仍可能变动，故本台账以**哈希**而非路径为锚——合入时重跑 §3.4 的核对命令，任一哈希漂移则本节与第 3 节须同步更新。

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
| `packages/client/ui-theme/src/styles/design-platform.css` | `bc4712b223be682a6066ed706d25b1aadb9254a4` | 19109 | `apps/web/src/styles/dsw-tokens.css` | **派生**：只取 6 个原语 CSS 真正引用的 `--dsw-*` 变量（23 个），静态色阶引用就地展开为 `rgb()` 字面量 |
| `packages/client/ui-theme/src/styles/base.css` | `4c801b8d4dddd3c7a1e619ad8ee0d58eb3a55b11` | 836 | 无（未复制） | 仅用于**确认** `body[data-ds-dark-theme]` 的明暗切换语义，未取任何声明 |
| `packages/client/ui-theme/src/styles/gradient-shadow-text.css` | `36fee4941590cbc09a15a67a8fb4e2c577ea2952` | 14722 | 无 | 未取用 |
| `packages/client/ui-theme/src/styles/scrollbar.css` | `d61bcbcedbdb2459d86220667faf9ed885d3100b` | 4343 | 无 | 未取用 |
| `packages/client/ui-theme/src/styles/corner-shape.css` | `70197aa6a34fc52ef510f247acf11aef024ce98a` | 1135 | 无 | 未取用 |
| `packages/client/ui-theme/src/styles/shiki.css` | `c7a3c5d27219d146d965d0fb37fcc0445d32b089` | 1181 | 无 | 未取用 |

**派生形态与声明义务**：`dsw-tokens.css` 的文件头自带来源声明（上游 repo / 上游文件路径 / 取用 commit / MIT 与版权行），符合 ADR-0008 §3「子树内保留上游 LICENSE 全文与 `Copyright (c) 2026 DeepSeek`」的要求。派生**不豁免** MIT 的声明义务——MIT 覆盖 "copies or substantial portions of the Software"，被抄的 token 取值正是 substantial portion。见 §5。

**L1 的已知边界（已核实，非遗漏）**：`DisclosureRow.module.css`（逐字节照抄的上游文件）引用了两个 **`--dsh-`** 前缀变量——`--dsh-content-font-size-secondary` 与 `--dsh-content-font-delta`。这两个属上游 `body` 发布的 **content 轴**，**不在**本白名单的 `--dsw-*` 范围内，L1 有意不提供；其每一处引用都带 CSS fallback，实测确有（`var(--dsh-content-font-delta, 0px)`、`var(--dsh-content-font-size-secondary, 13px)`），故缺 token 时降级正确、不会渲染错乱。**含义**：L1 的变量面由「被 vendored 的组件 CSS 实际引用」反向定义，不是全量继承——将来 L3 取新组件时，须按同一份 manifest 口径重新推导白名单。

**命名不冲突（已核实）**：上游原语的 token 命名空间是 `--dsw-*`（`packages/client/ui-primitives/src/index.ts` 文档注释原文：*"Cordis-free React primitives styled only through `--dsw-*` tokens."*），本仓既有视觉变量是 `apps/web/src/styles/tokens.css` 里的 `--color-*` / `--space-*` / `--radius-*`。两套前缀不交叠，这是 L1 token 与 WhalePod 自有 token 能并存而不互相覆盖的机制（`dsw-tokens.css` 文件头亦把它记为「双轨并存的已知代价」）。

### 3.2 L2 原语组件（6 个，已实测回填）

首批 L2 实测取用 **6 个组件**：`Button`、`Pill`、`Tag`、`StateDot`、`DisclosureRow`、`Switch`。全部落在 `apps/web/src/vendor/dsh-ui/`。

> 说明：ADR-0008 §2 只给了范围描述（「按钮/弹层/输入」）而**未点名具体 6 个**；下列 6 个是**从切片工作区实测得到**的，不是从文档推断的。注意实际取用的 6 个与 ADR 那句举例并不完全对应（取的是原子级原语，**未取** `Modal` / `Menu` / `Tooltip` / `HoverCard` 等弹层类）。

**复制形态（已核实，逐文件 `git hash-object`）**：

- 6 个 `.module.css` **全部与上游逐字节一致**（哈希相等）→ 未修改的复制。
- 6 个 `.tsx` **全部与上游不同**（哈希不等）→ **已修改的复制**，改动为两类：`clsx` → 本仓 `./cx.js`；import 后缀 `.tsx` → `.js`（`DisclosureRow.tsx` 另有一处 chevron 图标改指 `./icons.js`）。
- MIT 明确允许修改，义务只是"保留声明"——`LICENSE` 已随子树保留（§5.2），故**合规**。但因此**不能**把本子树描述为"未修改的上游副本"。

| # | 组件 | 上游 `.tsx`（blob sha / 字节） | 本仓 `.tsx`（blob sha） | `.tsx` 关系 | 上游 `.module.css`（blob sha） | 本仓 `.module.css`（blob sha） | CSS 关系 |
|---|---|---|---|---|---|---|---|
| 1 | `Button` | `d2e39dbf23867bcfdc4f163fc84c9775e3dbb59a` / 1190 | `5719633ae356883c7e903a7ae8e3213897431d4c` | 已修改 | `9fa1712a669602fb6ec393a3bbe2e25a60d4ee98` | `9fa1712a669602fb6ec393a3bbe2e25a60d4ee98` | **逐字节一致** |
| 2 | `Pill` | `8e2762c714e3a377b60d143e6b2166408865a34d` / 1297 | `a4f4aad94dd4eee43b08a2ec33c9c588f2055d99` | 已修改 | `8fb6cc0bda1a769759cfe645b61c8db51c92f4e8` | `8fb6cc0bda1a769759cfe645b61c8db51c92f4e8` | **逐字节一致** |
| 3 | `Tag` | `b99e9ba2080ed83edd37e2803c77286c4a5e6cb6` / 1592 | `4addaf708587b2379ebd75fece96619801cbd0d7` | 已修改 | `65380320ac1cec80459f3d5fdcdce152c59bfe90` | `65380320ac1cec80459f3d5fdcdce152c59bfe90` | **逐字节一致** |
| 4 | `StateDot` | `0cc825e75ad8689858226b10372ab95bc47b8283` / 1866 | `9aa6628f17bc0489a5ff693030b5e10dd22ef4af` | 已修改 | `265dd1b0a68680f5002a1064bd46a716c05ac853` | `265dd1b0a68680f5002a1064bd46a716c05ac853` | **逐字节一致** |
| 5 | `DisclosureRow` | `f04ad8986a36bc2845446f3aeb211f6fecaf281c` / 3256 | `b58f70f818a7546f9fb2e4c7e2b9771f82c2c983` | 已修改（含图标改指） | `fed453f34575197535098b3bab3466c8aac02b0b` | `fed453f34575197535098b3bab3466c8aac02b0b` | **逐字节一致** |
| 6 | `Switch` | `980a08f6beb1c489ca9b68244a4c991edc350cfa` / 1523 | `f6e546decd08ee2dbcad28da743ed46295ae01d1` | 已修改 | `c038331a6604cd98a3ff72622a62f4d0377704fd` | `c038331a6604cd98a3ff72622a62f4d0377704fd` | **逐字节一致** |

**同目录支撑文件（一并被取用，`manifest.json` 已登记）**：

| 本仓文件 | blob sha | 上游来源 | 关系 |
|---|---|---|---|
| `apps/web/src/vendor/dsh-ui/icons.tsx` | `678c5a2b2792ada36f64449bc6245e51bff050a5` | `ui-primitives/src/icons/props.ts` + `ui-primitives/src/icons/index.tsx` | **合并 + 裁剪**：只留 `IconChevronDownOutline14` 一个符号（路径数据照抄），上游 100+ 图标不取 |
| `apps/web/src/vendor/dsh-ui/index.ts` | `3a146a2a7d4bf092976cd34ffafe3a66d4a9f0e6` | `ui-primitives/src/index.ts` | **裁剪**：只留 6 个原语与其类型的导出（上游桶文件含整包原语） |

**`cx.ts` 的归属须单独注意（实测发现）**：`apps/web/src/vendor/dsh-ui/cx.ts`（blob `369cd1c58f08d7e85024adaa3bd8b7147885f612`）在 `manifest.json` 里登记为 `"upstream": null`——它是**本仓新增代码**（替代上游 `clsx` 调用，避免引入新第三方依赖），**不是** MIT/DeepSeek 代码。它放在 vendored 子树内是对的（就近，且它是为 vendored 组件服务的），但**著作权归属与许可不同**：本仓自有代码按 Apache-2.0（ADR-0006），MIT 那套义务只覆盖 vendored 部分。建议在该文件头显式标注「本仓新增，Apache-2.0」，否则读者会把它误当上游 MIT 代码——**已记入 §7 待办**。

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

**本批执行结果（已实测核对）：通过。** 对已落地的 `apps/web/src/vendor/dsh-ui/` 全目录 grep 品牌资产标识（`FishLogo` / `FISH_LOGO` / `BrandWordmark` / `whale` / `DeepSeek Harness`），**零命中**；18 个文件中没有任何品牌图形。`icons.tsx` 只含 `IconChevronDownOutline14` 一个通用 chevron 符号（非品牌资产）。即 §3.3 的红线在本批**已落实**，不是待办。

### 3.4 哈希核对方法与 Q0 断言现状

**复核命令（合入时重跑，任一漂移即须更新本台账）**：

```console
# 1) 上游侧：取钉住 commit 下目标文件的 blob SHA（本节各表的上游列即由此得来）
$ gh api "repos/deepseek-ai/deepseek-harness/git/trees/<pinned-sha>?recursive=1" \
    --jq '.tree[] | select(.path|test("^packages/client/ui-(theme|primitives)/")) | "\(.sha)\t\(.size)\t\(.path)"'

# 2) 本仓侧：算本地 blob SHA 与上游列逐行比对
$ git hash-object apps/web/src/vendor/dsh-ui/<file>
```

`LICENSE` 的比对结论（唯一要求"一字不改"的文件）：本仓 `git hash-object` 得
`c1f7a78e89e4e4dc7b86664c3b3c76eb5eee1785`，与上游 `LICENSE` blob **完全相等**，1065 B——**逐字节一致，已核实**。

**Q0 断言现状（实测发现一处覆盖缺口）**：ADR-0008 §3 要求 Q0 新增断言「**登记文件覆盖 vendored 目录的每个文件**」。以当前 `manifest.json` 实测对照目录实际内容：

| | 数量 |
|---|---|
| `apps/web/src/vendor/dsh-ui/` 实际文件 | 18 |
| `manifest.json` 的 `components[]` 已登记文件 | 16 |
| **未登记** | `README.md`、`manifest.json` 自身 |

即：按「每个文件」的**字面**口径，当前登记面上有 2 个缺口。`cx.ts` 已登记（`"upstream": null`），支撑文件 `icons.tsx` / `index.ts` / `LICENSE` 也都已登记，所以缺口仅在 `README.md` 与 `manifest.json` 这两个**非源码**文件。三种收口方式，**需切片作者/所有人选一种并落成机器判据**（已记入 §7）：

1. 把两者补进 `components[]`（`README.md` 与 `manifest.json` 与上游无对应，按 `cx.ts` 先例记 `"upstream": null`）；
2. 在断言里把「登记范围」显式定义为「源码文件」（排除 `README.md` / `manifest.json` 等元数据文件），并与台账口径对齐；
3. 由 `manifest.json` 增加一个 `unregistered`/`selfDescribing` 白名单字段显式声明豁免，避免"未登记"与"有意不登记"混同。

**注**：本台账（`docs/agent/dsh-ui-vendoring.md`）是**人读汇总**，不是 Q0 断言去解析的那份；断言的机器可读输入是 `manifest.json`。两处口径必须一致（§7 有对应待办）。

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

**核对结果（已实测）：通过。** 本仓 `git hash-object apps/web/src/vendor/dsh-ui/LICENSE` 得 `c1f7a78e89e4e4dc7b86664c3b3c76eb5eee1785`，与上游钉住 commit 的 `LICENSE` blob **完全相等**，1065 B，首行 `MIT License` / `Copyright (c) 2026 DeepSeek`。即**逐字节一致**——没有漏字、没有被本地改写。核对命令见 §3.4。

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

`ui-primitives` 之所以适合做首个 L2 目标：它在上游 `package.json` 里 **`dependencies: []`**（已核实），即**本就不依赖 cordis**，剥壳成本最低。`ui-theme` 则依赖 `@deepseek-ai/schemastery`（上游 `vendor/schemastery`，MIT，版权行是 `Copyright (c) 2021-present Shigma`，**不是** DeepSeek），所以 L1 必须"剥出 cordis"而不是"整个复制"。

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

切片合并后逐条销账；`[ ]` 未完成，`[x]` 已完成并注明日期。

**已完成（2026-09-10，实测自切片工作区）**

- [x] §3.1 L1 映射回填：`dsw-tokens.css` 派生自 `design-platform.css`，其余 5 个上游 CSS 未取用。
- [x] §3.2 L2 映射回填：6 个组件（Button/Pill/Tag/StateDot/DisclosureRow/Switch）+ 支撑文件，逐文件 blob SHA 已核对。
- [x] 核对 `LICENSE` 与上游 blob `c1f7a78e…`：**逐字节一致**（§5.2）。
- [x] 品牌排除清单实测：vendored 目录零品牌资产（§3.3）。
- [x] 核对 `manifest.json` 的上游 repo / commit SHA / commitDate 与上游 API 一致（`c291e796…`、`2026-09-10T14:17:09Z`）；逐文件映射与本台账一致。

**待回填（切片合入后）**

- [ ] 切片合入后**重跑 §3.4 核对命令**：18 个文件的本仓 blob SHA 是否仍与 §3.2/§3.3 记录一致；不一致即按实测更新本台账。
- [ ] 销掉顶部「切片尚未提交」的观察态说明，改为指向实际 commit。
- [ ] 在 `apps/web/src/vendor/dsh-ui/cx.ts` 文件头标注「本仓新增，Apache-2.0，非上游 MIT 代码」（§3.2 末段理由）。

**待仓库所有人 / 切片作者拍板**

- [ ] **Q0 登记覆盖面缺口（§3.4）**：`manifest.json` 的 `components[]` 登记 16 个文件，目录实际 18 个，`README.md` 与 `manifest.json` 自身未登记。ADR-0008 §3 要求「登记文件覆盖 vendored 目录的每个文件」。三种收口方式（补登记 / 显式定义登记范围为源码文件 / 加豁免字段）选一种并落成机器判据。
- [ ] **§6.3 的 scope 口径差**：ADR-0008 §3 写「零 `@deepseek-ai/*` import」，而 `check-boundaries.ts` 的 `DSH_PREFIXES` 只覆盖 `@deepseek-ai/dsh*` 与 `@deepseek-ai/cordis`。要不要把 Q0 新断言的覆盖面扩到整个 `@deepseek-ai/` scope？
- [ ] 「可复跑取源脚本」的落地时机（ADR-0008 §3 说与 L3 一起评估；在此之前**不得**声称出处可复现）。是否需要一个只做「按 SHA 取文件 + 校验 blob SHA」的最小脚本先行？
- [ ] 公开发布前是否按 ADR-0006 的约定，由项目权利人对 MIT 引入面做一次法律审阅。

---

## 变更记录

| 日期 | 变更 |
|---|---|
| 2026-09-10 | 建档。钉住上游 `c291e7961a515f6d7af9304e7fd1d257929aef26`；核实 L1 六个 CSS 与 `ui-primitives` 组件清单的路径/blob SHA/体量；登记品牌排除清单。 |
| 2026-09-10 | 按 §3.4 方法**实测回填**：6 个 L2 组件（Button/Pill/Tag/StateDot/DisclosureRow/Switch）+ `icons.tsx`/`index.ts`/`cx.ts`/`LICENSE` 的本仓 blob SHA 与复制形态（6 个 `.module.css` 逐字节一致、6 个 `.tsx` 已修改）；`LICENSE` 与上游 blob 逐字节一致；品牌排除清单实测通过；记入 Q0 登记覆盖面缺口（`README.md`/`manifest.json` 未登记）与 `cx.ts` 归属标注待办。**切片当时尚未提交，哈希为准，合入后须复核。** |
