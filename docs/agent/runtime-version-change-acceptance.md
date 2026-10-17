# 换版归因验收（RUNTIME_VERSION_CHANGED，#356）

- 对应场景/门禁：Q6（故障门，`pnpm test:resilience`）——R9 的归因分支；Q1（单测：supervisor 判定）
- 对应 Issue：#356（#290 回滚演练评审的发现）
- 上次验证：2026-10-16 · `feat/p1-356-runtime-version-changed` · 结果 PASS

## 验的是哪条用户路径

运维按 `.agents/skills/dsh-upgrade` 的流程**回滚（或升级）本机 DSH**：停 Node → 换版 →
起 Node。此刻新版本下**正在跑的 Runtime 不会被恢复**（回滚语义），用户要在界面上分清两件事：

1. 「Runtime 丢了」——机器崩了/断线/进程被杀（既有 `RUNTIME_LOST`，走后一条路：Hub 的租约
   过期 reconciler）；
2. 「是这次**换版**搞的」——同一个 Run 在版本换掉之后自然不会恢复，要显式重跑。

修复前两者都报 `RUNTIME_LOST`（skill 里承诺的专用码全仓无实现），用户与排障都无法区分。

## 驱动（怎么触发）

```bash
# 判定面一（supervisor 判定 + 全链上行帧）：
pnpm exec tsx scripts/with-test-postgres.mts vitest run --project resilience \
  apps/node/tests/resilience/node-restart-orphan.spec.ts \
  apps/hub/tests/resilience/run-lease-resilience.spec.ts
# 判定面二（版本比对与补列的单元判据；Q1）：
pnpm exec vitest run --project unit apps/node/tests/recovery.spec.ts
```

驱动与真人流程同形：Run 在版本 A 下正常起（真 Runtime 子进程 + 真 supervisor 状态库）→
「Node 崩溃」（释放句柄、不 stopAll）→ 换版后重启（新 supervisor 打开同一批状态文件，版本 B）
→ `recoverOrphans()` → `onReconnect()` flush lost 快照。**Hub 侧**用既有 R9 用例的注入面
（`ingestNodeEvent` + 快照帧）判落库。

## 观测（看什么）

- **supervisor 的 lost 事实**：`RuntimeLostEvent.reason`
  （`version_changed_after_node_restart` / `orphaned_after_node_restart` / `runtime_timeout`）；
- **spool 上行的 `run.snapshot` 帧**：`payload.failureCode` 与 `failureSummary`（断连期缓冲、
  重连 flush，与 R1 同纪律）；
- **Hub 落库**：`runs.status='lost'` + `runs.failure_code`（Hub **原样**落 Node 的归因码）；
- **本地状态库**：`active_runtime.dsh_version`（spawn 时记录的探针版本）。

## 判定（成功长什么样）

实现（三处）：

1. `packages/protocol/src/errors.ts`：ErrorCode 目录新增 `RUNTIME_VERSION_CHANGED`（03 §10 同步，
   生成的 JSON Schema 重新生成——`pnpm check:protocol-generated` 把关）；
2. `apps/node/src/supervisor/runtime-supervisor.ts`：spawn 时把探针版本写进
   `active_runtime.dsh_version`（**旧状态库补列**：`create table if not exists` 不改既有表，故
   显式 `pragma table_info` + `alter table`）；`recoverOrphans` 对每个孤儿比对「记录版本 vs
   本次启动版本」，**两侧都已知且不一致**才报 `version_changed_after_node_restart`（任一未知
   退回通用归因——不谎报换版）；
3. `apps/node/src/run/run-manager.ts`：reason → 终态码映射（`lost` +
   `RUNTIME_VERSION_CHANGED`，摘要说明版本变了、Runtime 不恢复），lost 快照带上同一个码
   （`finalizeRun` 与快照同源，不再一处 `RUNTIME_LOST` 一处新码）。

判据（全部实测；两条关键路径各做过单点变异自证）：

