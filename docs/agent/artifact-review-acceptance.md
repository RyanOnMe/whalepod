# 交付物批注与审阅邀请（#429 / ADR-0021 §2-4）验收记录

- 对应场景/门禁：交付物审阅闭环前半 + Q0/Q1/Q2；页面行为由 Web 组件用例承载
- 对应 Issue：P1-429
- 上次验证：2026-10-23 · feat/p1-429-artifact-review · PASS

## 验的是哪条用户路径

团队成员从已发布交付物进入审阅页 → 在正文里选中一段文字发表原位批注（或直接对整件
文件评论）→ 回复他人批注 → 责任人/拥有者邀请同事并写「请重点看什么」→ 被邀请人从
首页待办直达该版本 → 发表意见后提交本轮意见，或选择「本轮无意见」。打开页面不算
提交；批注不启动 Agent、不改变任务状态。

## 驱动（怎么触发）

```bash
# Hub：真实发布→批注/邀请/提交命令 + 待办 SQL（真实 PostgreSQL）
pnpm exec tsx scripts/with-test-postgres.mts vitest run --project integration \
  apps/hub/tests/artifact-review.integration.spec.ts

# 协议：锚点定位纯函数（重复文字/过期偏移/无上下文）
pnpm exec vitest run --project unit packages/protocol/tests/review-anchor.spec.ts

# Web：审阅页与首页待办导航
pnpm exec vitest run --project web \
  apps/web/tests/artifact-review.spec.tsx apps/web/tests/attention-home.spec.tsx
```

## 观测（看什么）

- `artifact_comment`：`artifact_id` 固定版本、`kind/anchor` 成对、回复只有一层。
- 创建 text 批注的服务端定位结果：偏移命中或唯一重定位；否则 400
  `ANCHOR_NOT_FOUND`，非文本/超 512 KiB 为 400 `ANCHOR_UNSUPPORTED`。
- `artifact_review_invitation`：`(artifact_id, reviewer_user_id)` 唯一；pending→submitted
  带提交时刻；重复邀请返回同一条。
- 待办：`submit_review` 的 `objectId` 是 artifactId、`runId=null`；提交后消失。
- Web 请求体：原位批注带 `{quote,prefix,suffix,start,end}`；整件批注不带 anchor；
  提交意见带 `{noComment}`；邀请带 `{reviewerUserIds,focus}`。

## 判定（成功长什么样）

- 未发布候选对非拥有者读面/批注一律 404；非责任人/非拥有者邀请 403。
- 重复文字无上下文时明确失败，不猜位置；有上下文时即使偏移过期也能唯一定位。
- 没有意见且选择「提交本轮意见」返回 400 `NO_COMMENTS`；「本轮无意见」成功。
- 待办点击只导航到独立审阅页，不发 POST；提交后待办消失。
- 以上任一断言缺数据或形状不符即 FAIL（Zod strict + 集成断言）。

## 归因（失败先看哪层）

- 锚点失败：先看 `packages/protocol/src/review.ts` 的定位函数（Web/服务端共用），
  再看 `apps/hub/src/modules/review/review.ts` 的版本读取与预算判定。
- 权限失败：`requireReadableArtifact`（候选折叠为 404）与邀请的 Task 责任人判定。
- 待办不出现：`apps/hub/src/modules/task/attention.ts` 的 `submit_review` SQL 与
  `artifact_review_invitation.status`；Web 侧看 `PersonalAttention` 的 kind→路由。

## 取证

```bash
git diff --stat feat/p1-429-artifact-review
# 上方三条命令复跑；03 文档 §2.6/§4 与 ADR-0021 已同步
```

## 边界与未覆盖

- 本轮只有文本/整件批注；PDF/图片区域与 Office 预览在 #431。
- 「已解决/仍需修改」「本轮待复核」筛选的解决记录要等 #430 的修订批次；当前
  「未解决」显示全部批注、「本轮待复核」为空并明确说明。
- 原位批注只接受 ≤512 KiB 的可读文本；更大的文本与非文本一律整件批注（明确失败码）。
- 邀请只决定待办归属，不改变文件可见性；首版不做邮件/站外提醒。
- 生产装配 Q5 本轮未重跑；新增行为由 Hub 集成 + Web 组件判据覆盖。

## 复跑

从干净数据库执行上方命令；Hub 用例由 `with-test-postgres.mts` 自起临时 PostgreSQL，
Web/协议用例不需要 Docker。
