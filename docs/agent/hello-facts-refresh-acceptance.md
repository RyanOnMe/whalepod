# 设备事实（node.hello）刷新验收（#352）

- 对应场景/门禁：Q1（单测两面：模块语义 + 会话发送面）、Q2（Hub 侧投影面 + **组合根**）
- 对应 Issue：#352（#288 评审发现；原状态记在 [dsh-compat-guard-acceptance](./dsh-compat-guard-acceptance.md) 的边界节）
- 上次验证：2026-10-16 · `fix/p1-352-hello-facts-refresh` · 结果 PASS

## 验的是哪条用户路径

运维/成员打开设备视图（`GET /devices`）看「这台机器就绪了什么」：本机**装/重建了 pack**
（首次 preflight 安装，或旧 marker 因 #288 缺兼容声明被重建）或**换了 DSH 版本**之后，设备视图
必须收敛到新事实——**在不重启 Node 的前提下**（重启会掩盖问题：重启后重建连接，任何实现看起来
都对）。修复前 `node.hello` 的 facts 是 `whalepod-node start` 时算好的一份冻结对象，每次连接
（含重连）都发同一份 ⟹ 设备视图停在旧值直到运维重启进程（#352 首报）。

## 驱动（怎么触发）

```bash
# ① 模块语义（hello 事实怎么算、preflight 成功后怎么补发）
pnpm exec vitest run --project unit apps/node/tests/hello-facts.spec.ts
# ② 会话发送面（按连接重算、连接保持时补发、无活连接 no-op）
pnpm exec vitest run --project unit apps/node/tests/session.spec.ts
# ③ Hub 投影面（同一连接的第二条 hello 覆盖事实列 + 再发 device.changed）
pnpm exec tsx scripts/with-test-postgres.mts vitest run --project integration \
  apps/hub/tests/node-websocket.integration.spec.ts
# ④ 组合根（真 cli 子进程 + 真 Hub + 真 preflight 本地命中；CLI 忘了接线就红）
pnpm exec tsx scripts/with-test-postgres.mts vitest run --project integration \
  apps/node/tests/integration/cli-hello-refresh.integration.spec.ts
```

④ 走的是真人路径：`whalepod-node pair`（HTTP）→ 写 config → `workspace add`（真 registry）→
`whalepod-node start`（真子进程，HOME 重定向）→ 等 hello 落库 → **本机装 pack**（写有效 marker +
包树）→ 真人 HTTP 建 Agent/Project/Task 并起 Run（`POST /tasks/:id/runs`）→ Hub 派发 `run.start`
→ Node 的 preflight **本地命中**（零网络）→ 会话内补发 hello。

## 观测（看什么）

- **设备事实列**（`devices.dsh_distribution_version` / `plugin_pack_digests`，migration 0002；#37）：
  这是设备视图的唯一来源，也是本 Issue 的判据面；
- **Team Event 流**（`device.changed`）：Web 靠它把设备视图失效重拉（#142）；
- **cli 子进程的 stderr 尾部**：装配层告警（`node.plugin` 的探针 warn 等）随失败消息一起打印，
  归因不用猜。

## 判定（成功长什么样）

实现（`apps/node/src/gateway/hello-facts.ts` 新模块 + `session.ts` + `cli.ts` 接线）：

1. `createHelloFacts(...)` 返回**函数**：`pluginPackDigests` 每次调 `installedPackDigests` 读盘
   （marker 校验不过/空清单目录不计入）；`dshDistributionVersion` 每次重探
   （`--print-dsh-version`，与启动锚同一探针），**探针失败回落启动值**（宁可报旧值不谎报、
   不抛）；进程/平台/架构是常量；平台归类（`detectPlatformKind`）与配对上报同一口径（win32
   不丢——两份事实打架过）。
2. `session.ts`：hello 的三种纪律收在**一个** `sendHello(socket)` 里——
   ① 每条连接 open 后 `await helloFacts()` 再发帧（守卫：采集完成时该连接须仍是当前活连接且
   OPEN）；② **序号单调**：连接建立与会话内刷新可能同时在飞（探针各要一次 spawn），旧快照后到
   会把 Hub 事实列写回旧值（正是 #352 的症状本体）——只让序号 ≥ 已结算序号的采集落地；
   ③ **同连接内事实未变不发**（#94 的指纹口径：Hub 每收一条 hello 就追加一条持久化
   `device.changed`，本地命中、没动盘的 Run 不该制造这笔噪声）；换连接必须照发（那是 Hub 侧
   「设备在线」的信号面）。公开面叫 `refreshHello()`（无活连接时 no-op）。
