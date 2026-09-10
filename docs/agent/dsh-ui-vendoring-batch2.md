# DSH client UI vendored 出处台账（#138 L2 第二批增量）

本文件是 [dsh-ui-vendoring.md](./dsh-ui-vendoring.md)（主台账）的**增量补页**，格式与读法照抄
主台账 §3.2 的三列表。主台账在另一条分支（`docs/p1-138-vendoring-provenance`）上尚未合入
`main`，本切片**无权也不改它**；主协调者合并后把本页并进主台账 §3.2 即可。

**本页只覆盖 `feat/p1-138-l2-batch2` 这一批新增/改动的文件**，不重复主台账已登记的
首批 6 个原语与 L1 产物（那些条目在主台账里仍然有效，本切片未动它们的正文）。

---

## 0. 本批范围与锚点

| 项 | 值 |
|---|---|
| 分支 | `feat/p1-138-l2-batch2`（基于 `main` = `70d7342`） |
| **锚点 commit** | `a262cd4ac8769868a1f72d80d2206015dd195592`（审查整改提交）。本切片共三条：`e138bbc` 首批交付 → `a262cd4ac8769868a1f72d80d2206015dd195592` 审查整改 → `a1b00ae` 台账回填（**纯文档**，`git diff --name-only a262cd4..a1b00ae` 只有本文件，故 vendored 子树的 blob 与 a262cd4 逐字节相同，下表哈希无需重算） |
| 上游钉版 | 与主台账一致：`c291e7961a515f6d7af9304e7fd1d257929aef26`（**本切片未跟版**，实测该 SHA 仍是上游 `master` 的 HEAD，2026-09-11） |
| 本批新增原语 | `Input` / `Menu` / `ConnectionIndicator` / `Modal`（**4 个，全部整取，未经裁剪**） |
| 本批新增支撑文件 | `pointer-grace.ts`（Menu 的同目录运行时依赖）；`icons.tsx` 追加 3 个图标符号 |
| 本批 L1 增量 | `apps/web/src/styles/dsw-tokens.css` 追加 29 条声明（新引用 14 个组件变量 + 15 个传递依赖） |
| 纪律 | **additive vendoring：本切片一个页面都没改**（`routes/**` 与 `features/**` 零 diff），页面迁移由主协调者另行安排 |

> **哈希锚点（读表前必读，照抄主台账 §3.2 的纪律）**：下表三个哈希列全部对应**提交状态**
> `e138bbc`，用 `git rev-parse e138bbc:<path>` 复算。**不要对工作区跑 `git hash-object`**——
> 主台账早期版本正因对工作区取值而整列失效。比较必须用「剥出处头后」那一列：
> **本仓 blob ≠ 上游 blob**（每个文件都带出处头块）。

**[本切片相对主台账的一处口径扩展]**：首批出处头是 5–7 行，主台账因此强调「不要写死行数、
按注释块剥」。本批四个 `.tsx` 的出处头因为要写清「整取 + 迁移注意点」，变长到 **6–26 行**
（见下表「头行数」列）——同一条纪律仍然成立且**更加**必要：写死 `tail -n +6` 在本批会得到
完全错误的结果。剥头命令见 §4。

---

## 1. 上游钉版（本批复核）

本批未跟版。复核项与结果：

| 项 | 值 | 复核方式 |
|---|---|---|
| 上游仓库 | `github.com/deepseek-ai/deepseek-harness` | `gh api repos/…` |
| 取用 commit | `c291e7961a515f6d7af9304e7fd1d257929aef26` | 实测**仍是** `master` 当前 HEAD（2026-09-11） |
| 上游许可 | MIT / `Copyright (c) 2026 DeepSeek` | 未变；本切片**未新增 LICENSE 副本**需求（子树内 `LICENSE` 已由首批承载，blob `c1f7a78e…`） |
| 本批取源命令 | `gh api -H 'Accept: application/vnd.github.raw' repos/deepseek-ai/deepseek-harness/contents/packages/client/ui-primitives/src/<file>?ref=c291e796…` | 取到的 9 个文件 blob SHA **全部**与主台账 §3.2 候选表登记的期望值逐字节相符（见 §2 的上游列） |

> 这张「上游列与主台账候选表相符」的对照是本批的**独立交叉校验**：主台账 §3.2 的候选清单
> 在首批写作时就登记了 `Input`/`Menu`/`ConnectionIndicator`/`Modal` 的上游 blob SHA 与体量，
> 本批取源后逐个复算，**9/9 相符**（4 对 `.tsx`+`.module.css` 共 8 个 + `pointer-grace.ts`），
> 即「候选表里的数字是可用的」这件事本身也被实测确认了一次。

---

## 2. 逐文件映射表（本批 9 个新增文件 + 3 个改动文件）

### 2.1 `.module.css`（4/4：剥掉出处头后与上游**逐字节一致**）

| # | 组件 | 上游 blob | 本仓 blob@`e138bbc` | 剥头后 blob | 头行数 | 上游字节 → 本仓字节 | 剥头后 vs 上游 |
|---|---|---|---|---|---|---|---|
| 1 | `Input.module.css` | `5102c3291f4d08e4bd4a5ba775d90370a23ae0cd` | `843ca4fcbe7a8b68c017e8a35796e1945ec2b380` | `5102c3291f4d08e4bd4a5ba775d90370a23ae0cd` | 6 | 693 → 1097 | **相等** |
| 2 | `Menu.module.css` | `a63209665966d9502373ab46267e03bd6dd921cf` | `081b39eaf1a2dfa1bd51f0e24fe882c46f82eb56` | `a63209665966d9502373ab46267e03bd6dd921cf` | 6 | 5758 → 6161 | **相等** |
| 3 | `ConnectionIndicator.module.css` | `bf0e653740112587c65bf6e708fca0f2f5f37374` | `f0c9d429af9bf58ba20c208c5f5ad7cd367fe640` | `bf0e653740112587c65bf6e708fca0f2f5f37374` | 6 | 1835 → 2253 | **相等** |
| 4 | `Modal.module.css` | `44ec4b7d932d8a14c68b89b86f089aa4c7abee26` | `dd0f96258e4e3120cfc85caac74924108cccc2ae` | `44ec4b7d932d8a14c68b89b86f089aa4c7abee26` | 6 | 2103 → 2507 | **相等** |

