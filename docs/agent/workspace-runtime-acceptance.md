# Workspace Registry 与 Runtime Supervisor 验收

- 对应场景/门禁：G3-04..06、R5/R8 前置；Q0/Q2（Q4 Node 门随本 Issue 起生效的种子）
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
- 环境 scrub：子进程 env 仅 PATH/locale/TMPDIR + <PROVIDER>_API_KEY；凭据缺失 →
  MODEL_CREDENTIAL_UNAVAILABLE（spawn 前）；Device Token/SSH/AWS 值断言不出现在子进程 env。
- stderr tail ≤ 8KiB；超时回收 runtime_timeout；Node 重启：pid+启动时间+cmdline nonce
  三重匹配才终止进程组，nonce 被篡改 → 绝不发信号（测试直接篡改状态库验证），
  处理后上报 orphaned_after_node_restart 交人工重跑（R8，Run 终态不复活）。

## 边界与未覆盖

- DshRuntimeDriver 的 runtimeEntry 来自部署配置；真实 DSH Runtime 进程协议（stdout
  事件 schema、stdin prompt）随 P1-13/14 接线补集成。
- node.inventory 的上报时机（连接后 + 变化时）在会话层接线，P1-13 组合根落位。
- Q4 Node 门（test:node 聚合脚本）随 P1-12 收尾 PR 挂接。

## 复跑

```bash
pnpm exec vitest run --project unit workspace secret spool runtime-supervisor recovery workspace-cli
pnpm exec tsx scripts/with-test-postgres.mts vitest run --project integration device-inventory
```
