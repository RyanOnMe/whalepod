# 项目来源绑定生命周期验收（PC-02a）

- 对应门禁：Q0/Q1、Q2、Q7；Web 与真实平台适配器不在本切片。
- 对应 Issue：PC-02a #455（PC-02 伞 Issue #449）；决定见 ADR-0024。
- 上次验证：2026-10-31 · `feat/pc-02a-source-lifecycle` · Q0 2237 例、Q2 604 例（79 文件）、Q7 18 例 + secret-scan + license 全绿；domain 分支覆盖 100%。

## 验的是哪条用户路径

成员在项目里绑定一个外部办公来源：先确认「内容会共享给整个 Team」，指定一台已配对的采集 Node 与凭据槽位；Hub 通过真实 Node WebSocket 做只读权限检查，绑定后另一成员能看到同一来源的范围与同步状态。绑定者或管理员可以暂停、恢复、撤销；撤销后同一资源可以重新绑定为新行。权限到期后来源进入待重验，连续 7 天未恢复转不可用。

本切片用假 Node 模拟平台侧只读检查的应答；真实飞书租户、真实文档读取、正文与派生内容仍为 `not_run`（PC-01 / PC-02b / PC-03）。

## 驱动

```bash
# 来源生命周期（11 例；真实 HTTP + 真实 /ws/v1/node）
pnpm exec tsx scripts/with-test-postgres.mts vitest run --project integration \
  apps/hub/tests/source.integration.spec.ts

# DB 不变量（6 例：活动绑定唯一、撤销字段、权限字段、租约主键、审计上限）
pnpm exec tsx scripts/with-test-postgres.mts vitest run --project integration \
  packages/db/tests/source.integration.spec.ts
```

Hub 集成用例通过 Fastify inject 走成员 HTTP（Session + Origin + Idempotency-Key），并连接真实 `/ws/v1/node`；假 Node 只解析 `source.permission_check` 并回 `source.permission_result`，不绕过 Hub 的协议解析、连接注册表、状态机或事务。没有直插来源表制造业务状态；两处时间模拟直接改 `permission_expires_at` / `permission_unknown_since`，在用例内注明。

## 观测

- `hub.context`：`source.bound` / `source.paused` / `source.resumed` / `source.revoked` / `source.permission_changed`，字段只有 `sourceId/projectId/platform/kind/status/permissionState/authorizationGeneration`。
- Team Event `source.changed`：只含 `sourceId/projectId/status`（权限变化时增 `permissionState`）。
- `source_audit_event`：绑定/暂停/恢复/撤销/权限变化的追加审计，含理由与代次，不含资源身份、appKey、凭据或正文。
- `project_source` 行：`authorizationGeneration` 单调递增；`permissionState` 与 `permissionExpiresAt` 共同表达水位。

## 判定

1. 绑定前 Node 必须在 hello 中声明 `feishu.read.v1`；未声明返回 400 `SOURCE_UNSUPPORTED`，不发送检查帧。
2. 采集 Node 必须属于绑定者；别人的设备返回 404，不暴露存在性。
3. `denied` 与 `not_found` 统一返回 403 `SOURCE_NOT_READABLE`，不落库。
4. 同一 `Idempotency-Key` 重放返回同一来源；同一活动资源第二次绑定返回 409 `SOURCE_ALREADY_BOUND`。
5. 绑定者/管理员可暂停/恢复/撤销；其他成员 403；每次状态变化代次 +1。
6. 撤销必须带 1–500 字符理由；撤销后同一资源可重新绑定为新行、代次回到 1。
7. 同一应用事件流（appKey）被另一台在线 Node 持有时，第二次绑定返回 409 `SOURCE_LEASE_LOST`。
8. 采集 Node 离线/未应答/连接切换返回 409 `SOURCE_COLLECTOR_OFFLINE`。
9. 权限过期 reconcile：`verified → unknown`（代次 +1，停止新用途）→ 7 天后 `unavailable`；Team Event 与审计同步。
10. 视图、审计与 Team Event 均不含 `resourceKey`、`appKey`、凭据或平台名称；缺会话的任一来源路由返回 401。

## 归因

- 绑定被拒：先看 `hub.context` 的 `source.*` 与 Node hello 的能力声明，再看 `checkCollector` 的能力/在线/所有者守卫。
- 撤销后仍能读/仍能同步：看 `project_source.status` 与 `source_collection_lease` 是否释放，再看 `source.changed` 是否发出。
- 同一变化重复提醒/重复绑定：看 `command_receipt` 的幂等键与 `project_source_active_resource` 部分唯一索引。
- 权限水位不对：看 `permission_expires_at`、`permission_unknown_since` 与 `reconcileSourcePermissions` 的日志/审计。

## 取证

- 机器证据是两份 integration spec 的退出码与断言结果；CI 的 `integration` job 同时跑 Q2/Q6/Q7。
- 本切片不产生 `artifacts/evidence/` 组合包：没有跨 Web/Node/Runtime 的组合链路。证据包中的 Cookie、设备令牌、来源资源身份与凭据一律不落盘。
- 提交前：`scripts/secret-scan.sh`（Q7 已含自检与实扫）。

## 边界与未覆盖

- **真实飞书适配器与真实租户**：PC-01（#448）未跑；本切片的假 Node 只证明协议与生命周期，不证明平台权限、普通群消息或文档范围可读。
- **Web 来源页**：PC-02c 未实现；当前只有 HTTP 读面。
- **来源正文与派生内容**：`source_revision`、正文 24 小时清除、派生条目失效由 PC-03 按 ADR-0025 落地；本切片没有正文可清。
- **旧代次观察拒绝**：观察帧在 PC-03 才出现；本切片只验证代次在暂停/恢复/撤销/权限变化时单调递增。
- **活跃 Run 提示**：PC-05/PC-06；本切片不装配 Run 上下文。
- **`node.source` 观测**：真实 Node 适配器随 PC-02b；本切片 Hub 侧只有 `hub.context`。
- **真实平台身份映射**：ADR-0024 §3 的一次性码认领随 PC-04 落地；本切片不映射外部作者。

## 复跑

```bash
pnpm check
pnpm --filter @whalepod/domain test:coverage
pnpm test:integration
pnpm test:security
```

干净环境先跑 `scripts/install-hooks.sh`；证据与日志按 `docs/agent/evidence-map.md` 的 `hub.context` 行定位。