**结论（带条件，措辞照抄主台账）**：4 个 `.module.css` 是「**剥掉出处头后**与上游逐字节
一致」——**不能**简写成「与上游逐字节一致」（提交 blob 与上游 blob 不相等，差的正是出处头，
如上表字节列所示）。样式声明本身一字未改，该结论对 4/4 成立。

### 2.2 `.ts`（1/1：剥头后与上游**逐字节一致**）

| # | 文件 | 上游 blob | 本仓 blob@`e138bbc` | 剥头后 blob | 头行数 | 上游字节 → 本仓字节 | 剥头后 vs 上游 |
|---|---|---|---|---|---|---|---|
| 1 | `pointer-grace.ts` | `4b91a84b0a01f13d86d75618a25f2ce513966d8c` | `1ca8068c95d27a29233114840baf1af9a5e48869` | `4b91a84b0a01f13d86d75618a25f2ce513966d8c` | 8 | 1534 → 2126 | **相等** |

它是 Menu 的**同目录运行时依赖**（`usePointerGrace`），上游零 cordis、只 import `react`，
故与本批四个原语一并整取（首批未取是因为首批 6 个原语里只有 Menu/HoverCard 用得上它）。

### 2.3 `.tsx`（4/4：剥掉出处头后**仍**与上游不同——因为含功能性改动）

| # | 组件 | 上游 blob | 本仓 blob@`e138bbc` | 剥头后 blob | 头行数 | 上游字节 → 本仓字节 | 剥头后 vs 上游 | 剥头后仍然存在的改动（逐行核对过） |
|---|---|---|---|---|---|---|---|---|
| 1 | `Input.tsx` | `3af60f9d184be4c734e92f0d1231a90c81e11bd1` | `faa5b4b835f0578133777a3f5640361bd41b0ec1` | `6f65a726b94028e386f8a57c9e74770eb163a473` | 10 | 809 → 1981 | 不同 | ① `clsx` → `./cx.js`（import + 1 处调用）；② 可测性：wrapper span 新增 `data-vendored="input"` 与可覆写 `data-testid` |
| 2 | `Menu.tsx` | `db8b5588fee8490fce5c41cd9f4e989f23bf518a` | `27a1188165a4f8265daa64da47d6a4860f9a8012` | `fdc829dc37d05ad7a1f56c3d83fb68b92f234235` | 26 | 14318 → 16583 | 不同 | ① `clsx` → `./cx.js`（import + 6 处调用）；① 图标 `./icons/index.tsx` → `./icons.js`；① hook `./pointer-grace.ts` → `./pointer-grace.js`；② 可测性：wrapper span 新增 `data-vendored="menu"` 与可覆写 `data-testid` |
| 3 | `ConnectionIndicator.tsx` | `2c549661df0e17aac49aec47f1f1ed70102ad6fc` | `6a297ec7586e96c7a2eeedeb22730e898a308a47` | `951629661ff49c0a651b1afe6d27354a04974047` | 10 | 3281 → 4716 | 不同 | ① **无 clsx 改动**（上游本文件 clsx 零命中，实测）；① 两个图标 `./icons/index.tsx` → `./icons.js`；② 可测性：**两个渲染分支**都新增 `data-vendored="connection-indicator"` 与可覆写 `data-testid` |
| 4 | `Modal.tsx` | `fd33a8724cd635547cee33b553ef9464500891e8` | `c1b91cfe241aed5760316fd0daeb949ad96bffdc` | `f4a75f00ee82fb6d2386d841a83065a5816f0ccb` | 18 | 2963 → 4551 | 不同 | ① `clsx` → `./cx.js`（import + 2 处调用）；① close 图标 `./icons/index.tsx` → `./icons.js`；② 可测性：新增**可选**属性 `data-testid`（给了才落到 `role="dialog"` 卡片上，没给不上屏） |

`Menu.tsx` 的「剥头后 ≠ 上游」已用 `diff` 逐行核对：差异**只有** §2.3 表右列那四类，
没有夹带任何视觉/行为改动（`className` 拼接语义、定位算法、事件监听、`stopPropagation`
全部与上游一致，`cx` 只是 `clsx` 的等价替换）。

### 2.4 本批改动的既有文件（首批已登记，本批只追加）

