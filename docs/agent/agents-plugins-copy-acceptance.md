# Agents 页 / 插件页文案与排版验收（#167，Q5 内文案判据）

- 对应场景/门禁：Q5 浏览器门（`pnpm test:e2e` 的 `p1-142` 项目）；文案判据本体在 Q0
  （`pnpm check` 的 unit project 里跑同一套纯函数）
- 对应 Issue：#167（UI 人话化第二批：Agents 页与插件页）
- 上次验证：2026-09-11 · `feat/p1-167-agents-plugins-copy`（已合并 main `38c6968` / #160）
  · 结果：**Q0 PASS（82 files / 1059 tests）+ Q5 PASS**
  （`--project=p1-142` 3 passed 1.1m；`--project=p1-19` 13 passed 4.3m）

## 验的是哪条用户路径

真人打开 `/agents` 与 `/plugins`，读到的是不是人话：

- `/agents`：页面标题只说一次（不再 h1「Agent 管理」+ h2「Agents」）；字段标签中文优先
  （「人格设定（Persona）」…）；**`Credential Slot` 这种内部概念必须带上「填什么」的解释**；
  宽屏表单不再只占容器左半。
- `/plugins`：标题语言统一（不再 `Plugin Packs`）；`curated` 这类上游目录标识一律换中文标签；
  长标识（Pack ID / 摘要）**只以短码出现在正文**，全值走 `title` 与一键复制。

用户路径 = 「打开页面 → 扫一眼读得懂 → 需要核对摘要时能拿到全值」。

## 驱动（怎么触发）

```bash
# 文案判据的纯函数半边（每次 Q0 都跑，含旧文案必红 / 新文案必绿）
npx vitest run --project unit tests/copy-criteria.spec.ts
# 组件半边（标签、摘要截断、复制行为、两栏归属）
npx vitest run --project web tests/agent-settings.spec.tsx tests/plugin-settings.spec.tsx tests/layout-container.spec.tsx
# 真浏览器半边（Q5，p1-142 项目；与 #159 的对比度扫描同点）
pnpm exec playwright test --project=p1-142
```

判据模块：`apps/web/tests/copy-criteria.ts`（纯函数 + 浏览器侧入口
`expectCopyCriteria`）；挂点在 `apps/web/tests/e2e/pairing-ui.spec.ts` 的
「文案判据：Agents 与插件页…（1280×720 与 390×844 两档）」用例。

**注意（与 #159 的接口）**：#159 的对比度扫描（`tests/e2e/contrast-sweep.ts`）落在
PR #160，合入后两者挂在同一处扫描点（同一个逐页循环、同一套「等内容渲染再判」口径）。
本判据**不** import 那个模块：它只需要 innerText 采集 + 三条断言，独立实现避免跨分支耦合。

## 判定（成功长什么样）

三条判据（位置敏感，不是「页面里不许有英文」；词表与理由见 `copy-criteria.ts`）：

1. **正文不得出现裸的 64 位十六进制**。载体只取 `document.body`/`main` 的 `innerText`
   ——`title` 属性、`display:none`、零尺寸元素里的值都不进 innerText，所以
   「截断显示 + 全值走 title + 一键复制」是**可判定**的：正文只剩 `4d1be1bbe093…`。
2. **正文不得命中"裸的"内部词**（`curated` / `unreviewed` / `local-development`）。
   领域词（`Agent` / `Run` / `Artifact` / `Plugin Pack` / `Profile Revision`）**不在**
   表里，保留英文不算泄漏，单测里有反例钉住这一点。
   「裸」的判据 = 这个词在屏上**有没有中文兜着**：`local-development（本地开发）` 与
   `精选（curated）包` 是 CONTEXT.md 认可的「中文（English）」对照标签，放过；
   `curated 目录暂无插件。` 这种没有中文解释的**才算命中**。这条口径两个方向各被实测
   撞过一次（见「发现」）。
