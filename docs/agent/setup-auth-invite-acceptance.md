# 首次 Setup、登录、邀请与角色 验收

- 对应场景/门禁：G1-01..06、04 §6.1 HTTP/IDOR 中属于身份域的用例、Q0/Q1/Q2（见 04-验收矩阵与测试策略.md）
- 对应 Issue：P1-05；#55（P1-17 review M10 遗留：core-empty digest 断代迁移并发锁）
- 上次验证：2026-09-01 · fix/p1-debt-migration-lock · 结果 PASS（合 origin/main #80 后复跑：Q0 unit 851、Q2 集成 37 files/273 例；#55 迁移并发/等锁超时四条全绿，红基线与绿实录脱敏留档 worktree 取证目录）

## 验的是哪条用户路径

部署者从空实例启动 Hub，CLI 取出一次性 Setup Token，在浏览器完成首次 Setup 成为 Owner；之后 Alice 登录/登出、创建邀请，Bob 凭邀请 Token 注册成为 Member 并独立登录；Alice 停用 Bob 后 Bob 的旧 Cookie 立即失效；任何人尝试停用最后一个 Owner 被拒绝。

## 驱动（怎么触发）

全部走 Fastify inject 打真实路由（真人同一条 HTTP 路径），数据库是 Docker 一次性 PostgreSQL 18：

```bash
pnpm test:integration            # Q2：packages/db + apps/hub 全部 integration spec
pnpm exec tsx scripts/with-test-postgres.mts vitest run --project integration apps/hub/tests
```

## 观测（看什么）

- HTTP 响应 envelope（`ok` / `error.code` / `requestId`）。
- DB 断言走 raw SQL：`team` / `user_account` / `team_member` / `auth_session` / `invite` / `plugin_pack` 行数与关键列。
- 审计事件：`component=hub.audit` 的结构化日志行，只含 `action` / `actor` / `outcome` / `requestId`，测试经 logger stream 捕获断言。

## 判定（成功长什么样）

- G1-01：POST /api/v1/setup → 201；team/user_account/team_member 各一行；Cookie 含 `HttpOnly`/`SameSite=Lax`/`Path=/`；密码为 `$argon2id$` PHC；session/invite 只存 32 字节 SHA-256；core-empty Plugin Pack 同行创建；Setup Token 文件被删除。
- G1-02：再次 setup → 409 `CONFLICT`，行数不变；并发 setup 恰一个 201。
- G1-03：邀请→接受→Bob 成为 member，invite `consumed_by/at` 写入，独立 Cookie 可访问 GET /team。
- G1-04：重复/未知/过期 Token 均同一 409 形态，不创建第二账号；并发接受恰一个 201。
- G1-05：Member 创建邀请 → 403 `FORBIDDEN` 且有 `invite.create/denied` 审计。
- G1-06：停用最后 Owner → 409，owner 保留、会话不撤销、有 denied 审计。
- 安全：无/错/`null`/多值 Origin 的非安全请求 403 `ORIGIN_REJECTED`；缺/非法 Idempotency-Key 400；停用用户旧 Cookie 401；过期会话 401 `SESSION_EXPIRED`；登录限流 429；错误口令与未知用户 401 形态逐字段一致（除 requestId）。
- 迁移并发（#55 判据一，`apps/hub/tests/setup.integration.spec.ts`）：遗留旧 digest 行时并发双跑 `migrateCoreEmptyPackDigest`——两调用都成功（无 dup key / 序列化错误）、`true` 恰好一个、终态 digest=现算常量；并发两个 POST /setup 重试——都 409、`component=hub.setup` 迁移告警恰好一条（warn 级结构化日志经 logger stream 计数）。无锁实现上两案必红（双 true / 双告警）。
- 迁移并发（#55 判据二，`packages/db/tests/migrations-concurrent.integration.spec.ts`）：空库并发双跑 `applyMigrations`——都成功、`_schema_migrations` 每文件恰一条、无「relation 已存在/dup key」同族报错（台账建表已收进 advisory lock；无锁实现上必撞 42P07 或 23505 二者之一）；病态持锁者场景以 `lock_timeout` 55P03 fail-fast、归因明确，放锁后重试恰好完成（同文件第二例与 hub spec 的 MigrationLockTimeoutError 例）。

## 归因（失败先看哪层）

- 401/403 形态不对 → `apps/hub/src/modules/auth/`（session/origin/rate-limit）。
- 409/行数不对 → `apps/hub/src/modules/team/commands.ts` 事务与 `packages/db/src/repositories/`（identity 三件套）。
- 500 → `hub.http` 结构化日志（只有 name/message，无堆栈无路径）。
- 审计缺失 → `modules/shared/audit.ts` 与路由的调用点。
- 迁移并发/告警计数不对（#55）→ `apps/hub/src/modules/team/commands.ts` 的事务 + `pg_advisory_xact_lock(CORE_EMPTY_MIGRATION_LOCK_KEY)`；等锁超时 503 → 同函数 `MigrationLockTimeoutError`（`component=hub.setup` warn 带 `lockTimeoutMs`）。
- 启动/并发迁移失败（#55）→ `packages/db/src/migrate.ts`（台账建表与逐文件应用同锁 `MIGRATION_LOCK_KEY=20260825`；55P03=有实例持锁，属预期 fail-fast，重试即可）。