| 本仓文件 | 本仓 blob@`e138bbc` | 本仓字节 | 本批改动 | 上游关系 |
|---|---|---|---|---|
| `apps/web/src/vendor/dsh-ui/icons.tsx` | `092edae3dc3f69390dd1437e1e09887424952d68` | 4922 | **追加 3 个符号**：`IconCheckOutline16`（Menu）、`IconCloseOutline16`（Modal）、`IconWarningOutline16`（ConnectionIndicator）；原有 `IconChevronDownOutline14` 未动 | 仍取自上游 `icons/index.tsx`（blob `7f1a3de926fc41732e3ed75ce184406ab8a5c106`，119245 B）+ `icons/props.ts`；**合并 + 裁剪**，4 个符号的路径数据逐字节照抄（注意 `IconWarningOutline16` 上游默认 `size` 就是 **14**，不是 16） |
| `apps/web/src/vendor/dsh-ui/index.ts` | `facc27a55cb39211e8fbfbb2342e7b2a8d6f1f80` | 2176 | 追加 4 个原语 + `Menu` 的 4 个类型 + `usePointerGrace`/`POINTER_GRACE_MS`/`cx` 的导出 | 上游 `ui-primitives/src/index.ts` 的**裁剪**版 |
| `apps/web/src/vendor/dsh-ui/cx.ts` | `e020935db7e372f3d77aed0ccd00d6e1fe7840a3` | 1765 | **扩展入参形态**：新增「对象入参按真值拼键名」一档（ConnectionIndicator 用了 `{ [css.secondDot]: true }`）；仍是 clsx 的子集，不是全实现 | **本仓新增代码**（Apache-2.0），非上游文件 |
| `apps/web/src/vendor/dsh-ui/README.md` | `3fd56b44c342963ecc5b4cc41b5f19863cd71b7c` | 4416 | 列进本批 4 个原语、重申「不含任何 DSH 品牌资产」、补 4 类 `--dsh-*` 例外的性质区分、把允许的运行时 import 从「只 react」放宽为「react / react-dom」 | 本仓新增 |
| `apps/web/src/vendor/dsh-ui/manifest.json` | `e081c9d845987e79b0a926d36023124d2561a133` | 19335 | `components[]` 15 → **24**、`meta[]` 3（不变）、`scope.layers`/`excluded`/`tokens` 同步；审查整改再为每条加 `sha256`/`upstreamBlob`/`upstreamSha256`/`fidelity` 四个保真字段（见 §3.5） | 本仓新增（机器可读台账自身） |

> 上表 5 个 blob 全部实测于锚点 `e138bbc`（`git rev-parse e138bbc:<path>`）。其中
> `cx.ts` 是**本仓新增代码**、`README.md`/`manifest.json` 是元文件，它们与上游**没有**
> 「剥头后比对」这回事（前者不是上游代码，后两者上游无对应物）。

**本批新增但未入 vendored 目录的产物（记在此供主台账对齐）**：

| 本仓文件 | 本仓 blob@`e138bbc` | 本仓字节 | 上游关系 |
|---|---|---|---|
| `apps/web/src/styles/dsw-tokens.css` | `7e9acd44b56d35d3fe92eeebd4d5bfc6228fe71b` | 16264 | 上游 `design-platform.css`（`bc4712b2…`，19109 B）+ `gradient-shadow-text.css`（`36fee494…`，14722 B）的**派生白名单**，非逐字节复制 |
| `apps/web/tests/vendor-dsh-ui.spec.tsx` | `d6be55b37f4d28d6e154f3623892bcb52fbccebc` | 67147 | 本仓新增（Q0 单测），上游无对应物 |
| `docs/agent/dsh-ui-vendoring-batch2.md`（即本页） | — | — | 本仓新增 |


### 2.5 登记覆盖核对（Q0 断言口径）

| | 数量 |
|---|---|
| `components[]`（源码与样式：`.ts`/`.tsx`/`.module.css`） | **24**（首批 15 + 本批 9） |
| `meta[]`（元文件：`README.md` / `LICENSE` / `manifest.json`） | **3** |
| **并集** | **27** |
| `apps/web/src/vendor/dsh-ui/` 实际文件 | **27** |

实测对照：`MISSING=[]`、`EXTRA=[]`——**27 对 27，恰好全覆盖**。口径写在 `manifest.json`
的 `coverage` 字段里，并由 Q0 单测 `apps/web/tests/vendor-dsh-ui.spec.tsx` 的用例
「manifest.json 覆盖口径」断言 `[...components, ...meta].sort()` 与 `readdirSync` 逐项相等；
同一用例仍**反向钉住上游 commit**（`c291e796…`），所以钉版 SHA 被机器守着。

---

## 3. L1 增量（`apps/web/src/styles/dsw-tokens.css`）

本批对 L1 的改动**只在 `dsw-tokens.css` 内追加**，未改任何既有声明取值。

### 3.1 变量账（实测复算）

三个数要分清：

| 口径 | 首批 | 本批新增 | 两批并集 | 复算命令 |
|---|---|---|---|---|
| vendored CSS **引用**的 `--dsw-*` | 23 | **14** | **37** | `grep -hoE 'var\(--dsw-[a-z0-9-]+' apps/web/src/vendor/dsh-ui/*.module.css \| sed 's/var(//' \| sort -u \| wc -l`（**必须带 `var(` 锚**，理由见表下注） |
| `dsw-tokens.css` **声明**的 `--dsw-*` | 26 | **27** | **53** | `grep -oE '^\s*--dsw-[a-z0-9-]+' apps/web/src/styles/dsw-tokens.css \| sed 's/^ *//' \| sort -u \| wc -l` |
| 其中深色段**重写**的 | 17 | **11** | **28** | 见 §3.3 |

- **新引用的 14 个**（逐个 grep 本批 4 个 `.module.css` 得到）：
  `--dsw-alias-bg-layer-1`、`--dsw-alias-bg-mask-1`、`--dsw-alias-border-l1`、
  `--dsw-alias-border-l2`、`--dsw-alias-interactive-bg-hover-danger`、
  `--dsw-alias-label-dimmed`、`--dsw-alias-scrollbar-bg-l2`、`--dsw-alias-scrollbar-hover-l2`、
  `--dsw-alias-state-success-tertiary`、`--dsw-alias-state-warn-label`、
  `--dsw-alias-state-warn-tertiary`、`--dsw-specific-menu`、
  `--dsw-elevation-prominent`、`--dsw-mask-blur`。
