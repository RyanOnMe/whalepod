# PC-05b-1：Run 上下文撤权状态机与状态同步验收（ADR-0027 §6）

- 对应场景/门禁：Q0 / Q2 / Q3 / Q6 / Q7；ADR-0027 §6 撤权与断连
- 对应 Issue：#498（父 #497；RD-03 #486 的真实执行前置）
- 上次验证：2026-11-03 · `feat/pc-05b-1-context-state` · PASS
- 关联：[ADR-0027](../adr/0027-run-project-context-snapshot-and-consumption.md)、[PC-05a 验收](./run-project-context-acceptance.md)

## 1 本切片交付

| 面 | 实现 | 判据 |
|---|---|---|
| 状态派生 | `apps/hub/src/modules/context/state.ts` | 业务条目按 `context_entry` 当前有效性/纠正派生；来源条目按 `project_source.status`、`permissionState`、`permissionExpiresAt`、generation 倒退派生；撤回条目不会因来源恢复而复活；成员读面（含终态历史）每次按当前事实重新派生，不信任上次 tick 落库 |
| 状态版本 | migration `0030`/`0031`/`0032`；`run_project_context.state_version/state_digest` | 首次派生从 1 开始；条目、聚合状态或**逐条代次**导致摘要变化才递增；`stateDigest = sha256(规范化 {stateVersion, 排序后的 entryId/state/currentAuthorizationGeneration})`；reason 不参与摘要；摘要与同帧 entries 必须可复算 |
| 完整状态帧 | `run.context_state`（含 commandId） | 创建事务、纠正事务、周期变化与重连时下发；载荷只有 id/kind/状态/代次/原因，无正文与路径；Decision 只允许 frozen/retracted/unavailable 且代次为 null |
| 水位帧 | `context.state_sync`（含 commandId） | 活跃快照每 20 秒节流下发；无变化也发；不直接应用 entries |
| 拉取 | Node → Hub `context.state_pull` | 摘要不一致/本地缺失时请求完整状态；Hub 校验设备与 Run 归属后重发 |
| 应用回执 | Node → Hub `context.state_ack`；`run_context_state_ack` | 状态文件写入与未读副本清理尝试完成后回报；记录版本/摘要/失败条目；同版本清理恢复回执覆盖旧失败集合 |
| Node 应用 | `apps/node/src/context/state.ts`、`state-store.ts` | 持久化状态与 delivered/read 集合；删除 `readAt=0` 的受影响副本；删除失败移入 `runtime-home/<runId>/quarantine/`；移动也失败则 paused + 每小时重试；单 Run 状态帧与清理 drain 串行化，`state.json` 单调写；预启动撤权在 `run.start` 下载后补清理；pause 记录原因，drain 只解除 cleanup pause |
| Runtime 读门 | `packages/runtime-dsh/src/project-context-tool.ts` | 每次读取先读 `state.json`；缺失/超过 60 秒/`paused`/条目非 frozen 一律不可用，不回退旧缓存 |
| 派发/下载门 | `verifyRunProjectContext`、`buildRunProjectContextBundle` | 派发前与下载前按当前事实重新派生；任一非 frozen → `CONTEXT_UNAVAILABLE`（HTTP 409） |
| 重连 | `node.hello` → `onDeviceHello` | 完整当前状态立即入队，不只增量 |
| 初始状态 | `run.start` 下载完成后 | 写 `state.json`（全部 frozen、stateVersion=0），Hub 完整状态到达后覆盖；若撤权先到，则初始化时删除未读副本 |
| 能力协商 | `project-context.v1` + `context-state.v1` | 非空快照的 Run 必须同时声明两者；升级顺序先 Hub 后 Node（旧 Hub 会拒绝新 Node 的 hello 能力串）；旧 Node 仍可连接，但不会再收到新创建的带上下文 Run |

## 2 驱动与证据

全部走生产装配：Hub 创建事务/纠正事务/Node hello/上行帧；Node 走真实 SQLite 状态库与文件系统；Runtime 走真实 `read_project_context` 工具；Q3 走真 DSH boot 栈。

主要判据文件：

