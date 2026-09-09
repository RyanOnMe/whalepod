# Workspace Registry 与 Runtime Supervisor 验收

- 对应场景/门禁：G3-04..06、R5/R8 前置；Q0/Q2（曾把本 Issue 当 Q4 门的种子；#100 裁决 Q4 退役，Node 用例归 Q1/Q2/Q6 真实执行）
- 对应 Issue：#16（P1-12）
- 上次验证：2026-08-28 · feat/p1-12-workspace-registry · 结果 PASS（Q0 575/575、Q2 178/178）

## 验的是哪条用户路径

Node 本地注册 Workspace（realpath 归一）→ inventory 上报 → Hub owner-scoped 不透明投影；
Run 启动时每 Run 一个独立 Runtime 子进程（环境白名单 + 最小凭据）；目录消失/被调包
→ WORKSPACE_UNAVAILABLE 不启动；Node 重启后无孤儿（三重匹配才发信号）。

## 驱动

- WorkspaceRegistry/SecretStore/Spool/Supervisor：单测直驱真实模块（node:sqlite 真库、
  真子进程）——apps/node/tests/{workspace-registry,path-policy,secret-store,spool,
  runtime-supervisor,recovery,workspace-cli}.spec.ts
- inventory→投影：真实 WS 上行（device-inventory.integration.spec.ts，4 例）
- CLI：workspace add/list/remove + secret set 经 runWorkspaceCommand 直驱

## 判定

- G3-04：realpath 归一注册；Hub 只见 opaque id/name/kind/capabilities/available，
  无任何路径字段（键集合断言）；owner 恒等 Device owner；同名重注册镜像替换。
- G3-05：目录删除后 supervisor.start → WORKSPACE_UNAVAILABLE，spawns=0（不启动）。
- G3-06：注册 symlink → canonical 被采用；目录被换成他处 symlink → resolve 拒绝；
  路径策略越界一律拒绝。
- 容量：第 3 个 Runtime → NODE_CAPACITY_REACHED。
- 环境 scrub：子进程 env 仅 PATH/locale/TMPDIR + <PROVIDER>_API_KEY（CREDENTIAL_ENV_OVERRIDES 真值表优先的派生兜底）；凭据缺失 →
  MODEL_CREDENTIAL_UNAVAILABLE（spawn 前）；Device Token/SSH/AWS 值断言不出现在子进程 env。
- stderr tail ≤ 8KiB；超时回收 runtime_timeout；Node 重启：pid+启动时间+cmdline nonce
  三重匹配才终止进程组，nonce 被篡改 → 绝不发信号（测试直接篡改状态库验证），
  处理后上报 orphaned_after_node_restart 交人工重跑（R8，Run 终态不复活）。

## 边界与未覆盖

- DshRuntimeDriver 的 runtimeEntry 来自部署配置；真实 DSH Runtime 进程协议（stdout
  事件 schema、stdin prompt）随 P1-13/14 接线补集成。
- node.inventory 上报：**「连接后」半边已由 #89 接线**——session 层每条连接建立
  （含重连）后发一帧，cli 注入 `WorkspaceInventory.build()`；组合根由
  `apps/node/tests/integration/cli-inventory.integration.spec.ts` 从**真 bin**
  验收（pair→workspace add→start 真人顺序 + 轮询投影直至出现）。
  **「变化时」半边仍未做**：会话存活期间 `workspace add` 不会被上报，需重启
  `node start` —— 另立 **#94**（含三个待定方向与判据），不得当作已完成。
- Q4 Node 门：**已退役（#100 裁决，随 P1-20 落地）**。`pnpm test:node` 从未建立；
  Node 侧用例一直由 Q1（unit include）、Q2（integration）、Q6（resilience）真实
  执行，聚合门只会复制覆盖、不新增判据 ⟹ 正式退役；04/AGENTS 同批改齐，编号留
  墓碑防「Q0–Q9」范围表述漂移。

## 复跑

```bash
pnpm exec vitest run --project unit workspace secret spool runtime-supervisor recovery workspace-cli
pnpm exec tsx scripts/with-test-postgres.mts vitest run --project integration device-inventory
```