- **新声明 27 条 = 上列 14 个 + 13 个传递依赖**（审查后从初版的 29 条减到 27 条，见下条）。
  13 个传递依赖 = **11 个 `--dsw-static-*`** + **2 个 elevation 派生值**
  （`--dsw-elevation-stroke`、`--dsw-elevation-stroke-color`，是 `--dsw-elevation-prominent`
  的传递依赖，见 §3.2）。另有 `--dsw-mask-blur` 与默认描边色属上列 14 个之内的直接引用。
- **⚠ 初版多带了两个零消费者变量，审查后删除（本页据实登记）**：`--dsw-static-amber-500`
  与 `--dsw-static-neutral-bluish-1000`。初版按「上游那一段的静态档整批搬进来、同一档只声明
  一次」的理由收录，但两者在本仓**都没有 `var()` 消费者**——它们的上游消费者
  （`--dsw-alias-state-warn-primary`、`--dsw-alias-brand-primary`）在**首批就已经被就地展开
  成字面量**（`rgb(245, 158, 11)` / `rgb(15, 17, 21)`），从来不是 alias 引用。留着它们等于让
  同一档位在文件里有两处取值，正是该文件自称要避免的漂移。现已删除，并新增一条 Q0 用例
  `L1 声明的每个 --dsw-* 都有消费者（无孤儿变量）`守这个不变量（消费者口径 = vendored CSS /
  L1 内部 alias 间接 / `global.css` 三处之一；首批三个 900 档静态色阶由 `global.css` 消费，
  正是必须把第三处算进来的原因）。
  **要恢复它们的前提**：先把首批那两处字面量改回 alias 指引（即 §3.5「两批写法不一」的归一动作）。
- **关键正确性属性（实测）**：两批并集的 37 个引用变量**全部**在 `dsw-tokens.css` 里有声明
  ——差集为空，即**没有未解析引用**，不会静默落到 CSS fallback。Q0 单测已把这 37 这个数钉死。

> **`var(` 锚不是可选的（审查纠出的一处台账错误）**：本页初版给的引用计数命令是
> `grep -hoE '\-\-dsw-[a-z0-9-]+' …`，实测得 **38**，与表里的 37 对不上。多出来的那一个是
> `--dsw-elevation-stroke-color`——`Menu.module.css` 里它是**被赋值**的
> （`--dsw-elevation-stroke-color: var(--dsw-alias-border-l1)`），不是被读取的，裸 grep 会把
> 赋值也数进去。**37 是对的**（Q0 的正则带 `var\(` 锚），错的是命令。凡是"引用口径"的计数，
> 命令必须写成 `grep -hoE 'var\(--dsw-…'`。本页与 Q0 现已同口径。

### 3.2 elevation：**两块**选择器，默认值与派生值不能合并（审查纠出的一处语义错误）

`--dsw-elevation-stroke-color` / `--dsw-mask-blur` / `--dsw-elevation-stroke` /
`--dsw-elevation-prominent` 取自上游 **`packages/client/ui-theme/src/styles/gradient-shadow-text.css`**
（不是 `design-platform.css`——本批实测确认这四个变量不在 design-platform.css 里，
主台账 §3.1 把 L1 来源只记了 design-platform.css，**本条是主台账需要补的一句**）。上游的分工是：

| 上游位置 | 声明什么 | 选择器 |
|---|---|---|
| 17 / 19 行 | **只声明默认值** `--dsw-elevation-stroke-color`、`--dsw-mask-blur` | **`body`** |
| 26–35 行 | **只声明派生值** `--dsw-elevation-stroke` / `-panel` / `-prominent` / `-soft` | **`body, body *`** |

上游注释原文（那段的用意）：「默认色只声明在 body 上，让表面的重绑沿继承传给真正消费投影的
后代。」而派生值必须逐元素声明，因为继承传下来的是在祖先处**已代入完** `var()` 的值，
后代重绑 `--dsw-elevation-stroke-color` 就进不到 `var(--dsw-elevation-*)` 里。

> **本切片初版把四个变量全放进了 `body, body *`，被审查判为语义错误，已改正。**
> 坏法：等于**每个元素**都重新声明默认描边色 l4，重绑元素的**后代**会拿到 l4 而不是继承来的
> 重绑色。今天不显形，只是因为唯一重绑方 `Menu.module.css` 的 `.list/.submenu` 在同一条规则里
> 自己消费 `box-shadow`（Modal 只消费不重绑）。
> 同时纠正一处措辞：本页初版与提交说明里那句「必须挂 `body, body *`」**只对派生两项成立**。
> 现行 Q0 用例 `elevation 的默认色与派生值**分挂两块**` 正反两面都钉住（两块各自该有什么、
> 默认值**不得**出现在 `body, body *` 里、三者都不得进 `:root`）。
> **教训**：抄"选择器与上游同形"时要逐个变量对齐到上游的**那一行**，不要按"整段一起抄"。

**已知代价（已实测）**：`body *` 是通配规则，占的是 `--dsw-*` 命名空间。实测
apps/web 下没有任何内联 `style=` / `style={{` 写法、也没有 `setProperty` 调用，故不覆盖
任何既有变量；风险留给 L3：将来谁要写内联 `--dsw-*` 变量必须知道这条规则存在。

### 3.3 深色段

本批新增的 11 个深色重写（上游 `body[data-ds-dark-theme]` 段逐字照抄）：
`--dsw-alias-bg-layer-1`、`--dsw-alias-bg-mask-1`、`--dsw-alias-border-l1`、
`--dsw-alias-border-l2`、`--dsw-alias-interactive-bg-hover-danger`、`--dsw-alias-label-dimmed`、
`--dsw-alias-scrollbar-bg-l2`、`--dsw-alias-scrollbar-hover-l2`、
`--dsw-alias-state-success-tertiary`、`--dsw-alias-state-warn-tertiary`、`--dsw-specific-menu`。

