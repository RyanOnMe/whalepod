# RD-03c2：在途机器 Run 的 Mandate 实时失效与工具复核验收（ADR-0028 §9）

- 对应场景/门禁：Q0 / Q2 / Q3
- 对应 Issue：#511（母 #486；前置 RD-03a #505、RD-03b #507、RD-03c1 #509）
- 上次验证：2026-11-04 · 分支 `feat/p1-511-rd03c2-live-mandate-invalidation` · PASS

本切片边界：Mandate 暂停/撤销/到期/版本漂移/Work 不可用时，已进入 `running`/`waiting_approval` 的机器 Run 不自动杀死，而是固化失效事实并向 Node/Runtime 下发实时信号；Runtime 此后每次工具调用只放行读/收尾步骤。私有草稿受众扩展、cost/token 账本、自动杀 Run/回滚副作用、`apps/web` 未做。

## 1 验的是哪条用户路径

Task 责任人：

1. RD-03a/03b 已派工出机器 Run，Runtime 报 `runtime.ready` 后 Run 进入 `running`；
2. 责任人 `POST /mandates/:id/pause|revoke`，或 Mandate 到期被 10s 维护循环发现，或 Work/Task 不再可执行；
3. Hub：
   - `queued`/`dispatching` 仍走既有取消；
   - `running`/`waiting_approval` 写 `run.mandate_invalidated_at/reason`，并向 Run 所属 Device 入队 `run.mandate_invalidated`（同事务、幂等、不改变 Run 状态）；
   - `GET /runs/:id` 暴露 `mandateInvalidatedAt/Reason`；
4. Node：重复 commandId 只回放 ack；Run 已终态或 Runtime 不在只回 ack；Runtime 在管则转发 Runtime 命令；
5. Runtime：置失效标志；此后 `tools/pre-execute` 与单调 `tools.guard` 对每次调用复核：
   - 面外工具仍 deny；
   - `read`/`glob`/`grep`、`read_work_input`/`read_project_context`、`publish_artifact` 放行；文件读仍受 RD-03c1 路径硬边界；
   - `write`/`edit` 及其他面内步骤直接 deny，不再 ask；已 pending 的审批即使 `allowed_once` 也不能执行写；
6. Run 是否停止仍由 owner 走既有取消；已发生的工具副作用不回滚、不伪装撤销。

## 2 驱动与证据

- Hub：生产 HTTP（mandate pause/revoke/新建版本）+ `reconcileMandateInvalidation` 周期清扫；DB `run.mandate_invalidated_*`、`dispatch_outbox(type=run.mandate_invalidated)`；`RunView` 读面。
- Node：`RunStartSchema`/`NodeDownstreamSchema` 解析后 `handleFrame`；单测断言转发、重复 ack、终态 ack-only。
- Runtime：`machineDraftToolDecision` 增加失效分支（纯裁决）；`mandate-invalidation.contract.spec.ts` 真 boot/replay + 真 fs 工具：
  - allowlist 内 `write` 失效后 deny、文件不落盘、零审批；
  - 未 allowlist 的范围内 `read` 失效后仍 allow；
  - 先产生 `approval.requested`，失效后 `allowed_once` 仍不能执行 write。
- 判据文件：
  - `apps/hub/tests/work-dispatch.integration.spec.ts`（running pause、到期清扫、幂等、reason 纯映射）
  - `apps/node/tests/run-manager.spec.ts`（转发/重复/终态）
  - `packages/runtime-dsh/tests/tool-policy.spec.ts`（失效后读写分支）
  - `packages/runtime-dsh/tests/dsh-contract/mandate-invalidation.contract.spec.ts`（3）
  - protocol fixtures：`run.mandate_invalidated`（node-downstream/runtime-command）
- 观测：Hub `component=hub.dispatch action=work.dispatch.mandate_invalidated`（invalidated/failed 计数）；Node `component=node.run_manager`（转发/ack-only）；Runtime `component=runtime.bridge`（失效原因）；DB 标记与 outbox。均不含正文/路径/凭据。

## 3 判定

- **正控**：running Run 在 pause 后仍 `running`、标记 `mandate_paused`、恰好一条 outbox 命令、RunView 可读；到期清扫标记 `mandate_expired`；失效后 `read`/`publish_artifact` 仍可用。
- **负控**：失效后 `write`/`edit` deny 且不落盘、不产生审批；pending approval `allowed_once` 不能复活写；重复失效命令/重复清扫不产生第二条命令；终态 Run 不被标记/复活；Node 不在时不 spawn；人类 Run 不受扫描（`origin='mandate'` 过滤）。
- **数据判据**：`RunToolPolicy`/`MandateInvalidationReason` strict schema；`run_mandate_invalidation_fields` 约束两列同生同灭；`beforeDispatch` 既有机器 Run 复核不变。

## 4 门禁

| 门 | 命令 | 结果（2026-11-04） |
|---|---|---|
| Q0 | `pnpm check` | 223 文件 / 2432 项通过 |
| Q2 | `pnpm test:integration` | 90 文件 / 878 项通过（`work-dispatch` 54 项） |
| Q3 | `pnpm test:dsh-contract` | 24 文件 / 98 项通过（mandate invalidation +3） |

## 5 单点变异

| # | 判据 | 变异 | 实测 |
|---|---|---|---|
| M64 | 失效后写 deny | 失效分支条件反转（失效时不进分支） | 红（write 继续 allow） |
| M65 | 失效后只读/收尾 allow | 失效分支只允许 implicit、不给 read | 红（范围内 read 被 deny） |
| M66 | 暂停时标记 running Run | 删除 cancelInvalidated 的 running 失效循环 | 红（无标记/无 outbox） |
| M67 | 到期清扫 | 清扫直接 return 0 | 红（过期 Run 无标记） |
| M68 | Node 转发失效命令 | handleFrame 不转发只 ack | 红（Runtime 收不到） |
| M69 | 单调 guard 也带失效标志 | guard 调用不传 reason | 红（pending approval 后 write 落盘） |
| M70 | 标记幂等 | 去掉 mark 的 `mandateInvalidatedAt is null` 条件 | 红（重复清扫入队第二条） |

## 6 边界与未交付

- 私有草稿受众扩展（`draftRecipientUserId` 跨成员/多 Agent 中间产物）→ RD-03c3。
- cost/token 账本与硬额度：当前无 usage 回传；`maxRunsPerWork`/`maxAttempts` 只在派发前拦新增，不实时扫在途 Run。
- 已执行 Run 不自动杀死、副作用不回滚；owner 只能走既有取消。失效通知落在 RunView/结构化日志，不改 `apps/web`。
- Node 本地来源权限实时撤权（ADR-0024 链路）不在本切片；本切片只处理机器 Run 的 Mandate 失效。
- Mandate 到期清扫周期沿用 10s 维护循环；进程停机期间到期只能在下次启动/下一 tick 生效。
- 失效信号只保证「下一次工具调用前」送达（至少一次 outbox）；已发出但尚未执行的工具调用按 Node/Runtime 到达顺序处理，不回滚已发生副作用。

## 7 复跑

```bash
pnpm check
pnpm test:integration
pnpm test:dsh-contract
```
