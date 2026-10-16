---
name: dsh-upgrade
description: DSH 或关键依赖的版本升级列车。任何 @deepseek-ai/* 版本变动、catalog/lockfile 升级时必须走这份。
---

# DSH 升级列车（dsh-upgrade）

DSH 是预览版，升级是高风险动作。三条红线（06 文档 §2.1）：

1. 禁止 `latest`、`next`、semver range 自动漂移。
2. 禁止业务模块直接 import DSH；只有 `packages/runtime-dsh`（和 `apps/runtime`）依赖 DSH 包。
3. 禁止把 DSH 升级混进功能、重构或批量依赖 PR。

## 步骤

1. 新建 `chore/dsh-upgrade-<from>-to-<to>` 分支与单独 Issue。
2. 读官方 release note、架构文档与受影响 package 的 README。
3. 只改 pnpm catalog、lockfile 和 `dsh.lock.json` 的 `version`/`verifiedAt`。
4. 跑 `pnpm test:dsh-contract`（Q3 十项契约探针）；失败先记录公开 interface 差异，不要先改业务。
5. 只在 `packages/runtime-dsh` 修 Adapter；业务与 UI 不随 DSH 改名。
6. 跑 Q0–Q8，比较标准 E2E 的 Team Event golden file。
7. 在一个非生产试用实例跑 Builder/Reviewer 标准闭环。注意节点侧两条 #288 语义：Node **启动时**
   探针自报本机 DSH 版本（`node apps/runtime/dist/bin.js --print-dsh-version`）、pack 的逐包
   `dshCompatibility` 与它 fail-closed 比对——升级后必须**重启 Node** 并重新构建（dist 过期会让
   探针拿不到版本，非 core-empty pack 一律被拒）；pack 若声明的是旧版本，升级会让它启动即拒，
   这是设计行为：修法是更新 pack 的 `dshCompatibility` 声明（它不进 packDigest，同一 packDigest 可带
   新声明重新发布；设备本地 marker 里的旧声明不被信任，会重拉 descriptor 复核），别改闸。
8. 合并后保留上一版 runtime image 与 lockfile 至少一个 Alpha 发布周期。

## 回滚

回滚分两半，**机检半边**与**人工门半边**都要走（#290）：

**机检（Q3 内，离线、秒级）**：`pnpm test:dsh-contract` 里的回滚演练
（`packages/runtime-dsh/tests/dsh-contract/rollback-drill.contract.spec.ts`）在临时副本上判
「部分升级必红（哪一处漏改就点名哪一处）/ 装错 tarball 必红 / catalog 写 range 必红 /
整体升级三处自洽不红 / 回滚到锁定副本必绿且逐字节相同 / 锁 == 实际安装树」。
改了锁或升级后，看的是它 + `lock-drift.spec.ts` 两条都绿。

**人工门（需要 registry/网络与真安装，CI 不做）**——步骤与**预期输出**：

1. 记录现状：`node apps/runtime/dist/bin.js --print-dsh-version` → 期望 stdout 恰一行
   `{"dshName":"@deepseek-ai/dsh","dshVersion":"<锁版本>"}`（与 `dsh.lock.json` 一致）。
2. 制造升级失败：按「步骤」升到新版跑一遍 `pnpm install` + `pnpm -r build`（**不提交**），
   触发一次已知不兼容（最省事的形态：把某个 pack 的 `dshCompatibility` 留在旧版 →
   启动即 `PLUGIN_PACK_MISMATCH`；或 `pnpm test:dsh-contract` 红）。
3. 回滚：`git checkout <pin> -- dsh.lock.json pnpm-workspace.yaml pnpm-lock.yaml packages/runtime-dsh/package.json`
   → `pnpm install --frozen-lockfile` → `pnpm -r build`。
   预期：install 不打 registry 的版本解析错误（frozen 锁）；build 绿。
4. 验收回滚：`pnpm test:dsh-contract`（含回滚演练与 lock-drift）全绿；
   `--print-dsh-version` 回到锁定版本（**必须重启 Node** 才反映到 `node.hello.dshDistributionVersion`，
   探针只在启动时跑一次）；对一个**既有 Workspace** 起一次 Run，历史投影可读（跨版本会话
   日志兼容性——这一条需要两个版本都用过才判得出来，是本门存在的主要理由）。
5. 残留自查：`node_modules/.pnpm` 里不应再有新版包（`ls -d node_modules/.pnpm/@deepseek-ai+dsh-session@*` 只应剩锁定版）。

数据与历史语义：

- Hub 数据 migration 不依赖 DSH schema，DSH image 可独立回滚。
- 已创建 Run 固化其 DSH version，回滚不改历史 Run。
- 回滚后不恢复新版本上正在跑的 Runtime：标记 `failed(runtime_version_rolled_back)`，用户显式 rerun。

## 其他依赖

非 DSH 依赖同样精确版本 + frozen lockfile；安全类升级可单独 PR 走快速评审，但仍要过 Q0–Q2 与受影响门。