3. `cli.ts`：`pluginPackPreflight` 包一层 `refreshHelloAfterPreflight`——`ensure` 成功后
   **非 core-empty** 才刷新（core-empty 不落盘，刷新是白跑一次探针）；`ensure` 的异常原样穿透
   （刷新失败不改变 preflight 成败）。

四条判据（全部实测绿；每条都做过单点变异自证）：

| 判据 | 断言要点 | 变异自证（改坏→红） |
|---|---|---|
| ① hello-facts 单测（6 例） | 装了才出现 / 空清单不上报 / 推理序（ensure 在前）；探针成功取新值、null 与抛错都回落启动值；平台归类四条 | 冻 **digests** 为构造时算一次 → 第 1 例红（探针例仍绿）；把整个 facts 闭包冻结 → 前两例都红 |
| ② session 单测（#352 组 5 例） | 重连时带新 digest；`refreshHello` 在**连接保持时**发新事实且恰好 +1 帧、断开后 no-op；同连接内事实未变不发而换连接照发；**旧快照后到不覆盖新快照**（两个受控 deferred）；采集失败只归因、归因回调自身抛错也不掀宿主 | 去掉序号单调守卫 → 「旧快照后到」例红；去掉同连接去重 → 去重例红；`refreshHello` 改 no-op → 刷新例红；open 时冻结 facts → 重连例红 |
| ③ Hub 集成（同连接第二条 hello） | 事实列被**覆盖**（版本换新、digests 从 `['a'×64]` 收缩成 `[]`）；每条 hello 恰好追加一条 `device.changed`（以配对那条为基线 +2） | `setDeviceHelloFacts` 改成首写为准 → 红；digests 改成并集合并 → 收缩断言红 |
| ④ 组合根集成（真 cli） | 起手 hello 的 digests 为空 → 装 pack → 起 Run（真 preflight 本地命中）→ 设备事实列出现该 digest；**cli 进程从未退出**、**Node 侧连接数恰为 1**（排掉「重连重算」这条旁路）；随后 Run 的 `failureCode` 落在 `MODEL_CREDENTIAL_UNAVAILABLE` | 摘掉 `cli.ts` 的 `refreshHelloAfterPreflight` 包装（回到 `preflight.ensure` 直连）→ 红（等满 30s 判据不成立） |

④ 的细节：Run 会以 `MODEL_CREDENTIAL_UNAVAILABLE` 被拒——本用例不配凭据槽，且**显式删掉**
子进程环境里的 `WHALEPOD_DSH_SECRET_REPLAY_DEFAULT`（SecretStore 的环境兜底会让「凭据缺失」
这个前提被外部环境悄悄推翻）。拒绝发生在 preflight **之后**、spawn **之前**，正是判据要的
窗口：不真起 Runtime，也就不留孤儿进程；用例末尾把这个命运**断言**下来（前提不成立即红，
不留「恰好没起 Runtime」的含糊）。marker 里的 `dshCompatibility` 取 hello 自报的真版本值
（同一事实源，不手抄版本号）；若探针没答上来（`unmanaged`，通常是 dist 缺失），用例以专门的
消息提前失败（fail-closed 语义下的正确行为：未知版本时兼容闸拒绝一切非 core-empty pack）。

## 归因（失败先看哪层）

| 现象 | 先看 |
|---|---|
| ④ 设备事实列一直为空 | cli stderr 尾部（用例失败消息里带）：`dsh version probe failed` = dist 不新鲜；`plugin pack local miss` = marker 没被本地命中（treeDigest 目录/兼容声明）；Run 是否真被派发（`POST /runs` 返回体、outbox 是否被驱动） |
| ③ Hub 覆盖断言红 | `apps/hub/src/modules/device/node-websocket.ts` 的 hello 分支与 `setDeviceHelloFacts`（是否变成首写为准/合并） |
| ② 刷新断言红 | `session.ts` 的 `sendHello` 三条纪律（连接守卫、序号单调、同连接去重）与 `open` 处理器的 await 顺序 |
| ① 探针回落断言红 | `hello-facts.ts` 的 `?? inputs.startupDshVersion` 与 catch（探针失败必须回落、不得抛） |

## 取证