- `apps/hub/tests/context-state-rules.spec.ts`：派生规则分支（业务纠正/缺失、来源 revoked/paused/unavailable/unknown/denied/expired/generation 倒退、来源恢复不复活纠正条目）。
- `apps/hub/tests/context-state-boundaries.spec.ts`：下载前先派生、派发前复核、Runtime 先读状态文件、只删未读副本。
- `apps/hub/tests/run-project-context.integration.spec.ts`：创建即写 stateVersion=1 的 `run.context_state`；纠正后入口 `retracted`、stateVersion=2 并再下发；终态 Run 的历史读面在纠正后不再返回正文；仅来源代次变化也推进 stateVersion 且帧摘要可复算；`context.state_ack` 落库；`context.state_pull` 重发完整状态；状态帧带 commandId 可由 fake Node ack；只声明 `project-context.v1` 的旧 Node 被拒绝。
- `apps/node/tests/run-manager.spec.ts`：初始 `state.json`；撤权删除未读副本并 ack；已读副本保留；撤权先于 `run.start` 到达时，初始化阶段补删副本；旧版本/冲突帧拒绝且不降级已应用状态；删除+隔离双重失败 → paused + `failedEntryIds`；摘要不符拒收并 ack false；心跳摘要不符发 pull、一致不发。
- `apps/node/tests/context-state-store.spec.ts`：SQLite 跨重启保留状态/delivered/read；旧版本不覆盖；清理队列 due/退避；内存实现与 SQLite 语义一致。
- `apps/node/tests/context-state-apply.spec.ts`：来源代次倒退拒收并 pause；同代次/新代次接受；`source_missing` 的 null 代次撤权帧仍可应用；同帧一条代次倒退时仍删除其他撤权副本。
- `apps/node/tests/context-state-cleanup.spec.ts`：清理重试复核当前状态/已读集合；恢复 frozen 后不删；已读不删；无 prepared 时保留 pending；旧版本不覆盖更新的 `state.json`。
- `packages/runtime-dsh/tests/project-context-tool.spec.ts`：状态缺失/`paused`/过期/条目撤权四类 fail-closed；恢复 fresh 状态后可读。
- `packages/protocol/tests/run-context.spec.ts`：六态枚举、摘要规范化（排序/版本/状态/代次，忽略 reason）、Decision 携带代次/来源状态被 schema 拒绝、完整状态/水位/ack/本地状态文件形状。
- `packages/runtime-dsh/tests/dsh-contract/tool-boundary.contract.spec.ts`：真 DSH boot 下状态文件就位时正文/字段进入下次模型请求。

## 3 门禁

| 门 | 命令 | 结果（2026-11-03） |
|---|---|---|
| Q0 | `pnpm check` | 220 个测试文件、2359 项通过（含 typecheck / boundaries / protocol generated / web） |
| Q2 | `pnpm test:integration` | 88 个文件、808 项通过（真实一次性 PostgreSQL） |
| Q3 | `pnpm test:dsh-contract` | 21 个文件、86 项通过（真 boot 栈 + replay） |
| Q6 | `pnpm test:resilience` | 6 个文件、34 项通过 |
| Q7 | `pnpm test:security` | 4 个文件、18 项通过；secret-scan 自检与实扫 OK；license 626 包 OK |

## 4 负控与单点变异

每次只改一处，跑对应判据确认变红，再恢复并用 `git diff` 核对无残留。

| # | 判据 | 变异（单点） | 预期 | 实测 |
|---|---|---|---|---|
| M1 | 来源撤销 → `source_tombstoned` | `deriveEntryState` 的 revoked 分支返回 frozen | 派生规则用例红 | 红（`context-state-rules`） |
| M2 | 完整状态摘要必须可复算 | Node `applyRunContextState` 摘要比较改 `false &&` | 摘要不符必须拒收 | 红（`run-manager` digest 用例） |
| M3 | 状态文件 `paused` 必须 fail-closed | Runtime 工具 `if (false && localState.paused)` | 暂停态读取必须拒绝 | 红（`project-context-tool`） |
| M4 | 状态超 60 秒必须 fail-closed | Runtime 工具 stale 比较改 `false &&` | 过期态读取必须拒绝 | 红（`project-context-tool`） |
| M5 | 非 frozen 条目必须拒绝 | Runtime 工具状态判断只留 `current === undefined` | 撤权条目读取必须拒绝 | 红（`project-context-tool`） |
| M6 | 只删未读副本 | Node 去掉 `read.has(entryId)` 守卫 | 已读副本必须保留 | 红（`run-manager` 已读保留用例） |
| M7 | 来源代次不得倒退 | Node 去掉 `if (regressed)` 分支 | 旧代次 frozen 必须拒收 | 红（`context-state-apply`） |
| M8 | 创建事务下发首版状态 | 去掉 `enqueueRunContextState` 调用 | 必须存在 stateVersion=1 状态命令 | 红（`run-project-context`） |
| M9 | 纠正事务更新活跃快照 | 去掉 `refreshRunContextStateForEntry` 调用 | 入口 retracted + stateVersion=2 | 红（`run-project-context`） |
| M10 | 心跳摘要不一致要拉取 | Node `if (false && result.pull)` | 必须发 `context.state_pull` | 红（`run-manager` 心跳用例） |
| M11 | 派发前状态复核 | `verifyRunProjectContext` 去掉 `verifyRunContextStateFrozen` 调用 | 边界判据必须红 | 红（`context-state-boundaries`） |
| M12 | 终态历史读面按当前事实派生 | `buildRunProjectContextView` 改回读持久化 `entryStatus/status` | 终态纠正后正文必须不可读 | 红（`run-project-context` 历史读面用例） |
| M13 | 仅代次变化也推进 stateVersion | `digestChanged` 固定为 `false` | 代次刷新必须 changed=1 | 红（`run-project-context` 代次用例） |
| M14 | Decision 不接受来源状态/代次 | 去掉 schema 的 Decision 来源状态分支 | 协议负控必须红 | 红（`run-context` Decision 用例） |
| M15 | 非空快照要求 `context-state.v1` | 去掉 `assertProjectContextCapability` 的第二能力检查 | 旧状态机 Node 必须 409 | 红（`run-project-context` 能力用例） |
| M16 | 预启动撤权补清理 | `initializePreparedContextState` 的清理结果改为空 | `run.start` 后撤权副本必须不存在 | 红（`run-manager` 预启动用例） |
| M17 | 清理重试复核状态/已读 | 去掉 drain 的 frozen/read 守卫 | 恢复/已读副本不得删除 | 红（`context-state-cleanup` 两例） |
| M18 | 冲突帧不得 ack applied | 去掉 upsert 后的版本/摘要校验 | 旧帧只能 ack 当前版本 | 红（`run-manager` 旧版本用例） |
| M19 | 代次倒退仍清理同帧撤权 | 倒退分支的清理列表改为空 | 同帧撤权副本必须删除 | 红（`context-state-apply` 兄弟撤销用例） |
| M20 | `state.json` 单调写 | 去掉写入前的版本/摘要比较 | 旧存储版本不得覆盖新文件 | 红（`context-state-cleanup` 单调写用例） |
| M21 | Runtime 状态文件必须绑定本 Run/快照 | 去掉 `expected runId/snapshotId` 比较 | 异 Run 状态文件必须被拒 | 红（`project-context-tool` 绑定用例） |
| M22 | 代次倒退的 pause 不被 drain 清除 | drain 无条件按 pending 解除 paused | 回归 pause 必须保留 | 红（`context-state-cleanup` 回归 pause 用例） |
| M23 | 预启动复用状态也过代次闸 | 去掉 `initializePreparedContextState` 的 generation 检查 | 复用旧代次必须 pause | 红（`context-state-apply` 初始化代次用例） |
| M24 | cleanup 重试不得覆盖代次 pause | drain 的 pending 分支无条件改写为 cleanup | 失败/成功后都必须保持 generation_regression | 红（`context-state-cleanup` 回归+重试用例） |