两个**容易想当然**的地方（上游如此，不是抄错）：

- `state-success-tertiary` / `state-warn-tertiary` 深色下**不沿用同一个静态档**
  （浅色 `green-100`/`amber-100` → 深色 `green-900`/`amber-900`）；
- `state-warn-label`（`amber-600`）与 `state-warn-primary`（`amber-500`）是**两个不同档位**，
  ConnectionIndicator 的 warn 面同时吃这两个，合并成一个就是 bug（Q0 单测已钉住两者不相等）。

### 3.4 `--dsh-*` 例外清单从 2 个变成 4 个（且性质分两类）

| 变量 | 谁用 | 性质 |
|---|---|---|
| `--dsh-content-font-size-secondary` / `--dsh-content-font-delta` | `DisclosureRow.module.css` | **被 `var()` 读取**；每处引用都带 fallback（13px / 0px），L1 不提供也能正确降级 |
| `--dsh-scrollbar-thumb` / `--dsh-scrollbar-thumb-hover` | `Menu.module.css` | **被赋值/重绑**（`--dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2)`）；Menu 自己**不读**它们。消费方是上游 `scrollbar.css`（`body` 与 `::-webkit-scrollbar` 规则），**本仓没取那份样式** ⇒ 这两条声明当前**被声明但无人消费，既不生效也不报错** |

> 这条区分是本批实测纠出来的一处**我自己的初版错误**：初稿把两者都写成「引用方」并声称
> 「L1 不提供则滚动条回落浏览器默认皮肤」——实测 `var(--dsh-scrollbar-thumb)` 在
> `vendor/dsh-ui/` 下**零命中**（Menu 只声明、不读取），该说法不成立，已改为上表措辞。
> 同时暴露出一个正则坑：用 `(--dsh-x)\s*:` 判定「本目录是否定义了它」会因**回溯**把
> `--dsh-scrollbar-thumb-hover:` 也当成 `--dsh-scrollbar-thumb` 的定义（`"thum"` +
> `"-hover:"` 满足模式），Q0 单测因此按「前置 `{`/`;`/行首」锚定写法修正。

### 3.5 逐字节保真的机器门（审查要求新增；此前**没有**门）

**问题（审查员用变异测试实测出来的）**：在本批之前，"vendored 副本与上游逐字节可比"这条纪律
**只靠人工哈希台账守**。实测把 `Menu.module.css` 的 `min-width: 218px` 改成 `200px`、
或把 `IconWarningOutline16` 的路径尾数 `3.32843Z` 改成 `3.32844Z`，**旧门 51 例全绿**——
因为原有断言只有三项：上游 commit SHA、登记覆盖并集、出处头存在，都不看正文。

**现在（登记 + 断言两层）**：

1. `manifest.json` 里 `components[]`/`meta[]` **每条**新增四个字段：
   `sha256`（**本仓文件**内容哈希，含出处头）、`upstreamBlob`（上游 blob sha1，口径同
   `git hash-object`；`null` = 本仓新增或无单一上游来源）、`upstreamSha256`（上游内容哈希）、
   `fidelity`（`stripped-matches-upstream` / `local-adaptations` / `no-single-upstream-source`）。
   **上游值就登记在仓里 ⇒ 断网可验**（不需要再连 GitHub 才能判"是否被改过"）。
2. Q0 新增两条用例：
   - `逐字节保真的机器门`：逐文件①算 sha256 与登记值比对（任何改动都变红）；②凡是
     `fidelity=stripped-matches-upstream` 的，**剥掉出处头块后**的 blob 必须等于登记的
     `upstreamBlob`（这一条才真正守住"只有出处头之差"）；③声明了保真却没登记
     `upstreamBlob` 要报错（防止用空值把门绕过）；④保真条目数 ≥ 11（门形同虚设也要报错）。
   - `manifest 登记的 upstreamBlob 与上游原文一致（离线自洽）`：把"本仓剥头结果"与
     manifest 的 blob / sha256 两个登记值三角核对，任一处被改都变红。
3. **唯一例外是结构性的**：`manifest.json` 自己登记自己的 `sha256` **没有不动点**
   （写进去就改了内容，再算又变），故该条显式 `null`，其完整性由 git 与本用例的 `JSON.parse`
   守。别为此发明"算完再回填"的循环——本切片试过，不收敛。

**当前分布（实测 24 个 components + 3 个 meta）**：
`stripped-matches-upstream` = **11 个**（首批 6 个 `.module.css` + 本批 4 个 `.module.css` +
`pointer-grace.ts`）；`local-adaptations` = **10 个**（首批 6 个 `.tsx` + 本批 4 个 `.tsx`，
即全部含本仓功能性改动的代码文件）；`no-single-upstream-source` = **6 个**
（`icons.tsx`（两文件合并+裁剪）、`index.ts`（裁剪）、`cx.ts`（本仓新增）、
`README.md` / `LICENSE` / `manifest.json`（元文件））。
**顺带得到一条交叉验证**：本次为回填 `upstreamBlob` 而**独立重算了首批 6 个 `.module.css`
的上游 blob**，结果与主台账 §3.2 登记值**逐字节相符**（`9fa1712a…`/`8fb6cc0b…`/`65380320…`/
`265dd1b0…`/`fed453f3…`/`c038331a…`）——主台账那两列是可复算的。

**变异测试证据（两次都各跑一次，见 §9 报告）**：变异 A（`min-width` 218→200）使 2 条用例变红
（本仓 sha256 不符 + 剥头后 sha256 不符）；变异 B（图标路径尾数改一位）使 1 条变红
（本仓 sha256 不符）。恢复后 56 例全绿，且 `shasum -a 256` 与恢复前逐字符相同。

