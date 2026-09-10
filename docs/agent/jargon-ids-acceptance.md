# 内部 id 不冒充人名/标签（术语泄漏第二批）验收

- 对应场景/门禁：Q0（组件层判据）+ Q5（p1-07 / p1-19 真浏览器）
- 对应 Issue：#162（切片一 #152/#157 的补漏）；领域语言以 [CONTEXT.md](../../CONTEXT.md) 为准
- 上次验证：2026-09-10 · feat/p1-162-jargon-ids · Q0 PASS；Q5 待跑（见「边界与未覆盖」）

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
- **浏览器层红→绿**（真浏览器里把实现改回 `shortId` 再跑一遍）需占用 e2e 栈，待 Q5 窗口执行；本次已实测的是组件层红→绿（见下）。

## 复跑：红→绿变异

判据的价值在于「改动前会红」。复跑步骤（**不要**在共享工作树上留残留：先备份，跑完立刻还原）：

1. 备份这六个文件：`features/task/{TaskHeader,AssignmentPanel,CommentComposer,RunTimeline,RunLivePanel,ArtifactList}.tsx`；
2. 逐处改回改动前的写法（就是被 #162 修掉的六处）：
   - `TaskHeader`：`directory.personOf(task.assigneeUserId)` → `shortId(task.assigneeUserId)`
   - `AssignmentPanel`：同上
   - `CommentComposer`（`CommentList`）：`directory.personOf(comment.authorUserId)` → `shortId(...)`
   - `RunTimeline`：`{ordinal.get(run.id)}` → `Run {run.id.slice(0, 8)}`；`{RERUN_LINEAGE_LABEL}` → `由 Run {run.rerunOfRunId.slice(0, 8)} 重跑`
   - `RunLivePanel`：`{SELECTED_RUN_LABEL}` → `Run {run.id.slice(0, 8)}`；血缘同上
   - `ArtifactList`：`{runLabels.get(artifact.runId) ?? RUN_NOT_IN_TIMELINE_LABEL}` → `{shortId(artifact.runId)}`
3. `pnpm vitest run --project web apps/web/tests/task-room.spec.tsx` → 应当红，且失败信息里能看到「人名位置出现了 8 位十六进制内部 id「bbbbbbbb」……」；
4. 还原六个文件，重跑同一条命令 → 绿。

变异脚本刻意**不**入库：它会就地改写源码，中断即留下变异态；口径与清单写在这里，够复跑即可。