3. **同一屏不得有两个同义标题**：`h1` 与紧随其后的 `h2/h3` 相同或互相包含即失败。
4. 顺带：390×844 无横向溢出（复用 #152 既有判据，两页此前没进过那个循环）。

另有纯函数级"门不是空的"证据（`copy-criteria.spec.ts`，8 例）：

- 旧文案（改动前逐字原文）**必须变红**：裸摘要、`curated`、同义标题三类各一条；
- 新文案**必须全绿**；短摘要形态 `4d1be1bbe093…` 与 63/65 位十六进制不得误报；
- 词表每条必须写明「为什么它在表里」（理由里要出现"枚举/标识/目录/状态"这类判断依据）；
- 失败信息必须能定位：元素/文本/期望三件都在。

## 红→绿实测（本次要求，逐条给实测输出）

**红**（把源码文案临时改回 #167 之前的措辞，用真浏览器跑同一份判据；
方法：临时改回旧文案 → 真 Chrome 载入 `/agents`、`/plugins`）：

```text
agents-1280x720: copyCriteria=FAIL #167 文案判据未通过（1 项）：
  1. [同义标题重复] /agents @ 1280×720 h1「Agents」与其后的 h2「Agents」
     实测文本：Agents / Agents
     期望：同一屏只留一个标题：页面标题放 h1，紧随其后的区块标题要么删掉、要么换成不重复的内容
plugins-1280x720: copyCriteria=FAIL #167 文案判据未通过（2 项）：
  1. [裸 64 位摘要进正文] /plugins @ 1280×720 页面可见文本
     实测文本：4d1be1bbe0933b9c2bd0e7f6b0e3aa1a4a0f8a1c8e6b7f5d3c2b1a09f8e7d6c5
     期望：摘要只以短码出现在正文（如 4d1be1bbe093…），全值放 title 并提供一键复制；被命中的这段是 64 位十六进制整串
  2. [内部词表命中] /plugins @ 1280×720 页面可见文本
     实测文本：curated 目录暂无插件。
     期望：「curated」是内部标识，页面必须用中文（需要对照时可写「中文（curated）」）
```

**绿**（改回本次实现后，同一条命令、同一个浏览器）：四档全部
`copyCriteria=PASS`（`agents`/`plugins` × 1280×720/390×844）。

三条规则都在真浏览器里红过一次，不是「只证明现在是绿的」。内部词表那条另外复测过一次
**空目录形态**（打桩空目录 + 旧文案「curated 目录暂无插件。」）：同样
`[内部词表命中] … 实测文本：curated 目录暂无插件。`——空态这种"只有某一种数据形态才
渲染"的地方，判据也在真浏览器里红过。

## 截图自审（两页两档）

拍摄条件（**截图产物不入库**，按 issue 要求只登记结论与条件）：

- 本机 Chrome（`channel: chrome`），页面来自本 worktree 的 `vite` dev server（端口 5199，
  未占用 e2e 的 5173/18080 栈）；
- `/api/v1` 全部打桩（形状取自 `apps/web/tests/fixtures.ts`：1 个 Agent + 1 个 curated
  安装 + 1 个含 1 个成员的 Pack + 1 条目录项），因此**不依赖 Hub/PG/node**；
- 每页两档：**1280×720** 与 **390×844**（`page.screenshot({ fullPage: true })`）。

结论：

| 档 | `/agents` | `/plugins` |
|---|---|---|
| 1280×720 | `scrollWidth=1280/1280`；两栏 `gridCols=[688, 368]`；标题序列 `H1:Agents → H3:新建 Agent（表单）→ H2:Revision 是什么 → H3:Builder（详情）` | `scrollWidth=1280/1280`；标题序列 `H1:插件管理 → H2:插件目录 → H2:已安装插件 → H2:插件组合（Pack）→ H3:新建插件组合` |
| 390×844 | `scrollWidth=390/390`（无横向溢出）；单列顺序 `Agents → 列表 → 说明卡 → 新建表单 → 详情`；标签与解释在 390px 下逐行换行、无截断 | `scrollWidth=390/390`；`插件组合摘要（Pack Digest）` 标签换两行、短码 `4d1be1bbe093…` 与「复制」同排；正文无 64 位整串 |

