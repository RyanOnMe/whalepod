# Browser 实时链路验收（P1-08）

覆盖：02 Task 8、03 §5、04 G2-06 / R1–R3 断线矩阵 / §6.2 WebSocket 攻击矩阵。

## 验收场景与证据

| ID | 驱动 | 判定 | 证据 |
|---|---|---|---|
| RT-1 | 先写 11/12/13 号事件，cursor=11 连接 | 只补 12、13，按 id 升序，无重复 | `apps/hub/tests/realtime.integration.spec.ts`(1) |
| RT-2 | 握手不带 Cookie | 升级前 401（`unexpected-response`） | 同上(2) |
| RT-3 | 握手 Origin 不符/缺失 | 升级前 403 | 同上(3) |
| RT-4 | cursor 早于 24h 保留窗口 | control `resync.required` + close 4009，不猜缺失 | 同上(4) |
| RT-5 | cursor=0 且仓库只有过期事件 | 不补发、不 resync，连接保持 | 同上(5) |
| RT-6 | 待发 >1000 条 / >4MiB（慢客户端压背压） | control `resync.required` 最后一帧 + close 4009 | 同上(6) |
| RT-7 | owner live delta 注入 | 只到 owner 连接；bob 双向永不可见（400ms 静默） | 同上(7) |
| RT-8 | 断线后用已提交 cursor 重连 | 只补窗口缺口，无重复补发 | 同上(8) |
| RT-9 | 断线期间另一成员产生 task.changed | 250ms 轮询推给已连接成员 | 同上(9) |
| RT-10 | Web event-router 三类帧 | persistent→invalidate+commit；live→sink；control→resync；未知事件不改 UI 立即 resync；handler 失败不提交 cursor | `apps/web/tests/event-router.spec.ts` |
| RT-11 | socket 断线重连 | 指数退避 + full jitter 250ms→30s；resync 后放弃光标重放 | `apps/web/tests/socket.spec.ts` |

## 驱动说明

- Hub 侧全部走真人路径：真实端口 `app.listen({port:0})` + `ws` 包客户端带
  `{headers:{cookie,origin}}` 自定义头握手（Node 全局 WebSocket 无法自定义 header）。
- live delta 经 `app.realtime.publishLive` 注入面驱动（P1-13 run 模块接线前的测试 seam）。

## 归因（失败先看哪层）

- 握手 401/403 不对 → `apps/hub/src/modules/realtime/client-websocket.ts`
  `createClientWsAuth`（Session Cookie 复用 auth/session `resolveSession`；Origin 严格比对）。
- 补发顺序/缺口 → `team-event-store.ts`（`listAfter(cursor, highWater)` 按 id 升序）。
- resync/4009 触发时机 → `client-websocket.ts` 的 `PendingQueue`（1000 条 / 4MiB）与
  `lastExpiredCursor` 保留窗口判断。
- 帧解析失败 → `packages/protocol/src/client-events.ts` `parseClientFrame`（fail-closed）。
- Web 端缓存键不对 → `apps/web/src/shared/realtime/event-router.ts` 映射表
  （与 P1-07 Task Room 查询键的接线契约，见 PR body）。

## 取证

```bash
cd .worktrees/p1-08-realtime
pnpm exec tsx scripts/with-test-postgres.mts vitest run --project integration apps/hub/tests/realtime.integration.spec.ts
pnpm exec vitest run --project unit apps/web/tests
bash scripts/secret-scan.sh apps/hub/src/modules/realtime apps/web/src/shared/realtime apps/hub/tests
```

## 边界与未覆盖

- **NOTIFY/LISTEN 未做**（文档明示可缓做的优化）：持久事件 fan-out 用进程内
  250ms 轮询（`subscriptions.ts`），单一 Hub 进程的小团队规模下可接受。
- persistent 帧不做 owner 过滤：`team_event` 表现行无 audience/owner 列，
  第一阶段只写入全 Team 可投影事件；owner-only 隐私由 live 帧受众与
  P1-13 写入侧的投影范围承担（04 §6.2 的 owner 隔离经 RT-7 验证在 live 面成立）。
- `use-team-events` React hook 延后（依赖面归 P1-07 合入后接线）：本轮交付
  `socket/cursor-store/event-router` 纯 TS 层与 node 测试，hook 是 P1-07 接线小 PR。
- 24h 保留窗口的物理归档（定时 purge）不在本轮：窗口判断已 fail-closed，
  即使过期行仍在库里也按 cursor 边界拒绝补发（RT-4）。

## 复跑

```bash
corepack enable && pnpm install && pnpm -r --if-present build
pnpm test:integration && pnpm check
```