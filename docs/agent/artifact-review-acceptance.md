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
# Hub：已发布 Artifact 的声明式前置（真实上传/发布由既有 Q5 覆盖）+
#      批注/邀请/提交命令 + 待办 SQL（真实 PostgreSQL）
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
  带提交时刻；`no_comment` 区分「本轮无意见」与「已提交意见」，重复邀请返回同一条。
- 待办：`submit_review` 的 `objectId` 是 artifactId、`runId=null`；提交后消失。
- Web 请求体：原位批注带 `{quote,prefix,suffix,start,end}`；整件批注不带 anchor；
  提交意见带 `{noComment}`；邀请带 `{reviewerUserIds,focus}`。

## 判定（成功长什么样）

- 未发布候选对非拥有者读面/批注一律 404；非责任人/非拥有者邀请 403。
- 重复文字无上下文时明确失败，不猜位置；有上下文时即使偏移过期也能唯一定位。
- 没有意见且选择「提交本轮意见」返回 400 `NO_COMMENTS`；「本轮无意见」成功。
- 已「本轮无意见」后再追加批注：邀请回到待提交、`noComment=false`，待办重新出现。
- 同一 Idempotency-Key 重放批注/邀请/提交返回首次结果（不因日期已序列化而 500）。
- 带 UTF-8 BOM 的文本在服务端与浏览器同口径去 BOM，偏移不多 1。
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
- 「无意见」与「追加批注」用同一把邀请行锁串行化；未做高并发压测。
- 审阅页的 taskId/artifactId 归属校验是**展示层守卫**（Hub 读面按 Artifact 权限鉴权，
  不额外接受 taskId）；错误链接明确报错并给正确入口。
- 集成用例的 Artifact 行按 #99 注记的**声明式前置**直插（真实 Node 上传/owner 发布由
  既有 Q5 与 handoff 闭环覆盖）；删除条件：Hub 提供按 Run 登记材料的 fixture 通道。
- 生产装配 Q5 本轮未重跑；新增行为由 Hub 集成 + Web 组件判据覆盖。

## 复跑

从干净数据库执行上方命令；Hub 用例由 `with-test-postgres.mts` 自起临时 PostgreSQL，
Web/协议用例不需要 Docker。

## 2026-10-26 合入前回归收口

- 先红后绿：候选 owner 私有批注不得写团队 `artifact.changed`（发布后正控仍须产生事件）；
  非接收人确认返回 403；改派后的同 key 回放重判当前责任；不同回执的同 key 相互隔离。
- 保持 Task → receipt 锁序；先判断回执接收人，再判断当前责任人。未确认回执改派后旧人
  已不再是接收人（403），已确认历史回执的旧接收人不再负责时返回 409。
- confirm/adopt 回执 key 含 actor 与 receipt；差异讨论使用同作用域派生 key。候选批注
  只刷新拥有者命令读面，发布后批注才产生团队事件。
- 定向复跑三个 integration 文件：artifact-review、handoff-receipt、handoff-attention。
  最初 4 failed / 26 passed，修复后通过；隔离回执的追加正控随最终检查一起运行。
- 改派与幂等回放预检查之间的极短并发窗口未用时序注入覆盖；本次验证的是改派提交后
  的重放拒绝，不宣称已覆盖所有并发排列。候选存在性由事件持久层断言，不靠截图。

## 2026-10-26 独立评审补充：响应未知后的发送意图

独立 review 发现两个前端重试分支：交接问题保存后丢响应，再编辑会误用旧键而丢新问题；审阅批注/回复保存后丢响应，再重试会新建键而重复保存。现在各评论输入及交接提问仅保存当前完整意图的键：失败且内容不变时重用，正文或文件/锚点/父线程/交接上下文改变时换新键，明确成功后结束该意图。与服务端一致按 trim 后正文判断等价；A→B→A 不复活旧键。

复跑（Node 24）：`pnpm exec vitest run --project web apps/web/tests/artifact-review.spec.tsx apps/web/tests/handoff-receipt.spec.tsx --maxWorkers=2`。HTTP 回放缝先保存再抛连接错误，同键返回首次结果；通过真实页面输入和重试核对实际保存条数/内容及锚点/父线程。先红 5 fail/26 pass，修复后含位置/线程变化补充场景共 33/33 pass；Web 类型、定向格式/lint、敏感扫描同轮检查。此处覆盖当前页面生命周期内的重试，不宣称刷新或跨设备仍持久保存草稿意图。