### 3.6 本批视觉的已知 AA 缺口（数字登记，供迁移切片当判据）

`ConnectionIndicator` 的两个面都是**浅底 + 同色系小字**，实测都不达 WCAG AA 的 4.5:1
（与首批 Tag 同源问题：上游只给了 `state-warn-label` 一个文字专用变体，success 面直接拿
`state-success-primary` 当文字色）。**数字由 Q0 用例真算并钉住**（`ConnectionIndicator 配色 AA 门`）：

| 面 | 文字 token（实测解析值） | 底色 token | 实测对比度 | AA 4.5:1 |
|---|---|---|---|---|
| 断线 / 重连（`.warning`） | `--dsw-alias-state-warn-label` → `--dsw-static-amber-600` = `rgb(221, 134, 41)` | `--dsw-alias-state-warn-tertiary` → `--dsw-static-amber-100` = `rgb(254, 245, 231)` | **2.58 : 1** | ✗ 差 1.92 |
| 已恢复（`.success`） | `--dsw-alias-state-success-primary` = `rgb(34, 197, 94)` | `--dsw-alias-state-success-tertiary` → `--dsw-static-green-100` = `rgb(230, 250, 237)` | **2.09 : 1** | ✗ 差 2.41 |

处置与首批一致：**不改 vendored 文件、也不改 L1 取值**（L1 必须与上游逐字一致），迁移时在
包裹元素上做局部重映射（同 `global.css` 的 `.device-status-*`）。用例同时断言"**不达标**"
（达标即说明上游取值变了，要重评这条门）与"数字未漂移（±0.01）"。
深色一套取值不同，本仓没有深色入口，故只登记不判。

---

### 3.7 本页哈希的**自校验**（差集为空 = 没有一条声明是推测的）

本页写作与整改后各跑过一次全量对账，方法：把本页里所有 40 位十六进制引用抽出来，
逐个在锚点 `a262cd4` 上找归属。结果（**32 条去重声明**）：

| 归类 | 数量 | 说明 |
|---|---|---|
| 本仓文件 blob@锚点 | **16** | 逐个 `git rev-parse a262cd4:<path>` 命中 |
| 本仓「剥出处头后」blob | **9** | 逐个 `git show … \| sed '1,/^\*\/$/d' \| git hash-object --stdin` 命中 |
| 上游文件 blob | **5** | `Input.tsx`/`Menu.tsx`/`ConnectionIndicator.tsx`/`Modal.tsx`/`icons/index.tsx`，逐个与按钉版 SHA 取来的原文 `git hash-object` 命中 |
| commit SHA（非 blob） | **2** | 锚点 `a262cd4`（本地 git object）与上游钉版 `c291e796`（`gh api` 复核仍是 master HEAD，与 manifest 登记值一致） |
| **无法归属 / 差集** | **0** | —— |
| 合计（去重） | **32** | 16 + 9 + 5 + 2；其中 5 个"剥头后"值与上游 blob 相等（即纯粹只有出处头之差），去重后并入上游那一行 |

**读法**：本页凡出现哈希，都能在锚点上复算出来；没有一条是从任务描述或工作区快照推测的。
复算脚本形态见 §4；上游 blob 与「剥头后」blob 的比较必须用后者（本仓 blob 必然多一个出处头块）。

复算 §4 之前先确认工作区干净：本切片历史上出现过"工作区值 ≠ 提交值"（台账 §2 写作期间
manifest 因回填字段而变动），**所有哈希一律以锚点 commit 的 blob 为单位取值**。

## 4. 复算命令（照抄主台账 §3.4 的形状）

```console
SHA=c291e7961a515f6d7af9304e7fd1d257929aef26   # 上游钉住 commit（本批未跟版）
C=a262cd4ac8769868a1f72d80d2206015dd195592     # 本批锚点 commit

# 1) 上游侧：取原文并本地算哈希（不依赖 tree API 的 .sha 字段，独立可证）
$ gh api -H 'Accept: application/vnd.github.raw' \
    "repos/deepseek-ai/deepseek-harness/contents/<upstream-path>?ref=$SHA" | git hash-object --stdin

# 2) 本仓侧：**锚在 commit 上**，不要对工作区跑 hash-object
$ git rev-parse "$C:apps/web/src/vendor/dsh-ui/<file>"

# 3) 剥出处头：按**注释块**剥，不要写死行数（本批出处头 6–26 行不等）
$ git show "$C:apps/web/src/vendor/dsh-ui/<file>" \
    | sed '1,/^[[:space:]]*\*\/[[:space:]]*$/d' | git hash-object --stdin
```

第 3 步是判定「除出处头外还改了什么」的关键：**剥头后 == 上游** ⟹ 只有出处头之差
（本批 4/4 `.module.css` + 1/1 `.ts`）；**剥头后 ≠ 上游** ⟹ 另有实质改动
（本批 4/4 `.tsx`，逐行差异见 §2.3 右列）。

---

### 4.1 一次额外的实测：本批原语**没有**进产物包（additive vendoring 的直接后果）

`pnpm -r --if-present build` 成功之后，对 `apps/web/dist/assets/*.js|css` 实测：

| 探针 | 结果 | 含义 |
|---|---|---|
| `data-state` / `data-tone`（首批 StateDot/Tag 的选择器） | 命中 | 首批组件**在产物里**（`routes/DevicesPage.tsx` 真的 import 了它们） |
| `backdrop-filter`（Modal）/ `218px`（Menu 卡宽）/ `reveal-second-dot`（CI 动画） | **全部 0 命中** | 本批 4 个组件的 CSS 与 JS **被 Tree-shaking 掉了** |

