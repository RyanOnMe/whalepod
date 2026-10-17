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
2. `apps/node/src/supervisor/runtime-supervisor.ts`：spawn 时把**本进程启动探针**的版本写进
   `active_runtime.dsh_version`（**旧状态库补列**：`create table if not exists` 不改既有表，故
   显式 `pragma table_info` + `alter table`，并容忍并发首开时后到者的 duplicate column）；
   `recoverOrphans` 对每个孤儿比对「记录版本 vs 本次启动版本」，**孤儿当时仍存活（三重匹配
   matched）且两侧版本都是字符串且不一致**才报 `version_changed_after_node_restart`——早已 dead
   的行报通用码（Run 死于那次崩溃，换版是事后的事）；任一版本未知也退回通用归因（不谎报）。
3. `apps/node/src/run/run-manager.ts`：reason → 终态码映射（`lost` +
   `RUNTIME_VERSION_CHANGED`，摘要说明版本变了、Runtime 不恢复），lost 快照带上同一个码
   （`finalizeRun` 与快照同源，不再一处 `RUNTIME_LOST` 一处新码）。

判据（全部实测；两条关键路径各做过单点变异自证）：

| 面 | 用例 | 断言要点 | 变异自证 |
|---|---|---|---|
| Q1 判定 | `apps/node/tests/recovery.spec.ts`（6 例新增） | ① 版本不同 → `version_changed_after_node_restart`（且孤儿仍按三重匹配被杀）；② 版本相同 → 通用归因（**负控**：不许把普通重启谎报成换版）；③ 任一侧未知（未注入 / **`null`——cli 传的正是 probed**）→ 通用归因（两个负控）；④ **旧状态库**（本列引入前的 DDL）→ 打开后 `pragma table_info` 确含 `dsh_version`、恢复流程照常、不谎报；⑤ **真死 pid 的孤儿（probe 判 `dead`）+ 版本不同** → 仍是通用归因；⑥ **旧状态库上直接 spawn**（`start()` 的 INSERT 点名列）→ 补列使其可用且记下的版本正确 | 判定函数恒 false → ① 红；去掉 `matched` 闸 → ⑤ 红；**补列被绕过（`alter` 换成 no-op）→ ④（pragma 断言）与 ⑥（`no column named dsh_version`）双红**；union 加第 4 个 reason → `never` 守卫使 tsc 报错（归因链的穷尽性） |
| Q6 全链 | `apps/node/tests/resilience/node-restart-orphan.spec.ts` 新增一例 | 版本 A 起 Run → 崩溃 → 版本 B 重启 → `recoverOrphans` → 离线期**尝试**上行 1 次而线上 0 帧（harness 的离线丢帧）、重连 flush 出 1 帧 `run.snapshot(lost, failureCode=RUNTIME_VERSION_CHANGED)`、摘要含 `version changed`；随后重发 `run.start` 不 spawn 第二 Runtime（**spawn 计数取自本段自己的 driver**） | RunManager 的映射降级成 `RUNTIME_LOST` → 该例红；**判据敏感性双证**：向本段 `pids2` 注入一次假 spawn → 红（`expected 1 to be +0`），向第一段的 `pids` 注入同样的假 spawn → **仍绿**（旧写法读错数组，恒真） |
| Q6 Hub 侧 | `apps/hub/tests/resilience/run-lease-resilience.spec.ts` 新增一例 | 快照带专用码 → `runs.failure_code` **原样**是 `RUNTIME_VERSION_CHANGED`（Hub 不改写）；迟到事实不复活 | —（Hub 侧无判定分支可削；判的是落库保真） |

## 归因（失败先看哪层）

| 现象 | 先看 |
|---|---|
| 换版后 Run 仍报 `RUNTIME_LOST` | 先分辨是哪条路：**Hub 租约过期**（停机超过租约的主流形态，看不出换版——见边界节）还是 **Node 孤儿恢复**；后者看 `RECOVER_VERDICT` 那行 stderr（带 `recorded=`/`current=` 两个版本串）与 `active_runtime.dsh_version`（记录行随后即删）；cli 是否把 `dshVersionFacts.probed` 传给了 supervisor |
| 普通重启被报成换版 | `dshVersionChangedSince` 的「两侧都是字符串」条件是否被放松（负控用例会红） |
| 旧状态库打开即崩 | 补列逻辑（`pragma table_info` + `alter table`）是否被绕过——旧 DDL 建的库用例（④ 的 `pragma` 断言与 ⑥ 的 spawn）会红 |
| 两条路都排除后仍报通用码 | `probeOrphan` 的判决：早已 dead / mismatch 的孤儿按设计报通用码（⑤ 覆盖 dead 形态；mismatch 形态见既有 nonce 篡改用例） |
| 快照没上行 | 与 R9 同因：断连期只缓冲，看 Node 是否重连（`onReconnect` flush） |

