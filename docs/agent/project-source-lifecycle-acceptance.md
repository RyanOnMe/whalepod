# 项目来源绑定生命周期验收（PC-02a）

- 对应门禁：Q0/Q1、Q2、Q7；Web 与真实平台适配器不在本切片。
- 对应 Issue：PC-02a #455（PC-02 伞 Issue #449）；决定见 ADR-0024。
- 上次验证：2026-10-31 · `feat/pc-02a-source-lifecycle` · Q0 2237 例（205 文件）、Q1 258 例（domain 分支 100%）、Q2 629 例（79 文件）、Q7 18 例（既有安全族，无来源专项）+ secret-scan 自检/实扫 + license 全绿。

## 验的是哪条用户路径

成员在项目里绑定一个外部办公来源：先确认「内容会共享给整个 Team」，指定一台已配对的采集 Node 与凭据槽位；Hub 通过真实 Node WebSocket 做只读权限检查，绑定后另一成员能看到同一来源的范围与同步状态。绑定者或管理员可以暂停、恢复、撤销；撤销后同一资源可以重新绑定为新行。

后台按 ADR-0024 收敛来源状态：在线采集器的**未过期且心跳在 30 秒内**的租约续租；心跳超过 30 秒后停止续租，租约到期（最多 90 秒）后活跃来源转不可用；过期租约不续期、不换发；采集器被撤销/解绑时来源（含暂停）转不可用；采集器仅离线不改变暂停态。权限到期后真实重验，成功刷新、失败才转待重验；待重验连续 7 天（含暂停来源）→ 不可用。

本切片用假 Node 模拟平台侧只读检查的应答；真实飞书租户、真实文档读取、正文与派生内容仍为 `not_run`（PC-01 / PC-02b / PC-03）。

## 驱动

```bash
# 来源生命周期（34 例；真实 HTTP + 真实 /ws/v1/node）
pnpm exec tsx scripts/with-test-postgres.mts vitest run --project integration \
  apps/hub/tests/source.integration.spec.ts

# DB 不变量（8 例：活动绑定唯一、撤销字段、权限字段、检查时刻必填、应用身份索引、租约主键、审计上限/动作）
pnpm exec tsx scripts/with-test-postgres.mts vitest run --project integration \
  packages/db/tests/source.integration.spec.ts
```

Hub 集成用例通过 Fastify inject 走成员 HTTP（Session + Origin + Idempotency-Key），并连接真实 `/ws/v1/node`；假 Node 只解析 `source.permission_check` 并回 `source.permission_result`，不绕过 Hub 的协议解析、连接注册表、状态机或事务。没有直插来源表制造业务状态；时间模拟直接改 `permission_expires_at` / `permission_unknown_since` / 租约 `expires_at`，在用例内注明。

## 观测

- `hub.context`：`source.bound` / `source.paused` / `source.resumed` / `source.revoked` / `source.unavailable` / `source.permission_*`，字段只有 `sourceId/projectId/platform/kind/status/permissionState/authorizationGeneration`。
- Team Event `source.changed`：`sourceId/projectId/status/changedAt`（权限变化时增 `permissionState`）。
- `source_audit_event`：`bound/paused/resumed/revoked/unavailable/permission_changed/lease_changed`，含理由与代次，不含资源身份、appKey、凭据或正文。
- `project_source` 行：`authorizationGeneration` 单调递增；`permissionState` 与 `permissionExpiresAt` 共同表达水位。

## 判定

