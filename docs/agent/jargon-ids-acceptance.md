# 内部 id 不冒充人名/标签（术语泄漏第二批）验收

- 对应场景/门禁：Q0（组件层判据）+ Q5（p1-07 / p1-19 真浏览器）
- 对应 Issue：#162（切片一 #152/#157 的补漏）；领域语言以 [CONTEXT.md](../../CONTEXT.md) 为准
- 上次验证：2026-09-10 · feat/p1-162-jargon-ids · Q0 PASS · Q5 PASS（p1-07 1 passed / p1-19 13 passed / 浏览器层红→绿各一次）

## 验的是哪条用户路径

真人在 Task Room 里看「这是谁的任务、谁在等、谁说了这句」，以及在 Run 时间线/直播面板/交付物里看「这是哪一次运行」：

- 顶部「当前责任人」、左侧「此任务分配给 X，等待其接受。」、留言作者 —— 必须是**人**的显示名；
- 时间线行、直播面板标题、重跑血缘、交付物「来源运行」—— 必须是**人话句柄**，不是 `shortId()` 的半截 UUID。

区别于「哪个函数返回什么」：判据取的是这些元素**渲染出来的可见文本**。

## 驱动（怎么触发）

```bash
# 真浏览器（Q5；同一时刻全机只允许一套 e2e 栈，两个 project 分开冷启）
pnpm exec playwright test --project=p1-07
pnpm exec playwright test --project=p1-19

# 组件层（在 Q0 内，随 pnpm check 跑；无需起栈）
pnpm vitest run --project web apps/web/tests/task-room.spec.tsx
pnpm vitest run --project unit apps/web/tests/person-identity.spec.ts
```

## 观测（看什么）

| 观测点 | 取什么 |
|---|---|
| `[data-testid="task-assignee"]` | 顶部责任人格的可见文本 |
| `[data-testid="assignment-assignee-note"]` | 分配说明整句（人名在句子里） |
| `[data-testid="comment-author"]` | 每条留言的作者格 |
| `.run-item-button[data-run-id] .run-label` | 时间线行标签；完整 runId 在 `title` |
| `run-live-panel h3` | 「本次运行」；完整 runId 在 `title` |
| `run-lineage`（两处） | 血缘句；来源 runId 在 `title` |
| `.artifact-item dd[title=<runId>]` | 交付物「来源运行」格 |

期望值来源：**真实名册** `GET /team/members`（e2e 经 `hubApi` 取，与页面同一数据源），不把姓名写死在测试里。

## 判定（成功长什么样）

判据内核：`apps/web/tests/person-identity.ts`（纯函数；e2e 用 locator 取 `innerText`，组件测试用 jsdom 取 `textContent`，**共用一份判定**，避免两处口径分叉）。

1. 每个指人槽位的可见文本必须包含：名录里某个成员的写法（显示名 / `@用户名` / 裸用户名）、兜底文案（「未知成员」「已离开的成员」）或视角词「你」；
2. 摘掉上述所有可接受写法后，**不得残留 8 位十六进制裸 token**（`shortId()` 的形状）；
3. 槽位**无匹配元素即 FAIL**——选择器失效或该区没渲染时判据不得静默通过（六原语·判定：缺一环必须失败）；
4. 失败信息必须自带定位：槽位描述 + 选择器 + 第几个元素 + 实测文本 + 期望什么；
5. Run/Artifact 面：正文是「第 N 次运行 / 本次运行 / 重跑自来源运行 / 来源运行」，短 id 不出现在正文（`title` 里保留完整 id）。

**为什么不是「页面里不许出现 8 位十六进制」**：Task Room 里合法长成这个形状的东西不止一种——e2e 自己的用户名就带 8 位随机 tag（`Bob（@bob-1a2b3c4d）`）、git sha、内容摘要前缀同理。一刀切会假红，假红的判据很快会被静音掉，等于没有判据。所以口径是**位置敏感**的：只在明确指人的槽位里问「这个人是谁」。

## 归因（失败先看哪层）

| 现象 | 先看 |
|---|---|
| 指人槽位红（出现 id） | 该组件是否接 `useMemberDirectory().personOf`（`features/team/memberDirectory.ts`） |
| 指人槽位红（说「未知成员」而非人名） | 名册请求是否真发出/真回来了（`queryKeys.teamMembers`，`GET /team/members`） |
| 指人槽位红（说「已离开的成员」） | 该 userId 是否真不在 `team_members` 里（名册含已停用成员，停用不会命中外这条分支） |
| Run 措辞红 | `features/task/runLabels.ts` 的措辞常量与 `runOrdinalLabels` |
| 假红（用户名/摘要被当成 id） | 判据的可接受写法集合是否漏了 `username` 写法 |

## 取证

- 组件层：`pnpm vitest run --project web apps/web/tests/task-room.spec.tsx` 的失败输出（自带槽位描述与实测文本）；
- 浏览器层：e2e 失败时 `artifacts/evidence/e2e/<attempt>/`（P1-18 机制，绝对路径已归约）；
- 提交前：`scripts/secret-scan.sh`。

## 边界与未覆盖

- **Agents / 插件页**的 `shortId(agent.id)`、`shortId(pack.id)` 未动：#162 明确不在本次范围（`Agent` 是领域词，另行判断）；
- `ArtifactList.safeFileName` 里的 `artifact-<shortId>` 是**下载文件名**兜底，不上屏，未纳入判据；
- 判据覆盖 Task Room 的三个指人槽位；项目页/项目任务列表由 #152 的负向断言（不含截断 UUID）覆盖，未合并进本内核；
- 手机档 390×844 下 Run 区在首屏之外（需滚动），这是既有布局（#138/#154 范围），非本判据口径问题。