## 取证

```bash
git log --oneline -1
pnpm exec vitest run --project unit apps/node/tests/recovery.spec.ts
```

本地状态库（含 `dsh_version` 列）在 `<stateDir>/supervisor.sqlite`；快照帧与摘要进 Hub 的
`runs.failure_summary`（owner 可见，脱敏纪律照旧）。

## 边界与未覆盖

- **判定依赖探针两侧都是字符串**：探针失败（旧 dist / 慢盘）时该 Run 报通用码——有意 fail-honest
  （宁可不报换版，也不谎报）；这是「版本不可知」的既有代价面（见 dsh-compat-guard 的边界节）。
- **不区分方向**：升级与回滚共用这一条检测（两者都停下 Node 换版），码名与摘要都说「版本变了」
  而不说「回滚」——通用码不会为升级方向说谎。
- **Hub 侧的租约过期路径仍是 `RUNTIME_LOST`**（reconciler，心跳 10s/租约 30s/每 10s 一拍），
  它只有「沉默超时」一个事实，看不出是不是换版。**边界不是「<30s 必然可见」而是「秒级大概率、
  分钟级必不可能」**：真正的自变量是「距 Hub 最后一次收到该设备帧的时长」（心跳 10s 一拍 ⇒
  停机时刻比它早 0–10s）再加 reconciler 的 0–10s 量子，约 20s 的停机就可能输给 `RUNTIME_LOST`、
  35s 也可能赢；而且**孤儿必须活过这次 Node 重启**（整容器重建/机器重启会把 Runtime 一起杀掉
  → probe 判 dead → 通用码，见 ⑤）。**这不是罕见时序，而是文档化流程下的主流**：
  skill 的人工门回滚是「停 Node → `git checkout` → `pnpm install` → `pnpm -r build` → 起
  Node」，停机分钟级 ⟹ Hub 几乎必然先落 `lost(RUNTIME_LOST)`，Node 回来后带专用码的迟到快照
  被终态幂等丢掉。**专用码只在停机 <30s（例如换镜像快速重启）时直接对用户可见**——如实记账；
  「让 Hub 在重连/hello 时对已 lost 的 Run 收敛 `failure_code`（status 不动）」另立账（#368）。
- **真实换版演练仍是人工门**：本判据用的是「同一 supervisor 状态文件 + 不同版本参数」，真实
  「装另一版 DSH → 触发 → 回滚安装树」的步骤与预期输出在 skill 的回滚节（#290 的人工门）。
- **跨版本 resume 未看管**（相邻问题，另立账 #370）：resume 的四重守卫不含版本，回滚后对既有
  Run 点「接着上次聊」要么前向可读、要么在装载身份处硬失败（响亮但没有「是回滚搞的」归因）。
  skill 的人工门只覆盖「对既有 Workspace 起新 Run」，不含 session resume。
- **UI 文案（显式决定：本轮不加）**：事实是 web 只渲染**裸码**（`RunFailureNotice` 显示
  `Run 异常结束（RUNTIME_VERSION_CHANGED）`），既不渲染 `failureSummary`，也没有任何
  「码 → 中文」映射表（对既有 `RUNTIME_LOST` 同样如此）。所以用户此刻能拿到的区分是**码本身**
  （与既有码同等呈现，不是更差）；给它（以及既有失败码）加一句人话文案另立账（#369）。
- **版本比对的未知面用 `typeof` 一刀切**：`dshVersionChangedSince` 要求两侧都是**字符串**
  （不是「非 null」）——列缺失时 node:sqlite 读成 `undefined`，只挡 null 会把 undefined 判成
  「版本变了」（恰是本码要消灭的谎报）。该形态在补列之后不可达，属防御性写法（补列被误删时
  fail-honest 而不是误报）。
- **「Node 不重启、就地换版」不在本机制的视野里**（违反流程但物理可能）：Runtime 继续以内存中的
  旧代码跑（无检测）；它崩溃/退出走 exit-classifier 的通用归因，换版事实不进账。且
  supervisor 记的是**上次启动的探针值**，#352 起 `node.hello` 却按连接重探——两处口径不同是
  有意的（前者是 Run 的 spawn 事实，后者是设备视图），但就地换版会让 spawn 写入陈旧值。
- 未做：把版本换成「回滚到位但探针报同一个 prerelease 串」的形态（版本串相同则本机制按设计
  不报换版；那属于版本锁问题，Q3 的 lock-drift/回滚演练覆盖）。

## 复跑

```bash
pnpm exec vitest run --project unit apps/node/tests/recovery.spec.ts
pnpm exec tsx scripts/with-test-postgres.mts vitest run --project resilience \
  apps/node/tests/resilience/node-restart-orphan.spec.ts \
  apps/hub/tests/resilience/run-lease-resilience.spec.ts
```