## 取证

```bash
pnpm exec tsx scripts/with-test-postgres.mts vitest run --project integration apps/hub/tests
# #55 迁移并发四条（直调双跑/并发 /setup 告警计数/等锁超时/空库并发 applyMigrations）：
pnpm exec tsx scripts/with-test-postgres.mts vitest run --project integration \
  apps/hub/tests/setup.integration.spec.ts packages/db/tests/migrations-concurrent.integration.spec.ts
# 改动文件过敏感扫描：
bash scripts/secret-scan.sh apps/hub packages/db/src
```

## 边界与未覆盖

- 03 §4 路由表没有成员停用端点，本链新增 `POST /api/v1/team/members/:userId/disable`（Owner/Admin）；角色降级端点未实现（db 层 setMemberRole 的最后 Owner 保护已在 P1-04 覆盖）。
- G1-05 原文是「Member 调用插件安装接口」；插件接口属于后续 Issue，本验收用同属 Owner/Admin 权限门的 POST /invites 验证同一判定路径（domain `authorize(actor, 'create_invite')`）。
- 速率限制是单实例内存实现；多副本部署需要共享存储，第一阶段 Global Constraints 明确不加 Redis。
- 错误 Setup Token 401 `INVALID_CREDENTIALS`、限流 429 用 `FORBIDDEN`（03 §10 无 RATE_LIMITED 码），均为实现侧取值。

## 浏览器面补充（#141：邀请入口与接受页）

- 对应 Issue：#141（现象：成员邀请链在浏览器里两头都没有入口）。
- 新增 Hub 路由（`apps/hub/src/modules/team/invite-routes.ts`、`routes.ts`）：
  `GET /team/members`（成员名单，Session 必需）、`GET /invites/:token`（接受页预检，
  匿名可读、只回团队名/角色/有效期）、`POST /invites/:token/accept`（已登录一键加入，
  不建账号）。三者的验收用例在 `apps/hub/tests/invite-ui.integration.spec.ts`，
  走 Fastify inject 与既有邀请链同一条驱动方式。
- 预检的失效形态：未知 Token 404 `NOT_FOUND`；已用/已过期 409 `CONFLICT` 且
  `error.details` 给出 `{ expired, consumed }`，UI 据此说人话（**不显示裸错误码**）。
  匿名 `POST /invites/accept` 的不可枚举 409 形态（G1-04）保持不变。
- 响应面纳入协议 schema（对齐 #136 惯例）：`InvitePreflightSchema` /
  `InviteAcceptResultSchema`（`packages/protocol/src/http.ts`，均为 strictObject），
  两条路由出网前 `parse`——字段最小集由协议钉死，成员信息不可能随字段漂移漏出。
- 预检是**匿名可读**的，因此必须限流：与 `POST /setup`、匿名 `POST /invites/accept`
  共用匿名限流器，键前缀 `invite-preflight|<ip>`（每 IP 每窗口 20 次），超限 429
  `FORBIDDEN` 并写 `invite.preflight` / `rate_limited` 审计。不加限流则预检就是无成本
  的 Token 枚举通道（200/404 二分）。用例：`invite-ui.integration.spec.ts` 的
  「邀请预检速率限制」两条（超配额 429 + 与 invite-accept 各自独立计数）。
- `POST /invites/:token/accept` **不读** Idempotency-Key（无 `transactCommand` 回执）：
  组合根钩子仍强制该头存在，去重由数据保证（`consumeInvite` 原子 UPDATE 是唯一消费点，
  重放走「本人已消费」分支返回 `joined=false`）。用例钉死：同键重放两次都 200、
  成员行与 `command_receipt` 都不增。
- 浏览器面判定（web 单测，`pnpm test:unit` 的 web project）：
  `apps/web/tests/members-page.spec.tsx`（导航入口可达、角色选择、链接可复制、
  有效期、复制失败如实报错、Member 只读）、`apps/web/tests/invite-accept-page.spec.tsx`
  （未登录先说明再建号/登录、已登录一键加入落项目页、失效链接三种人话错误态）。
- 真人路径（Q5）草案：`apps/web/tests/e2e/invite-accept.spec.ts`——**未注册** playwright
  project，启用步骤写在文件末尾（单 Hub 只容一个团队，须独占一次 webServer 生命周期）。
  注册并实跑之前，本页的「两个真实浏览器」判据仍**未验证**。

## 复跑

```bash
corepack enable && pnpm install && pnpm -r --if-present build
pnpm test:integration && pnpm check
```