复跑命令：

```bash
pnpm check
pnpm test:integration
pnpm test:dsh-contract
pnpm test:resilience
pnpm test:security
```

## 5 边界与未交付

- **来源派生入口尚无生产写入方**：PC-05a 只选内部业务 Decision/Observation；Thread/WorkLink、来源 Observation、外部来源正文仍属 PC-03b/03c。本切片的来源撤权分支有规则级与 Node 应用级判据，但没有真实来源条目端到端生产链。代次刷新用例把快照条目的来源字段作为测试夹具替换，明确不是生产写入路径。
- **周期同步窗口**：来源变化由 10 秒 tick 落库并下发，撤销到 Node 应用的传播窗口受 20 秒水位与 60 秒 fail-closed 上限约束；不承诺瞬时。终态 Run 不再接收状态帧，历史读面按当前事实派生以保证正文不可读。
- **能力升级顺序**：带非空上下文的 Run 同时要求 `project-context.v1` 与 `context-state.v1`。必须先升级 Hub 再升级 Node：旧 Hub 的 hello schema 不认识 `context-state.v1`，新 Node 会被 4003 断开；Hub 升级后旧 Node 仍可连接，但新的带上下文 Run 不会被派发。**升级前已存在的活跃上下文 Run 在旧 Node 上不受撤权状态机保护**（旧 Node 静默丢弃新帧且读工具无状态门），运维上应在升级前排空/取消这些 Run，或明确接受该窗口；旧 Run 的未 ack 状态命令会保留到其终态。
- **已读副本不删**：按 ADR-0027 §6，`readAt=1` 的副本保留；模型已读内容不收回。清理重试在删除前重新检查当前状态与已读集合，恢复或已读后不会误删。
- **通用工具读边界**：活跃期 `tool-bash`/`tool-fs` 仍可读取 session/spill 中的正文；本切片只保证「不再经专用读工具交付正文 + 未读副本删除」，不承诺活跃期通用工具读隔离。
- **首条回执 watchdog、断线回执重放、终态 session 清理与 `resumeContext`**：PC-05b-2/-3（#499/#500），未交付。
- **`apps/web`**：未改动；成员读面走 Hub 的 `GET /runs/:runId/project-context`，状态原因通过 `entryStatus/statusReason` 暴露。
- **Hub 快照正文**：按 ADR-0024 §8 保留，不在本切片物理清除。
- **ADR 修订**：2026-11-03 在 ADR-0027 §7 增补实施修订，明确六态持久化、完整状态帧覆盖全部条目（Decision 受限）与 `context-state.v1` 能力；原「状态帧只允许 source 条目/单 state 拆帧」的草图废止。

## 6 证据边界

- 状态帧与日志只含不透明 id、状态、版本、计数与原因码；不含正文、digest 原文、绝对路径或凭据。
- Node 的 `state.json` 在 `runtime-context/<runId>` 内，文件名固定、内容无正文；拒绝消息不回显目录。
- 回执是受信 Node 的自报证据；Hub 不防恶意 Node。