## 实测记录

### Q5（真浏览器，2026-09-10 · feat/p1-162-jargon-ids）

| 项目 | 命令 | 结果 |
|---|---|---|
| p1-07 | `pnpm exec playwright test --project=p1-07` | **1 passed**（18.6s / 单次 41.1s 含冷启栈） |
| p1-19 | `pnpm exec playwright test --project=p1-19` | **13 passed**（3.9m） |
| 浏览器层红 | 见下方「造红」命令（TaskHeader 责任人改回 `shortId`） | **1 failed**，判据诊断指名槽位与短 id（实测 `01a08c70`） |
| 浏览器层绿 | 还原后同一条命令 | **1 passed** |

浏览器层红灯的原文（`01a08c70` 是 `shortId(bobUserId)`，8 位无连字符——正是旧判据放行的形状）：

```
Error: #162 Task Room 首屏（Alice 视角）：人名位置出现内部 id 或说不出「是谁」
Received: ["顶部「当前责任人」的值（[data-testid="task-assignee"] 第 1 个）：人名位置出现了
8 位十六进制内部 id「01a08c70」（可见文本「01a08c70」）：期望成员显示名
（如 Alice（@alice-e4ba0946））或兜底文案（未知成员、已离开的成员），短 id 不得当名字用"]
```

同一份 DOM 上，未被变异的「任务分配说明」槽位（`此任务分配给 Bob（@bob-e4ba0946），等待其接受。`）
判绿——判据是逐槽位的，报的就是真出问题的那一格。

### 截图自审（2026-09-10，临时 shot spec，产物在 `/tmp/p162-shots/`，**不入库**）

拍摄条件：e2e 真栈（`scripts/e2e-serve.mts`）+ 真 Node/Runtime；Task Room 空态（新建、无留言无 Run 无交付物）与满态（已接受 + 留言 + 2 次 Run + 已发布交付物），Run 实况面板与时间线取 owner 视角；桌面 1280×720、手机 390×844 各一张，共 6 张。

看出的结论：

- 三个指人位置都写「显示名（@用户名）」：`当前责任人 Bob（@bob-ecc14fdb）`、`此任务分配给 Bob（@bob-ecc14fdb），等待其接受。`、留言作者 `Bob（@bob-ecc14fdb）`；旧版这三处分别是 `01a08c70` 形态的短 id；
- Run 面：时间线行 `第 1 次运行` / `第 2 次运行`，血缘行 `重跑自来源运行`，面板标题 `本次运行`；交付物 `来源运行 第 1 次运行`（与时间线行同款句柄，可对照）；
- 空态四区都给人话空态（`还没有留言 ——…` / `还没有 Run。…` / `还没有已发布的 Artifact。…`），没有把空白伪装成结论；
- 两档布局均正常（手机档单列堆叠，无溢出/截断）；
- **一处在截图上「看起来像泄漏」但其实合法**：用户名自带 8 位随机 tag（`bob-ecc14fdb`）——这正是判据不能写成「页面里不许出现 8 位十六进制」的原因；登记在此，免得后来者按截图误判。

截图看不到的面（已由机器断言覆盖，不靠肉眼）：`title` 上的完整 runId（悬停才可见，p1-19 断言属性）、`data-run-id`（DOM 属性）。

## 复跑：造红 / 回绿

判据的价值在于「改动前会红」。**造红**（一行命令，trap 保证异常退出也会还原，不留残留）：

```bash
cd <worktree>
cp apps/web/src/features/task/TaskHeader.tsx /tmp/TaskHeader.keep
trap 'cp /tmp/TaskHeader.keep apps/web/src/features/task/TaskHeader.tsx' EXIT
perl -0pi -e "s/import \{ ASSIGNMENT_STATUS_LABEL, TASK_STATUS_LABEL \}/import { ASSIGNMENT_STATUS_LABEL, shortId, TASK_STATUS_LABEL }/; s/directory\.personOf\(task\.assigneeUserId\)/shortId(task.assigneeUserId)/" apps/web/src/features/task/TaskHeader.tsx
pnpm exec playwright test --project=p1-07   # 期望：1 failed，诊断指名 [data-testid="task-assignee"] 与短 id
```

**回绿**：去掉变异（或让 trap 还原）后跑同一条命令 → `1 passed`。组件层的同一组红→绿（六处实现全改回短 id）：

```bash
pnpm vitest run --project web apps/web/tests/task-room.spec.tsx   # 红：5 failed；还原后：15 passed
pnpm vitest run --project unit apps/web/tests/person-identity.spec.ts  # 判据内核自身的旧文本→红基线
```

六处变异清单（组件层红态用）：`TaskHeader`/`AssignmentPanel`/`CommentList` 的 `personOf(...)` → `shortId(...)`；
`RunTimeline` 的 `{ordinal.get(run.id)}` → `Run {run.id.slice(0, 8)}`、`{RERUN_LINEAGE_LABEL}` → `由 Run {...slice(0, 8)} 重跑`；
`RunLivePanel` 的 `{SELECTED_RUN_LABEL}`/`{RERUN_LINEAGE_LABEL}` 同上；`ArtifactList` 的 `{runLabels.get(...) ?? ...}` → `{shortId(artifact.runId)}`。

变异脚本刻意**不**入库：它会就地改写源码，中断即留下变异态；上面的命令自带 `trap` 还原，够复跑即可。