1. 绑定前 Node 必须在 hello 中声明 `feishu.read.v1`；未声明返回 400 `SOURCE_UNSUPPORTED`，不发送检查帧。
2. 采集 Node 必须属于绑定者；别人的设备返回 404，不暴露存在性。管理员也不能借别人的采集 Node 绑定。
3. `denied` 与 `not_found` 统一返回 403 `SOURCE_NOT_READABLE`，不落库。
4. 绑定/恢复回执先于 Node RPC：同一 `Idempotency-Key` 重放返回同一结果，即使 Node 之后离线；成功恢复重放返回来源视图而不是 `{view}` 包装，被拒恢复重放仍是 403 `SOURCE_NOT_READABLE` 而不是 200；并发同 key 不产生 500、不产生第二条来源。命令 key 按 actor + project 收窄。
5. 绑定者/管理员可暂停/恢复/撤销；其他成员 403；每次状态变化代次 +1。管理员可管理其他成员的来源；成员用同一 key 字符串重放别人的管理命令仍 403。
6. 撤销必须带 1–500 字符理由；撤销后同一资源可重新绑定为新行、代次回到 1。
7. 同一应用事件流（appKey）只有一个采集者；另一台 Node 在租约有效时被拒；租约过期但仍有活跃来源时也不允许静默接管。reconcile 对过期租约不续期、不换发；过期租约保留到下一轮，无活跃来源时释放并写 `lease_changed` 审计。
8. 采集 Node 离线/未应答/连接切换返回 409 `SOURCE_COLLECTOR_OFFLINE`；恢复时若采集器返回不同 appKey，拒绝并要求重绑（409 `SOURCE_LEASE_LOST`），来源保持暂停。
9. 权限到期后 reconcile 会对**活跃**来源向在线采集器真实重验（暂停来源在恢复时重验，见边界）：成功刷新 `permissionCheckedAt/ExpiresAt` 并 +1 代次；无法验证（能力缺失/离线）才转 `unknown`；明确拒绝转 `unavailable/denied`；采集器返回的 appKey 变化转 `unavailable/unknown`；unknown 连续 7 天（含已暂停来源）转 `unavailable`。
10. 采集器被撤销/解绑 → 来源（含暂停）`unavailable`；活跃来源的租约过期（无论采集器当前是否已重连）→ `unavailable`；在线采集器的未过期且心跳在 30 秒内的租约在 reconcile 中续租；socket 打开但心跳过期按离线处理；暂停来源不因采集器仅离线而改变状态。
11. 视图、审计与 Team Event 均不含 `resourceKey`、`appKey`、凭据或平台名称；畸形 `projectId/sourceId` 在落 PostgreSQL 前返回 400；缺会话的任一来源路由返回 401。
12. `autoExtraction=true` 在 ADR-0026 接受前被拒绝（400 `SOURCE_UNSUPPORTED`）。

## 归因

- 绑定被拒：先看 `hub.context` 的 `source.*` 与 Node hello 的能力声明，再看 `checkCollector` 的能力/在线/所有者守卫。
- 暂停/恢复/撤销不对：看 `project_source.status`、`authorizationGeneration` 与 `source_audit_event` 的 `paused/resumed/revoked/lease_changed`。
- 撤销后仍能同步：看 `source_collection_lease` 是否在无活跃来源时释放，以及 `reconcileCollectors` 的 `collector_revoked/collector_offline` 审计。
- 来源无故变待重验：看 `reconcileSourcePermissions` 的重验结果与 `permission_changed` 的 `reason`（`revalidated`/`verification_failed`/`revalidation_denied`/`permission_unknown_too_long`）。
- 同一变化重复提醒/重复绑定：看 `command_receipt` 的 actor/project 作用域 key 与 `project_source_active_resource` 部分唯一索引。

## 取证

- 机器证据是两份 integration spec 的退出码与断言结果；CI 的 `integration` job 同时跑 Q2/Q6/Q7。
- 本切片不产生 `artifacts/evidence/` 组合包：没有跨 Web/Node/Runtime 的组合链路。证据包中的 Cookie、设备令牌、来源资源身份与凭据一律不落盘。
- 提交前：`scripts/secret-scan.sh`（Q7 已含自检与实扫）。

## 负控变异自证

每条关键守卫做一次单点改坏，确认对应用例变红，再恢复；恢复后 34/34 重跑绿（DB 8/8 另跑）。