逐条结论：

- **重复标题**：删掉的是 `AgentList` 的 `<h2>Agents</h2>`，页面标题保留 h1「Agents」
  （与主导航同一套词）。截图里 h1 之后紧跟的是表单 h3 与侧列说明 h2，两种形态都不再重复。
- **标签中文化**：表单与详情 6 个标签统一「中文（English）」；`凭据槽（Credential Slot）`
  下面那句解释在 1280 与 390 两档都完整可读（3 行 / 5 行，无截断）。
- **排版**：1280 下表单与详情进了 23rem 侧列（368px），列表与说明留在 688px 主列；
  左列在只有 1 个 Agent 时下方留白，属小团队正常形态（收口前的留白是**右半屏固定空**，
  与内容多少无关）。曾试过把表单放主列：两处 `.field-row` 各摊到 ~330px，右侧空出大片，
  截图比对后定为侧列（理由写进 `global.css` 的注释）。
- **`curated`**：空态写成「精选目录暂无插件：这里只列上游精选过的插件，团队自建的
  本地包不经此入口。」——纯中文，不带原词；信任级别徽标写「精选」（`formatTrust`）。
  为什么不用「精选目录（curated）」：那一版实测**命中了本切片自己的词表判据**
  （括号恰好包住 term、括号前是中文时，机器分不清它是标签还是散文），于是改成
  不写这种散文；需要保留原词的地方一律用 `中文（term）` 的紧邻形态（`精选（curated）包`
  那样，括号前的中文就是这个词的解释）。
- **长标识**：Pack ID 短码 `dddddddd`、摘要短码 `4d1be1bbe093…`，两者各带「复制」；
  原来那行「完整 Digest + 64 位整串」已删除（正文不再出现整串，全值在 `title` 里）。

## 实现过程中被自己的门抓到的两次（登记）

1. **空态写了「（curated）」被词表判据命中**（截图自审阶段）：第一版空态是
   「精选目录（curated）暂无插件」，e2e 判据**没红**——因为 p1-142 的团队里目录不为空，
   空态根本没渲染；是打桩截图时看见的。处置：① 空态改成纯中文；② 判据搬到组件层
   （`plugin-settings.spec.tsx` 的可见文本词表用例），让**每一种可渲染形态**都在 Q0
   里被扫，不再只扫 e2e 恰好走到的那个。
2. **`local-development（本地开发）` 反过来被判成泄漏**：加组件层词表检查后，
   插件页本来就有（#167 之前就有）的审核徽标当场变红。处置：词表判据从「出现即命中」
   改成「裸词才命中」，规则与理由写在 `findInternalTerms` 上方；两种形态都进单测。

这两次都是"门自己发现的"，也是本次把判据拆成纯函数 + 组件层 + 浏览器层三处的原因。

## 归因（失败先看哪层）

- 判据报「裸 64 位摘要」→ 看失败信息里的**实测文本**是哪个卡片的哪一行：
  组件没截断（`shortDigest` 未用）还是有人把全值渲染进了正文。
- 判据报「内部词表命中」→ 文案里出现了 `INTERNAL_TERMS` 里的词；要么换中文标签，
  要么（确实需要对照时）在 `copy-criteria.ts` 里显式登记为可接受形态并写明理由。
- 判据报「同义标题重复」→ 看 `h1` 与紧随其后的那个标题；页面标题与区块标题只能留一个。
- 页面根本没渲染（扫到空态）→ 判据是「等内容渲染再判」的，若空态本身没渲染，
  先看 `e2e-serve` 的 vite/Hub 日志尾。注意本判据用例在无会话时会**记一条
  `skip-scope` 注解并跳过该页**（单 Hub 只容一个团队，Setup 可能已被同一 project 的
  另一个用例占用），跳过会出现在测试报告里，不是静默放行。

