# 运行卡阶段徽标 + 任务房间实时失效验收（P1-UX-14 / #261，父账 #243 后续·P1-UX 三期刀二）

## 这条切片改变什么

① 任务房间的运行卡只显示状态与耗时，「思考中/工具执行中/收尾中」只在 Run Console 的
事件流里看得到；② 更根本的缺口：`run.changed`/`run.event` 只失效 `['run', runId]`
（event-router 旧键表），**运行卡的状态徽标在页面上根本不随事件刷新**——要等刷新或别的
mutation。本刀：服务端投影 `lastPhase` + 运行卡阶段徽标 + 补上房间级失效。

## 数据面（Hub ↔ Web 内部读模型，不触协议）

`TaskRoomRun.lastPhase: { phase: 'thinking'|'tool'|'finalizing'; at: string } | null`
（apps/hub/src/modules/task/view.ts），取数 `latestPhasesByRun`
（packages/db/src/repositories/event.ts）——与 #246 的 `latestToolStartsByRun` 同式同口径：

- **DISTINCT ON (run_id) seq DESC**，每 Run 一条，不 N+1；
- **只取 project 受众**：projector 对阶段是双受众投影（`both()` thinking；
  tool/finalizing 成对），两行 phase 相同——进全员可见的房间视图取 project 行不越受众。
  **这是安全判据**，不是实现细节；
- **读模型不信任写路径**（#246 口径）：最新那条的 phase 不在协议枚举里就当没有，
  不为了「有东西可画」回退到更旧的行（旧阶段挂在现在这一刻上同样是撒谎）。

本地 SQL 探针（不连库，编译 WHERE 看过滤在不在）：

```
SQL : ("run_event"."run_id" in ($1) and "run_event"."type" = $2 and "run_event"."audience" = $3)
参数: ["r1","run.phase","project"]
```

## 展示规则（撒谎判据）

只对 `status === 'running'` 的 Run 画阶段徽标：

- **终态 Run 的投影里也有末次阶段**（读模型只给事实），但「收尾中」挂在已完成的 Run 上
  就是撒谎；
- `waiting_approval` 也不画——人在等，不是它在跑，状态徽标已经说了「等待审批」；
- `running` 但投影没有阶段（null）不画，不编造。

标签与 Run Console 同源：`PHASE_LABEL` 从 RunLivePanel 的私有常量上收为
`RUN_PHASE_LABEL`（shared/format.ts，`Record<RunPhase, string>`——协议加阶段时这里编译红），
`describeEvent` 与运行卡徽标同取一份。

## 实时失效（补的缺口）

| 帧 | 失效键 | 为什么 |
|---|---|---|
| `run.changed {runId, taskId}` | `['run', runId]` + `['task-room', taskId]` | 房间里的运行卡状态徽标必须随事件动 |
| `run.event` 且 `event.type === 'run.phase'` | `['run', runId]` + `['task-room']`（前缀） | 阶段是「正在做什么」的唯一信号；载荷**没有 taskId**（orchestrator 只带 runId/seq/audience/ownerUserId/event），只能前缀失效 |
| 其他 `run.event`（tool.started/assistant.message…） | 只有 `['run', runId]` | 事件频率（每条都来）不该变成房间重拉频率 |

前缀失效的代价：同一客户端里同族查询只有当前打开的那一个房间。缺 taskId 的
`run.changed` 同样降级为前缀（既有降级用例已更新）。

## 驱动与判定

- **Q2 集成**（`apps/hub/tests/room-last-phase.integration.spec.ts`，4 例，CI 验，本地无 Docker）：
  无阶段事件 → null；双受众成对时取 seq 最大的 project 行（含 ISO 时间）；
  **受众收缩：owner-only 的高 seq 行不进全员视图**（越权构造，红了就是泄漏）；
  多 Run 不串档；未知 phase 当没有。
- **Q1 web**（`apps/web/tests/run-phase-badge.spec.tsx`，3 例；`event-router.spec.ts` 键表 7 例）：
  徽标只在 running+有阶段时画（四态一屏同断）；**残缺形状不白屏**（回归，见踩坑①）；
  帧驱动：`run.changed` → 房间重拉、`run.event(run.phase)` → 房间重拉、
  `run.event(tool.started)` → 不重拉（GET 计数判据）。
- **变异自测**（门要能被证伪）——本地两刀全红：
  | 变异 | 结果 |
  |---|---|
  | 掐「只对 running 显示」（去掉状态条件） | 红（四态用例得到 2 个徽标） |
  | 掐 `run.changed → ['task-room', taskId]` | 红（帧到达房间不重拉） |
  受众过滤的变异（删 `eq(audience,'project')`）由 Q2 集成用例在 CI 上判——上一条 SQL 探针
  是它的本地旁证。
- **Q0**：`pnpm check` 全绿（112 文件 1378 过 / 7 预期失败为既有深色 `it.fails` 债）。

## 踩坑记录

1. **`lastPhase !== null` 放过了 `undefined`，整页白屏**——由**既有** spec
   （`target-picker.spec.tsx` 手工拼的最小 run 载荷，只有 8 个字段）当场抓红：
   `undefined.phase` 抛错 → 任务房间渲染不出来。教训：wire 形状不可信（投影可能来自
   老 Hub 或手工载荷），取标签前先判形状；已补回归用例钉住。这是本刀唯一一个真 bug，
   而且是**别人的测试**发现的——既有 spec 的残余价值。
2. **必填字段会连锁红三处**：`fixtures.makeRun`、`run-duration.spec.ts`、
   `comment-run-ref.spec.tsx` 各有一份 run 字面量（后两处注释里写着「新必填字段，
   缺了类型检查会红」——约定生效）。
3. **本地 `pnpm check` 要先 build**：hub 经包名 import `@whalepod/db` 走 dist（#35），
   新导出的函数在 dist 里还没有 → TS2305。`pnpm -r --if-present build` 后即绿；
   CI 的 check 与 integration 两个 job 本来就先 build。
4. `event-router` 的降级键契约跟着改：`run.changed` 缺 taskId 时房间键降级为
   `['task-room']` 前缀（既有用例的期望值同步更新）。

## 边界与债

- 阶段徽标只表达「现在在做什么」，不做历史回放与分阶段耗时统计（Run Console 的活）。
- `cancel_requested` 不画阶段（状态徽标已说「取消中」）；要显示得先有「取消中的阶段是什么」
  的口径。
- Q5 e2e 未覆盖本刀（挂 #243 总账既有债）；窄屏与宽屏同布局（徽标是行内 span，无断点差异）。

## 复跑

```bash
pnpm vitest run --project web apps/web/tests/run-phase-badge.spec.tsx   # 3 例
pnpm vitest run --project unit apps/web/tests/event-router.spec.ts      # 7 例（键表契约）
pnpm test:integration                                                   # 需 Docker；本地不可用时由 CI 跑
pnpm check                                                              # Q0 全门（先 pnpm -r --if-present build）
```