原因：`apps/web/src/` 下**只有** `routes/DevicesPage.tsx` 一处 import 了
`vendor/dsh-ui/index.js`（首批的 StateDot + Tag），本批 4 个原语**没有任何页面 import**，
所以打包器正确地判定它们是死代码。

**这不是缺陷，是「只做 additive vendoring、不改页面」的必然结果**——本批的交付物是
「原语可用 + 有测试 + 登记齐全」，不是「原语已上屏」。含义有两条，主协调者排页面迁移时要知道：

1. **产物体积零增长**：本批不改变线上任何东西，可以独立合入而不影响其它两个切片的产物。
2. **迁移完成后要重跑一次产物核对**：页面接上后，上表的三个探针应当由 0 变正；若仍为 0，
   说明 import 没接上或被打包器丢了（这类坏法很安静：类型与单测都会绿）。
   建议把这三个探针当作迁移验收的一条机器判据。

---

## 5. 本批未做 / 未验（如实登记）


- **页面一个没改**（additive vendoring 的纪律要求）。因此本批 4 个原语**只有原语级 Q0 用例**，
  **没有**首批 B 类那样的真实界面接线用例（首批把 `/devices` 换成了 StateDot+Tag）。
  页面迁移由主协调者另行安排。
- **未跟版**：上游 `master` 仍是 `c291e796…`，本批没有触发同步流程。
- **未验**：与上游的逐像素一致性；深色一套在浏览器里的实际观感（本仓没有深色切换入口，
  `index.html` 不设 `data-ds-dark-theme`）；`createPortal` 在 SSR/无 `document` 环境下的行为
  （本仓 apps/web 是纯客户端挂载，未触发该路径）；`Menu` 的 `portal` 定位在**真实浏览器**里
  的贴合度（jsdom 无布局，`offsetWidth/offsetHeight` 恒为 0，Q0 只能验到「portal 到 body」
  与「坐标来自 `getAnchorRect`」这一层）。
- **未取**：上游 `scrollbar.css`（Menu 的滚动条重绑因此暂不生效，见 §3.4）；
  `Menu` 的同目录兄弟 `Tooltip`/`HoverCard`（本批不需要）；品牌资产 `FishLogo.tsx` /
  `BrandWordmark.tsx`（红线，永久不取）。

---

## 6. 给「页面迁移」的注意事项（本批实测得出）

| 原语 | 与既有手写控件**不**完全对应之处，迁移时需要的适配 |
|---|---|
| `Input` | `data-testid` 落在 **wrapper span** 上而不是原生 `<input>`；既有单测若按 `getByRole('textbox')` 取控件，要改成 `within(getByTestId(...)).getByRole('textbox')`。高度固定 32px、字号 14px，与原型手写输入框的尺寸不一定一致。 |
| `Menu` | ① **受控**：`open` 由调用方持有，`Menu` 不自己写；原生 `<select>` 的 `value/onChange` 心智要换掉。② `items` 是 `{id,label}` 数组，**没有** `<option>` 的 value 语义，选中靠 `selectedId`/`selectedIds`。③ 祖先有 `overflow` 裁剪时必须开 `portal`，并用 `getAnchorRect` 直接给锚点矩形（否则与宿主布局 effect 竞态）。④ portal 模式下列表在 `document.body`，`within(container)` 找不到。⑤ 键位：Escape 关、`autoFocus` 时才启用方向键导航。 |
| `ConnectionIndicator` | 它不是「在线指示」，而是**断线恢复控件**：三态 `disconnected/connecting/recovered`，`state=undefined` 时**渲染 null**（没有连接反馈就不占位）。迁移时「在线」这个状态应当用别的表达（Tag/StateDot 即可），只有断线/重连/刚恢复才用它。文案 7 个必填 prop 全部由调用方提供（本仓要接 i18n 的话在这里落）。 |
| `Modal` | ① portal 到 `document.body`。② ESC 与 **mask 点击**都触发 `onClose`；mask 是 dialog 的**兄弟节点**。③ `headless` 与 `closeLabel` 在类型上互斥（headless 时不渲染默认头/关闭按钮）。④ 上游**没有**焦点陷阱（没有 focus trap / 初始聚焦 / 滚动锁），做审批弹层时要自己评估是否需要补——这是上游行为，改它属功能性改动，必须在出处头里写明。 |
| `Menu`（#158 落页实测补充） | ⑥ **触发器要调用方自己给**：`Menu` 只画列表，触发器是 `anchor` 里的任意节点，所以样式与 aria（`aria-haspopup`/`aria-expanded`）都归应用层——不在应用层包一层，7 个落页点的键盘与 aria 细节必然各走各的。⑦ `onClose` 不区分关闭原因，选中路径不回焦（G-4，应用层自己补）。⑧ 窄屏注意：`.list` 有 `min-width: 218px`，宿主容器窄于它时列表会横向溢出触发器；祖先有 `overflow` 裁剪时必须开 `portal`（`portal` 在 #158 未接线）。⑨ `id` 归属要自己定：`Menu` 的 wrapper span 与列表都不接 id，`<label htmlFor>` 这类关联要挂在调用方的触发器上。 |
| 通用 | 四个原语都吃 `--dsw-*`，本仓业务 CSS 吃 `--color-*`；需要视觉对齐时在**业务侧**显式桥接（如首批 `global.css` 的 `.device-status-*` 那样），**不要改 vendored 文件**。另外：本批 `ConnectionIndicator` warn/success 面的浅底小字在 AA 上有和首批 Tag 同样的已知问题——**具体数字见 §3.6（warn 2.58:1 / success 2.09:1）**，迁移时若用于正文级文字，按首批做法在包裹元素上做局部重映射。 |

---

## 6.1 页面迁移实测追出的**上游原语缺口**（#158 登记，未改 vendored 文件）