| 面 | 用例 | 断言要点 | 变异自证 |
|---|---|---|---|
| Q1 判定 | `apps/node/tests/recovery.spec.ts`（4 例新增） | ① 版本不同 → `version_changed_after_node_restart`（且孤儿仍按三重匹配被杀）；② 版本相同 → 通用归因（**负控**：不许把普通重启谎报成换版）；③ 任一侧未知（未记 / 本次不可知）→ 通用归因（两个负控）；④ **旧状态库**（本列引入前的 DDL）→ 打开即补列、恢复流程照常、不谎报 | 判定函数改成恒 false → ① 红（其余负控仍绿，说明只有正例依赖该判定） |
| Q6 全链 | `apps/node/tests/resilience/node-restart-orphan.spec.ts` 新增一例 | 版本 A 起 Run → 崩溃 → 版本 B 重启 → `recoverOrphans` → 离线期快照只缓冲、重连 flush 出一帧 `run.snapshot(lost, failureCode=RUNTIME_VERSION_CHANGED)`、摘要含 `version changed`；随后重发 `run.start` 不 spawn 第二 Runtime（与 R9 同纪律） | RunManager 的映射降级成 `RUNTIME_LOST` → 该例红 |
| Q6 Hub 侧 | `apps/hub/tests/resilience/run-lease-resilience.spec.ts` 新增一例 | 快照带专用码 → `runs.failure_code` **原样**是 `RUNTIME_VERSION_CHANGED`（Hub 不改写）；迟到事实不复活 | —（Hub 侧无判定分支可削；判的是落库保真） |

## 归因（失败先看哪层）

| 现象 | 先看 |
|---|---|
| 换版后 Run 仍报 `RUNTIME_LOST` | `active_runtime.dsh_version` 是否有值（spawn 时注入的是**探针**结果：探针失败 → null → 按设计退回通用码）；cli 是否把 `dshVersionFacts.probed` 传给了 supervisor |
| 普通重启被报成换版 | `dshVersionChangedSince` 的「两侧都已知」条件是否被放松（负控用例会红） |
| 旧状态库打开即崩 | 补列逻辑（`pragma table_info` + `alter table`）是否被绕过——旧 DDL 建的库用例会红 |
| 快照没上行 | 与 R9 同因：断连期只缓冲，看 Node 是否重连（`onReconnect` flush） |

## 取证

```bash
git log --oneline -1
pnpm exec vitest run --project unit apps/node/tests/recovery.spec.ts
```

本地状态库（含 `dsh_version` 列）在 `<stateDir>/supervisor.sqlite`；快照帧与摘要进 Hub 的
`runs.failure_summary`（owner 可见，脱敏纪律照旧）。

## 边界与未覆盖

- **判定依赖探针两侧都已知**：探针失败（旧 dist / 慢盘）时该 Run 报通用码——有意 fail-honest
  （宁可不报换版，也不谎报）；这是「版本不可知」的既有代价面（见 dsh-compat-guard 的边界节）。
- **不区分方向**：升级与回滚共用这一条检测（两者都停下 Node 换版），码名与摘要都说「版本变了」
  而不说「回滚」——通用码不会为升级方向说谎。
- **Hub 侧的租约过期路径仍是 `RUNTIME_LOST`**（reconciler）：那条路只有「沉默超时」一个事实，
  它**看不出**是不是换版（版本比对只在 Node 本地成立）。因此「Node 已经不在、Hub 先判 lost」的
  时序下用户看到的仍是通用码——如实记账，不假装覆盖。
- **真实换版演练仍是人工门**：本判据用的是「同一 supervisor 状态文件 + 不同版本参数」，真实
  「装另一版 DSH → 触发 → 回滚安装树」的步骤与预期输出在 skill 的回滚节（#290 的人工门）。
- **UI 文案**：界面沿用「失败码 + 摘要」的既有呈现（无码→中文映射表），本 PR 未加专用文案——
  用户可见的最小区分是码本身与摘要里的 `version changed`。
- 未做：把版本换成「回滚到位但探针报同一个 prerelease 串」的形态（版本串相同则本机制按设计
  不报换版；那属于版本锁问题，Q3 的 lock-drift/回滚演练覆盖）。

## 复跑

```bash
pnpm exec vitest run --project unit apps/node/tests/recovery.spec.ts
pnpm exec tsx scripts/with-test-postgres.mts vitest run --project resilience \
  apps/node/tests/resilience/node-restart-orphan.spec.ts \
  apps/hub/tests/resilience/run-lease-resilience.spec.ts
```
