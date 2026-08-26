# Device 配对、出站连接与租约 验收

- 对应场景/门禁：G3-01..03、R4/R5 连接前半场（04-验收矩阵与测试策略.md）、Q0/Q2
- 对应 Issue：P1-09
- 上次验证：2026-08-26 · feat/p1-09-device-pairing-heartbeat · 结果 PASS

## 验的是哪条用户路径

Member 生成一次性配对码 → Node CLI `project311-node pair --hub <url> --code <code>` 匿名换取 Device Token（只出现一次、本地存 0600）→ Node `start` 出站连入 Hub `/ws/v1/node`，握手 `Authorization: Device <token>` 认证 → 上行 `node.hello` 回填 #37 运行时事实列（dsh 版本/pack digests）→ 10s 心跳维持租约；30s 无心跳由 Hub reconciler 将活跃 Run 转 lost（R5）；撤销时 Hub 下发 `node.token_revoked` 并断开，Node 清理本地 Token。

## 驱动（怎么触发）

- Hub HTTP 面 + WS：Fastify `app.inject` + 真实端口 `app.listen({port:0})` + `ws` 包客户端（自定义 Authorization 头）。
- Node CLI：单元测试直驱模块函数（config 往返、claimDevice 注入 fetch、reconnect 退避序列）。
- 数据库：Docker 一次性 PostgreSQL 18。

```bash
pnpm test:integration     # Q2：device-pairing(4) + node-websocket(5) + 既有 153 = 162
pnpm test:unit            # Q0：config(2) + pairing(2) + reconnect(2) + gateway(3) + 既有 = 475
```

## 判定（成功长什么样）

- G3-01：配对码 ≥22 字符；Token 43 字符只出现一次；重复 claim → 409；device 归码创建者（不是 claim 调用方）。
- G3-02：Alice 用 Bob 的码 claim → device.ownerUserId = Bob（结构性归属绑定）。
- G3-03：重用码 → 409；过期码 → 409；GET /devices 派生 online/offline/revoked 状态。
- 撤销：本人或 Owner/Admin 可撤；无关 Member → 404（不可枚举）；幂等重复删 → 200。
- WS 认证：无 Token / 错 Token → 升级前 401；正确 Token → 连接建立。
- hello 落库：`dsh_distribution_version` + `plugin_pack_digests` 写入 #37 列 + lastSeenAt 刷新。
- 单连接替换：同 Device 第二条连接 4008 替换第一条。
- 心跳：`node.heartbeat` 刷新 `last_seen_at`。
- 撤销推送：DELETE → 在线连接收到 `node.token_revoked` 帧 + 4008 断开。
- 网关：`WsDeviceGateway.send` 在线投递合法 JSON 帧；离线抛 `NodeOfflineError`（瞬时，OutboxWorker 留队重投）；替换后投递走新 socket。
- Node 本地配置：`~/.project311-node/config.json` mode 0600；缺失返回 undefined。
- 退避：250ms→500ms→…→30s 封顶 + 0–20% full jitter。

## 归因（失败先看哪层）

- 配对/claim 不对 → `apps/hub/src/modules/device/pairing.ts` + `packages/db/src/repositories/device.ts`（原子消费 consumePairingCode）。
- WS 认证/分发不对 → `apps/hub/src/modules/device/node-websocket.ts`（onRequest 401 + parseNodeFrame fail-closed + orchestrator.ingestNodeEvent）。
- 替换/撤销推送不对 → `apps/hub/src/modules/device/connection-registry.ts`（attach 4008 + pushTokenRevokedAndClose）。
- 下行投递不对 → `apps/hub/src/modules/device/gateway.ts`（WsDeviceGateway → registry.send）。
- worker/租约不启动 → `apps/hub/src/server.ts`（OutboxWorker 250ms + reconcileLeases 10s 定时器）。
- Node CLI/配置不对 → `apps/node/src/{cli,config,pairing/client,gateway/{hub-socket,reconnect}}.ts`。

## 取证

```bash
pnpm check && pnpm test:integration && pnpm test:unit
bash scripts/secret-scan.sh packages/db apps/hub apps/node packages/protocol
```

## 边界与未覆盖

- **Origin 豁免**：`/api/v1/devices/pairing-claims` 与 `/api/v1/node/**` 按 03 §4 末段豁免 Browser Origin 校验（Idempotency-Key 仍强制）；改在 app.ts onRequest 钩子内。
- **端到端 dispatch-through-WS 未做集成用例**：orchestrator.create→worker→WsDeviceGateway→ws client 的完整链需要 workspace FK（P1-12 inventory 才建）；以 `device-gateway.spec`（registry→socket 单元证据）替代，端到端随 P1-12/P1-13 接线补。
- **租约 lost 的端到端用例**：reconciler 的 lost 行为已在 P1-10 的 run-dispatch/reconciler spec 验证；P1-09 只接入定时器，不重测。
- **Node CLI start 的真实 WS 集成**：CLI 的 connect/heartbeat/reconnect 是单元级（退避序列 + 配置往返 + claim 客户端注入 fetch）；真实 Hub↔Node WS 端到端在 P1-12 接 Workspace 后做。
- **web 配对 UI 不在本泳道**：P1-07 的 Devices 页空态承接；真实 PairingPanel 随三线合入后的小跟进 PR 落地。
- **hello 上报 supportedProtocolVersions**：协议 schema 有该字段但 Hub 目前只持久化 version+digests；protocol mismatch 关闭（03 §11）待 P1-12 Node 版本协商。
- **capabilities**：配对时空对象起算；P1-12 inventory 扩展。

## 复跑

```bash
corepack enable && pnpm install --frozen-lockfile && pnpm -r --if-present build
pnpm check && pnpm test:integration && pnpm test:unit
```
