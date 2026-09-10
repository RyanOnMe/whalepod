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
| **锚点 commit** | `e138bbcb809d8f9442b021277bf0a69ded0d978d`（本切片唯一提交） |
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
| `apps/web/src/vendor/dsh-ui/manifest.json` | `7d4fbd233685ed69206fe00abf29c7e648130529` | 11226 | `components[]` 15 → **24**、`meta[]` 3（不变）、`scope.layers`/`excluded`/`tokens` 同步 | 本仓新增（机器可读台账自身） |

> 上表 5 个 blob 全部实测于锚点 `e138bbc`（`git rev-parse e138bbc:<path>`）。其中
> `cx.ts` 是**本仓新增代码**、`README.md`/`manifest.json` 是元文件，它们与上游**没有**
> 「剥头后比对」这回事（前者不是上游代码，后两者上游无对应物）。

**本批新增但未入 vendored 目录的产物（记在此供主台账对齐）**：

| 本仓文件 | 本仓 blob@`e138bbc` | 本仓字节 | 上游关系 |
|---|---|---|---|
| `apps/web/src/styles/dsw-tokens.css` | `a70de06c5322b7d0b1d25e0b1119b7dccbaa48b3` | 14154 | 上游 `design-platform.css`（`bc4712b2…`，19109 B）+ `gradient-shadow-text.css`（`36fee494…`，14722 B）的**派生白名单**，非逐字节复制 |
| `apps/web/tests/vendor-dsh-ui.spec.tsx` | `96d0e50944b3cc61995d6eced51c5897a9456fd4` | 51875 | 本仓新增（Q0 单测），上游无对应物 |
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
| vendored CSS **引用**的 `--dsw-*` | 23 | **14** | **37** | `grep -hoE '\-\-dsw-[a-z0-9-]+' apps/web/src/vendor/dsh-ui/*.module.css \| sort -u \| wc -l` |
| `dsw-tokens.css` **声明**的 `--dsw-*` | 26 | **29** | **55** | `grep -oE '^\s*--dsw-[a-z0-9-]+' apps/web/src/styles/dsw-tokens.css \| sed 's/^ *//' \| sort -u \| wc -l` |
| 其中深色段**重写**的 | 17 | **11** | **28** | 见 §3.3 |

- **新引用的 14 个**（逐个 grep 本批 4 个 `.module.css` 得到）：
  `--dsw-alias-bg-layer-1`、`--dsw-alias-bg-mask-1`、`--dsw-alias-border-l1`、
  `--dsw-alias-border-l2`、`--dsw-alias-interactive-bg-hover-danger`、
  `--dsw-alias-label-dimmed`、`--dsw-alias-scrollbar-bg-l2`、`--dsw-alias-scrollbar-hover-l2`、
  `--dsw-alias-state-success-tertiary`、`--dsw-alias-state-warn-label`、
  `--dsw-alias-state-warn-tertiary`、`--dsw-specific-menu`、
  `--dsw-elevation-prominent`、`--dsw-mask-blur`。
- **新声明 29 条 = 上列 14 个 + 15 个传递依赖**。15 个传递依赖 = **13 个 `--dsw-static-*`**
  （`neutral-bluish-00/200/750/875/1000`、`neutral-200/300/550/600`、`green-100`、
  `amber-100/500/600`）+ **2 个 elevation 派生值**（`--dsw-elevation-stroke`、
  `--dsw-elevation-stroke-color`，是 `--dsw-elevation-prominent` 的传递依赖，见 §3.2）。
  13 个静态档里有 12 个被本批新 alias 消费；`amber-500` 是被**首批已声明**的
  `--dsw-alias-state-warn-primary` 消费的（首批把它就地展开成了 `rgb(245, 158, 11)` 字面量、
  没有留 alias，所以那个档位当时没进白名单）——本批把它补进来是为了让「同一档只声明一次」，
  且它同时是本批 `ConnectionIndicator.module.css` 的 `color-mix` 输入之一。
- **关键正确性属性（实测）**：两批并集的 37 个引用变量**全部**在 `dsw-tokens.css` 里有声明
  ——差集为空，即**没有未解析引用**，不会静默落到 CSS fallback。Q0 单测已把这 37 这个数钉死。

### 3.2 本批唯一的结构性决定：elevation 段挂在 `body, body *`

`--dsw-elevation-prominent` / `--dsw-elevation-stroke` / `--dsw-elevation-stroke-color` /
`--dsw-mask-blur` 取自上游 **`packages/client/ui-theme/src/styles/gradient-shadow-text.css` 的
`body` 段**（不是 `design-platform.css`——本批实测确认这四个变量不在 design-platform.css 里，
主台账 §3.1 把 L1 来源只记了 design-platform.css，**本条是主台账需要补的一句**）。

上游把派生值声明在 `body, body *` 上而不是 `body` 一处，注释里写明了原因：继承下来的是在
祖先处**已代入完**的值，后代重绑 `--dsw-elevation-stroke-color` 就进不到
`var(--dsw-elevation-*)` 里。**Menu.module.css 正是那个重绑方**（把描边色重绑到
`--dsw-alias-border-l1`），所以本仓必须照抄同形选择器，否则菜单会丢掉 0.5px 发丝描边。
本仓把这一整段放在 `:root` **之外**、并有一条 Q0 单测断言它**不在** `:root` 里
（挂两处会让 `body *` 那层变成唯一生效层，语义就糊了）。

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

---

## 4. 复算命令（照抄主台账 §3.4 的形状）

```console
SHA=c291e7961a515f6d7af9304e7fd1d257929aef26   # 上游钉住 commit（本批未跟版）
C=e138bbcb809d8f9442b021277bf0a69ded0d978d     # 本批锚点 commit

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

## 4.1 一次额外的实测：本批原语**没有**进产物包（additive vendoring 的直接后果）

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
| 通用 | 四个原语都吃 `--dsw-*`，本仓业务 CSS 吃 `--color-*`；需要视觉对齐时在**业务侧**显式桥接（如首批 `global.css` 的 `.device-status-*` 那样），**不要改 vendored 文件**。另外：本批 warn/success 面的浅底小字在 AA 上有和首批 Tag 同样的已知问题（上游浅色档取值使然），迁移时若用于正文级文字，按首批做法在包裹元素上做局部重映射。 |

---

## 变更记录

| 日期 | 变更 |
|---|---|
| 2026-09-11 | 建档（#138 L2 第二批）。登记 4 个新原语 + `pointer-grace.ts` 的三列哈希（锚点 `e138bbc`）；`icons.tsx`/`index.ts`/`cx.ts` 的本批改动分类；L1 增量变量账（引用 23→37、声明 26→55、深色 17→28）；elevation 段来源更正为 `gradient-shadow-text.css` 并记录 `body, body *` 的结构性决定；`--dsh-*` 例外 2→4 且区分「被读取」与「被赋值」；登记 4 处未验与页面迁移注意事项。 |