| 改坏的守卫 | 变红的用例 |
|---|---|
| 跳过 hello 能力声明检查 | `does not advertise the capability` |
| 跳过采集 Node 所有者检查 | `another member’s collector node` |
| 跳过绑定回执前置查询 | `replays a bind receipt` |
| 跳过活跃来源的租约接管保护 | `rejects a second collector`（租约过期但 A 仍活跃） |
| 跳过权限到期重验扫描 | `revalidates an online source` |
| 跳过采集器撤销/离线扫描 | `collector device is revoked` |
| 重验成功但代次不递增 | `revalidates an online source` |
| resume 回执按裸视图返回（复核 B5） | `replays a successful resume` + `replays a denied resume`（实测 200 vs 403） |
| 过期租约照常续租（复核 #2） | `does not renew an expired lease`（实测 `leasesExpired 0 / leasesRenewed 1 / unavailable 0`） |
| 过期租约仍允许同设备重新取租约（第三轮 #1） | `refuses bind and resume on an expired lease`（实测 201 vs 409） |
| 租约活性只认 socket OPEN（第三轮 #2） | `does not renew a lease when the collector heartbeat is stale`（实测 `leasesRenewed 1`） |
| 整轮单飞（第三轮 #3，等价旧 server 守卫） | `keeps renewing leases while a slow permission revalidation`（实测 `leasesRenewed 0`；用例覆盖 server 调用的 reconciler 入口） |
| 并发恢复只在事务外读回执（第三轮非阻断 1） | `returns 403 to both concurrent denied resumes`（实测 409 vs 403，3/3） |

## 边界与未覆盖

- **真实飞书适配器与真实租户**：PC-01（#448）未跑；本切片的假 Node 只证明协议与生命周期，不证明平台权限、普通群消息或文档范围可读。
- **Web 来源页**：PC-02c 未实现；当前只有 HTTP 读面。
- **来源正文与派生内容**：`source_revision`、正文 24 小时清除、派生条目失效由 PC-03 按 ADR-0025 落地；本切片没有正文可清。
- **旧代次观察拒绝**：观察帧在 PC-03 才出现；本切片验证代次在暂停/恢复/撤销/重验/采集器变化时单调递增。
- **unknown 的自动恢复**：没有后台重试；成员可暂停后再恢复以触发重验。7 天内未恢复则转不可用。
- **暂停来源的采集器状态**：采集器仅离线不改变暂停态；采集器被撤销/解绑才转不可用。暂停来源没有活跃租约，因此「离线超过租约期」只对活跃来源成立。
- **过期租约的观察围栏**：本切片尚无观察帧；PC-03 接入时按租约代次拒绝旧观察。当前只保证过期租约不被静默续期/换发。
- **租约 generation 的连续性**：暂停释放、恢复重新获取时租约 generation 从 1 开始，不跨释放单调；PC-03 的观察围栏必须同时校验来源 `authorizationGeneration`（或持久化租约世代），不能只依赖租约 generation。
- **采集器心跳**：活性以 30 秒心跳为准；socket 打开但心跳过期后停止续租，租约到期（最多 90 秒）才转不可用。`source.permission_result` / `node.preparation_result` 当前不刷新 `lastSeenAt`；协议合规 Node 每 10 秒心跳，不受影响。
- **暂停来源的 24 小时重验**：本切片只重验活跃来源；暂停来源在恢复时重验。PC-02a 没有正文读面，暂停期间不存在内容暴露；PC-03 提供正文读面前必须把暂停来源纳入 24 小时重验或引入等价的内容失效机制。
- **Web 事件路由**：`source.changed` 的 Web 处理在 PC-02c；当前 Web 对未知事件会触发一次全量 resync。后端事件量很小（绑定/暂停/恢复/撤销/重验），PC-02c 接入时必须注册，避免把日重验放大成全量刷新。
- **活跃 Run 提示**：PC-05/PC-06；本切片不装配 Run 上下文。
- **`node.source` 观测**：真实 Node 适配器随 PC-02b；本切片 Hub 侧只有 `hub.context` 与 `source_audit_event`。
- **共享常驻采集 Node**：首轮要求采集 Node 属于绑定者；共享常驻 Node 另行设计（ADR-0024 §2）。
- **真实平台身份映射**：ADR-0024 §3 的一次性码认领随 PC-04 落地；本切片不映射外部作者。
- **平台名称/成员文本**：`displayLabel` 与撤销理由由成员填写、团队可见；服务端只限长度，不判断语义。

## 复跑

```bash
pnpm check
pnpm --filter @whalepod/domain test:coverage
pnpm test:integration
pnpm test:security
```

干净环境先跑 `scripts/install-hooks.sh`；证据与日志按 `docs/agent/evidence-map.md` 的 `hub.context` 行定位。