## 取证

```bash
pnpm check                                                # Q0：Format/Lint/型别/边界/协议/插件 fixture/unit+web
bash scripts/secret-scan.sh apps/web scripts docs/agent   # Q7 片段
```

红→绿实测与截图自审都是**本机临时产物**（`/tmp`，不入库）：截图 `fullPage` PNG +
一份 `report.txt`（每档的 scrollWidth / 列宽 / 标题序列 / 判据结果 / 页面可见文本）。
要复现，按「截图自审」小节的拍摄条件重建打桩脚本即可（判据本体已在仓库里，
不依赖那份临时脚本）。

## 边界与未覆盖

- **Q5 尚未在空栈上实跑**：`p1-142` 的 390×844 循环与新增文案用例都要真栈
  （`scripts/e2e-serve.mts` 占 5173/18080，同一时刻全机一套）。本次交付时该栈被
  其它 agent 占用，故 Q5 由父 agent 放行后补跑；本文件届时更新「上次验证」。
- **#159 的对比度扫描未并跑**：它落在 PR #160（未合入）。合入后本判据与它同点并排，
  本分支届时 rebase 一次。
- **空团队形态下的真栈覆盖有限**：`p1-142` 的团队里通常没有 Agent / Pack，
  因此判据在真栈上主要覆盖空态与表单；**有数据形态**（Pack 卡的短码 + 复制按钮、
  详情里的字段标签）由组件测试覆盖（`plugin-settings.spec.tsx` 的
  「摘要只给短码，全值走 title 与一键复制」与 `agent-settings.spec.tsx` 的标签用例），
  以及本次截图自审（打桩）覆盖。真栈上有数据形态的建议补法是 `/plugins` 用例里走
  HTTP 旁路装一个 curated 包（本切片未做，登记在此）。
- **判据抓不到的类别**（已写进 `copy-criteria.ts` 顶部）：
  `aria-label` / `title` / `placeholder` 不进 innerText 因而不判；只查显式词表，
  新造的内部词不会自动被抓；中英两套说法且互不包含的标题对（如 `Agent 管理` 与
  `Agents`）字符串上无从判定，靠人看。
- **`PluginSettings` 目录卡的 Integrity / 依赖闭包 Digest 没有复制按钮**：它们已经是
  「短摘要 + title 全值」形态（#167 之前就是），本次只按 issue 范围处理
  `PluginPackEditor` 的 Pack ID / Pack Digest / 完整 Digest 三条。是否给目录卡也加
  复制入口属新范围，未做。

## 复跑（本次实测输出）

```bash
corepack enable && pnpm install --frozen-lockfile && pnpm -r --if-present build
pnpm check                                                 # Q0：82 files / 1059 tests 全绿
pnpm exec playwright test --project=p1-142                 # Q5：3 passed (1.1m)
#   ✓ 生成配对码 → 真 node CLI 消费 → 页面不刷新出现该设备 (5.1s)
#   ✓ 文案判据：Agents 与插件页无裸摘要 / 无内部词 / 无同义标题（1280×720 与 390×844 两档）(4.5s)
#   ✓ 390×844：无横向溢出、顶栏单行 ≤64px、折叠菜单键盘可达 (15.3s)
pnpm exec playwright test --project=p1-19                  # 改过 /agents 断言的 spec：13 passed (4.3m)
#   （G5/G5-04/G6-04/G6-07/G4-04 + R1/R4/R5/R7/R8/R9 + G7-01/G7-04 全绿）
bash scripts/secret-scan.sh apps/web scripts docs/agent     # Q7 片段：OK
```

两个 project 各一次冷启，跑完确认 5173/18080 已释放、无残留 `project311.e2e-postgres` 容器。
