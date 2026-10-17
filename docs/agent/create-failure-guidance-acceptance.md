# 创建任务失败引导验收（候选失效：责任人被停用 / Agent 被归档，#348）

- 对应场景/门禁：**Q0**（web project 的 jsdom 两条）+ **Q5**（`p1-312` project 的真页面一条）；
  真页面判据随 `pnpm test:e2e` 全链跑
- 对应 Issue：#348（承接 #345 F2/F9 的提交前阻塞面）
- 判定文件：`apps/web/tests/create-failure-guidance.spec.tsx`（纯函数 1 条 + jsdom 3 条）、
  `apps/web/tests/e2e/task-create-drive.spec.ts` 的「创建被拒（候选失效）」一条
- 上次验证：2026-10-17 · `bd3c9b4` · **PASS**（两条评审已收口；p1-312 四条、`--project web` 585 passed）

## 验的是哪条用户路径

表单开着时责任人被停用（或执行 Agent 被归档），用户在**名册重拉落地之前**点了「创建任务」：
Hub 按规则拒绝（400 `VALIDATION_FAILED`）。此时用户必须看懂「为什么失败、下一步做什么」，
而不是收到一句英文分类消息（`assignee is not an active team member（requestId: req-4m）`）。

## 驱动（怎么触发）

```bash
pnpm exec vitest run --project web apps/web/tests/create-failure-guidance.spec.tsx
pnpm exec playwright test --project=p1-312
```

真页面的时序残窗（重拉未完成的那几毫秒）无法稳定复现，判据用与路径 5a 同式的做法：
拦截创建 POST 的**响应**换成 Hub 的真实拒绝体——到达页面的字节与真实时序一致。

## 观测（看什么）

- 主位（`data-testid="error-guidance"`）：中文引导 + 下一步——「所选责任人已不可用（可能刚被停用）
  ——请重新选择责任人后再创建；不会自动换人。」（Agent 变体同式）；
- 副位（`data-testid="error-diagnostics"`，标「细节（排障用）」）：`VALIDATION_FAILED · <原文>（requestId: …）`
  ——错误码此前只在响应里，页面看不到；
- 之后的提交：按钮禁用 + `selection-unavailable-hint` 可见 + **零新请求**
  （把一次性兜底变成持续的提交前阻塞，不必等名册重拉）；重选后解除。

## 判定（成功长什么样）

1. 纯函数：两类已知消息各给中文引导（含「不会自动换人」）；`CONFLICT`/非 `ApiError`/`null`
   一律返回 null——**不编造原因**（其余失败继续走通用横幅原样展示）。
2. jsdom（三条）：① 400 到达 → 引导与错误码可见、英文原文只在细节行；`posts` 仍为 1；
   提示可见 + 按钮禁用 + 再点零新请求；重选 BOB 后提示消失、按钮恢复可用。
   ② **Agent 变体**（DOM 面）：`assignee agent not found or archived` → 「请重新选择 Agent」
   引导 + 提示走 Agent 支（按被拒字段说人话）。
   ③ **字段作用域**（评审 P1）：Agent 被拒后把「创建后立即执行」关掉 → 阻塞与旧横幅立即撤、
   按钮恢复（该字段已退出请求）。清除是**按字段**的：重选责任人只清 `assignee` 标记；
   改选责任人若不再是「自己」，执行随之关闭、`agent` 标记也一并清（该字段退出请求，
   与关开关同一条语义）——改选自己则不动 `agent` 标记。
3. 真页面（p1-312）：**只拦 POST**（同路径还有 GET 列表）并把响应换成真实拒绝体 → 引导含
   「请重新选择责任人」「不会自动换人」、细节行含错误码与 requestId；判据量在被测面：
   这次创建确实发出且**恰好一次**（拦截计数）；项目任务数不变只作旁证（POST 已被替换，
   Hub 没机会建任务——单纯数不变近似空真，评审 P2 已改口径）。
4. **判据有牙的变异自证**（实测三条）：
   - `createTaskFailureCopy` 恒返回 null ⇒ 纯函数 + 两条表单用例共三条红；
   - `selectionUnavailable` 去掉「被拒字段」项 ⇒ 阻塞那条红（持续阻塞失效）；
   - 开关 onChange 去掉「关掉时清 Agent 标记」⇒ P1 那条红（评审修复的牙齿）。

## 归因（失败先看哪层）

| 现象 | 先看 |
|---|---|
| 用户仍看到英文分类消息 | `ProjectsPage` 是否把 `createTaskFailureCopy(error)` 传给 `ErrorBanner.guidance`；消息原文是否与 Hub 侧一致（Hub 改文案要同步这里） |
| 引导出现但错误码看不到 | `ErrorBanner` 的 guidance 分支（细节行拼装的 code/message/requestId） |
| 拒绝之后还能继续提交 | `rejectedField` 是否在 onError 按字段置位、是否被误清（该字段重选或退出请求才清） |
| 重选后仍被拦 | `clearRejectionFor` 的三个清除点（责任人 onChange、Agent onChange、执行开关关掉）是否都挂了 |

## 边界与未覆盖

- 翻译只覆盖**已知两类**（责任人不活跃 / Agent 已归档，Hub 侧原文在
  `apps/hub/src/modules/task/commands.ts` 的 `requireActiveAssignee` 与 Agent 校验）；
  Hub 改文案会让本判据红（消息匹配不上 → 纯函数返回 null → jsdom 断言「引导存在」失败），
  这是 fail-closed 方向。
- **Agent 侧没有真页面判据**（DOM 面只有 jsdom；「表单开着时 Agent 被归档」的提交前阻塞
  `agentStale` 分支也仍无端到端用例——与 #345 文档 125-126 行的同类声明一致），
  Agent 变体目前靠：纯函数 + jsdom（本文件）+ 服务端兜底。
- **重指派面（`AssignmentPanel`）未翻**（#359）：Hub 的 `reassignAssignment` 会产生同样两条
  分类消息，那个面仍是原样 ErrorBanner（英文分类消息）——单独立账，不当作已修。
- 真页面判据是**响应替换**（真实时序的毫秒窗口不可稳定复现）；正常时序的「提交前阻塞」
  由 #345 的 jsdom + 路径 5b 真浏览器用例覆盖，本文件不重复。
- 语义未变：仍是「显式重选」，**绝不自动换人**（与 #344/#345 一致）。

## 取证

- 可复跑用例本身（Q0 的 web project + Q5 的 p1-312 project）；
- 变异自证的三条结果、p1-312 四条的实测、Q0/Q5/Q9 全量与残留自检记录见本文件「判定」与
  PR #358 的描述；本链路无外部服务，不需要脱敏证据包。

## 复跑

```bash
pnpm exec vitest run --project web apps/web/tests/create-failure-guidance.spec.tsx
pnpm exec playwright test --project=p1-312
```