```bash
git log --oneline -1                       # 对应 squash 提交
pnpm exec vitest run --project unit apps/node/tests/hello-facts.spec.ts \
  apps/node/tests/session.spec.ts
```

本链条没有独立的 evidence 包（判据全在门内、可复跑；不需要浏览器截图）。

## 边界与未覆盖

- **Q5 主闭环仍判不了这条**（如实）：E2E 的 `e2e-pack` 是 **core-empty**
  （`scripts/e2e-serve.mts` 的种子行：空 entries 与 digest 复算一致，replay overlay 走环境变量
  验收缝），preflight 对 core-empty 直接放行、**不落盘** ⟹ 设备 digests 恒为空，
  「装 pack → 刷新」在 Q5 面不可达。已在 `apps/web/tests/e2e/task-create-drive.spec.ts` 就地留
  注释说明为什么这里不加断言，并把判据落在 Q2 的组合根用例（④）。**代价**：设备视图的
  UI 端到端呈现（浏览器上看到 digest 变化）没有机器判据，只到「Hub 行 → Web 拉取」的既有覆盖。
- **Q5/Q2 的两份 harness 仍无 preflight 装配**：`scripts/lib/phase1/chain.ts` 与
  `scripts/e2e-node.mts` 的 RunManager 不装 `pluginPackPreflight`，因此链路上「本地命中 →
  刷新 hello」的组合面只有 ④ 这一条真 cli 用例覆盖（#99/#281 的同族缺口，未在本轮扩大）。
  两份 harness 已改走 `createHelloFacts`（探针显式注入「探不到」，版本串保持 harness 的确定性
  捆定值），所以「按连接重算」的语义在 Q5 面也生效，只是 digests 恒为空。**注入探针的代价**
  如实记在这里：harness 报的 DSH 版本是捆定串而非真探针值（Q5 主闭环本就不装配兼容闸，真探针
  只会为每条连接多起一个 node 子进程、并让链路录制依赖构建产物）。
- **DSH 版本重探只覆盖 hello 事实**：兼容闸（preflight 的 `localDshVersion`）与 Node 侧
  `run.snapshot` 的固化值仍是启动时那一次探针（升级 DSH 需重启 Node——`dsh-upgrade` 流程本就
  要求重启）。**注意 Hub 侧账本的版本不是同一个来源**：建 Run 时写的
  `runs.dsh_distribution_version` 取自**设备行**（`getDeviceDshDistributionVersion`），而设备行
  正是本 PR 改成按连接重刷的列——所以升级后不重启 Node 起的那条 Run：账本记的是**新**版本，
  而该 Run 的准入（兼容闸）与 Node 侧快照仍是**旧**版本。这条口径有意保留（闸是准入、宁严勿松），
  本次未做会话内重探；说不清就直接看这两处代码，别按文档的字面推。
- **刷新的时机是 preflight 之后**：本地有人手工删 pack 目录（不经 preflight）不会触发刷新——
  下条连接的 hello 会带上真事实，或下次 preflight 重建时刷新。不为手工篡改加 watcher。
- **hello 采集会 await 探针（一次 node spawn），预算 15s**：连接建立后 `onConnected`（spool 全量
  补发）与 inventory 都排在这个 await 之后，所以探针挂死时这条连接的首帧可能晚到 15s、甚至
  （心跳 10s 节拍先到）不是 hello——「连接后首发 hello」在**探针慢于心跳**时不成立。没有为它设
  更小预算：探针挂死本身是降级态（启动日志有 warn），而缩短预算会让版本事实在慢盘上系统性失真。
  已知代价，未加判据。
- **每次带非 core-empty pack 的 Run 都会重探一次探针**（preflight 成功后无论是否真动盘都会重算
  事实）；同一连接内事实未变时**不发帧**，所以 Hub 侧不多写 `device.changed`——但探针子进程的
  成本每次 Run 一次。要减掉它需要「ensure 是否真动盘」的回执，本轮未做。

## 复跑

```bash
pnpm -r --if-present build        # ④ 需要 apps/runtime 的 dist（真 bin 探针）与 apps/node 的 dist
pnpm exec vitest run --project unit apps/node/tests/hello-facts.spec.ts \
  apps/node/tests/session.spec.ts
pnpm exec tsx scripts/with-test-postgres.mts vitest run --project integration \
  apps/hub/tests/node-websocket.integration.spec.ts \
  apps/node/tests/integration/cli-hello-refresh.integration.spec.ts
```