#158 把 7 处原生 `<select>` 迁到 `Menu`（应用层包装 `apps/web/src/shared/SelectMenu.tsx`），
过程中实测到四条属于**上游原语本身**、不能靠应用层包装补上的缺口。按台账纪律登记，
**不**改 vendored 文件；将来跟版或做 L3 时按这里的编号复核上游是否已修。

| # | 缺口 | 实测证据 | 应用层的现状与代价 |
|---|---|---|---|
| G-1 | 选中项**对 AT 不可见**：`.item` 上没有任何 `aria-checked` / `aria-selected`，选中只体现为一个尾随 check 图标（`IconCheckOutline16`） | `Menu.tsx` 渲染项的那段只有 `role="menuitem"` + `aria-haspopup/expanded`（子菜单用），全文件 grep 不到 `aria-selected`/`aria-checked` | 读屏用户拿不到"当前选的是哪个"。选中的**文字**仍渲染在触发器上，所以视觉/键盘用户不受影响。要真修得改 vendored 文件（功能性改动，需出处头标注 + 上游同步保留），本切片不做 |
| G-2 | `role=menu` 用在**选择器**上，语义只兑现一半：菜单语义里"当前值"与"必填"都没有位置（不是 listbox） | `Menu.tsx` 固定 `role="menu"` / `role="menuitem"`；`Menu` 只接受 `selectedId`，不发布选中态 | 这是 ADR-0008 分层取原语的**连带代价**：要 `combobox`/`listbox` 语义就得自己做一层 role 映射，属偏离上游的额外映射，本切片不自行拍板（已写进 `SelectMenu.tsx` 文件头） |
| G-3 | `aria-required` 补不上原生 `required`：ARIA 1.2 的 Used-in-Roles 白名单是 checkbox / combobox / gridcell / listbox / radiogroup / spinbutton / textbox（+tree），**不含 button** | 迁移初版曾无条件挂 `aria-required="true"`，被评审判为"语义不实"（不会播报）→ 已删除 | "必填"只剩应用层的提交守卫：PackSelect 的两个宿主表单、RunLauncher 的 `ready`、ProjectsPage 的空值守卫（#158 评审 B1 补上，此前缺失）。**没有任何读屏侧表达**，属已知缺口 |
| G-4 | 选中路径**不回焦**：`Menu` 只在 `Escape` 且 `autoFocus` 时把焦点还给锚点（`Menu.tsx` 的 keydown 分支），选中/点外面都不管 | jsdom 实测：选中后 `document.activeElement` 是 `<body>`（断言见 `apps/web/tests/select-menu.spec.tsx` 键盘全路径用例） | 应用层在 `SelectMenu` 的 `close` 回调里回焦触发器（ref 由应用层持有，**没有**改 vendored 文件）。不补的话键盘用户每选一个字段都要从文档头重新 Tab |

**跟版检查清单**：上游若修了 G-1/G-4，本仓应用层那两处补丁可以撤；G-2/G-3 是产品决策，
跟版不影响。

---

## 7. 变更记录

| 日期 | 变更 |
|---|---|
| 2026-09-11 | 建档（#138 L2 第二批）。登记 4 个新原语 + `pointer-grace.ts` 的三列哈希（锚点 `e138bbc`）；`icons.tsx`/`index.ts`/`cx.ts` 的本批改动分类；L1 增量变量账（引用 23→37、声明 26→55、深色 17→28）；elevation 段来源更正为 `gradient-shadow-text.css` 并记录 `body, body *` 的结构性决定；`--dsh-*` 例外 2→4 且区分「被读取」与「被赋值」；登记 4 处未验与页面迁移注意事项。 |
| 2026-09-11 | **审查整改（锚点前移到 `a262cd4`）**，四修一补：①elevation 的默认值与派生值**拆回两块**（初版合并到 `body, body *` 是语义错误：重绑元素的后代会拿到默认 l4，已改正并把措辞收紧为「只有派生两项必须挂 `body, body *`」）；②新增 **§3.5 逐字节保真机器门**（manifest 每条登记 sha256/upstreamBlob/upstreamSha256/fidelity + Q0 两条断言；此前无门，变异测试实测旧门全绿）；③删除两个零消费者孤儿变量（`amber-500`、`neutral-bluish-1000`）并新增「无孤儿变量」Q0 用例（声明数 55→**53**）；④新增 **§3.6 AA 数字**（warn 2.58:1 / success 2.09:1）并进 Q0；⑤§3.1 复算命令补 `var(` 锚（原命令得 38、表里 37，37 是对的）。首批 6 个 `.module.css` 的上游 blob 值经独立重算与主台账相符。 |
| 2026-09-11 | 台账回填（`a1b00ae`，纯文档提交）：锚点仍锚在 `a262cd4`——实测 `a1b00ae` 相对它只改了本文件，vendored blob 未动，故三列哈希无需重算。 |
| 2026-09-11 | **新增 §6.1「页面迁移实测追出的上游原语缺口」G-1…G-4**（#158：`aria-selected` 缺失 / `role=menu` 用在选择器上 / `aria-required` 在 button 上无效 / 选中路径不回焦），并在 §6 补 `Menu` 的三条迁移注意事项（触发器归应用层、`onClose` 不辨原因、窄屏 `min-width: 218px`）。本节只登记上游缺口与跟版检查清单，**未改任何 vendored 文件**。 |
| 2026-09-11 | #158 合并 `main`（含 #157 术语切片）后复核：本页只多出上述 §6/§6.1 两处增补，**vendored 子树的 blob 一个未动**（`git diff main..HEAD -- apps/web/src/vendor/` 为空），故 §2 的三列哈希无需重算，锚点仍是 `a262cd4`。 |
