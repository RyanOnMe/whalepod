# 运行状态集合收敛（#234）验收

- 对应场景/门禁：Q1（unit + web project）
- 对应 Issue：#234
- 上次验证：2026-09-30 · `refactor/p1-234-run-states` · 结果 PASS

## 验的是哪条用户路径

行为零变化（重构）：TaskRoomPage 的 `ACTIVE_RUN`/`QUEUEING_RUN`、RunActions 与
RunLivePanel 的 `TERMINAL_RUN` 三处各写一份，收敛到 `features/task/run-states.ts`
单一模块；语义注释随迁（含 QUEUEING 与 hub `FOLLOWUP_QUEUEING_STATUSES`
逐字对齐的 #209 R3 警告）。

## 防漂移判据（`tests/run-states.spec.ts`，对协议真源）

- `ACTIVE ∪ TERMINAL` 恰好等于协议 `RunStatusSchema.options` 全集且互不相交
  ——协议加/改名状态时必红，逼 web 端语义重新过一遍；
- `QUEUEING ⊂ ACTIVE`；
- `cancel_requested ∈ ACTIVE \ QUEUEING`（取消中挡重复起 Run、但 hub 对其追问
  当场拒绝的语义钉）；
- `running ∉ QUEUEING`（立即下发窗口）。

## 行为不变的证据

`pnpm check` 全量绿（Q0+Q1，1301 用例 = 原 1297 + 4 条新关系判据；三个引用点
的既有用例零改动全绿）。

## 复跑

```bash
pnpm exec vitest run --project unit apps/web/tests/run-states.spec.ts
pnpm check
```
