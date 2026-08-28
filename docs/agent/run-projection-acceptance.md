# Run 投影、脱敏与双受众流验收

- 对应场景/门禁：G4-04..06、R1/R6、04 §6.4 秘密语料；Q0/Q2/Q3
- 对应 Issue：#17（P1-13）
- 上次验证：2026-08-28 · feat/p1-13-run-projection · 结果 PASS（Q0 单测 640+、Q2 集成 187+、链路 spec 3/3 ×3 连跑稳定）

## 验的是哪条用户路径

Task Room 启动 Run（Agent Revision + 设备自己的 Workspace + 凭据槽）→ Node 单一
projector 把 Runtime 输出投影成 run_event（owner 全量 / project 收缩，一事实 0..2 行、
每行独立 seq）→ spool 落库（seq 原子分配）→ 上行 Hub（(runId,seq) 幂等去重、连续水位
run.event_ack、心跳缺口 run.resend_from）→ Browser 双受众扇出；assistant text-delta 走
owner-only live delta 不持久通道。一切文本离开设备前过 §9 脱敏。

## 驱动

- 投影器/脱敏库：单测直驱（projection-redact.spec.ts 13 例、projector.spec.ts 28 例）。
- Hub 侧：真实 Fastify listen + ws 包客户端（run-projection.integration.spec.ts 7 例：
  R6 幂等+水位 ack、心跳缺口 resend_from、live_delta owner-only、owner/member/admin
  持久帧受众 diff、双受众 approval 去重、HTTP 面、G4-06 digest 快照）。
- **全链路**（run-projection-chain.integration.spec.ts 3 例）：真 Hub（buildApp+listen+
  真 PG+真 OutboxWorker）⇄ 真 Node 会话（session.ts+RunManager+Supervisor+
  DshRuntimeDriver）⇄ 真 Runtime 子进程（apps/runtime bin + DSH + replay overlay），
  双 Browser WS 连接；无一环 mock。
  - replay 接入经两条显式验收缝（生产 cli 为空）：supervisor `runtimeEnvPassthrough`
    白名单透传 `DSH_SNAPSHOT_FILE`/`PROJECT311_RUNTIME_EXTRA_PATCH_FILES`；driver
    `nodeArgs: ['--import', <tsx 绝对路径>]`（子进程 cwd 是临时 workspace，`--import tsx`
    裸名解析不到）。
- secrets fixture（packages/runtime-dsh/tests/dsh-contract/fixtures/secrets/）：单 turn
  文本原样嵌入 §6.4 六件语料，作攻击输入（语料是攻击输入的存放处 ≠ evidence，
  secret-scan 针对 evidence/日志判负）。

## 判定

- G4-04：owner 连接收到含全文的 owner 帧 + live delta；member 连接只见 project 帧、
  零 live、零 `assistant.message`（owner-only 事件）；帧边界 diff 即协议 diff。
- G4-05：owner 流全部 assistant.message 的 seq 小于 run.completed 的 seq
  （Session flush 在 completed 前兑现）。
- G4-06：Run 进行中新建 profile Revision → 本 Run `profileDigest` 钉死不变；
  下一 Task 的新 Run 绑定新 Revision digest。
- R1：Hub 关闭期间 Runtime 跑完（完成信号 = Node spool 出现 run.completed，
  直读 spool sqlite；activeRunIds 不是完成信号——Run 完成后子进程驻留等 shutdown），
  同端口重启后 Node 自动重连全量补发，Hub 侧 seq 空间（跨受众共享）1..N 连续，
  run 行落 completed。
- R6：重复 (runId,seq) 不产生第二行、仍按水位 ack（幂等已应用）。
- 秘密语料：六件语料在 Hub run_event 全表 JSON 与两个 Browser 帧流中零出现；
  owner 完成行含 `<redacted>`/`<home>/private/project`/`https://example.com/path`
  （证明是脱了敏，不是没内容）。

## 链路实测揪出并已修的真 bug

- **双受众行重复驱动状态迁移**：同一事实的 owner/project 两行各自 append 成功，
  第二行重复应用同一状态边 → INVALID_RUN_TRANSITION → Hub 4003 断连 → Node 重连
  补发 → 再撞同一边 → 毒帧循环。修复：状态迁移只由 owner 行驱动，project 行纯镜像
  （orchestrator.handleRunEvent）。低层集成测试没抓到它（只发单行）；全链路才暴露。

## 边界与未覆盖

- `waiting_approval → completed` 无状态机边：Runtime 在仍有 pending Approval 时完成
  （replay 下审批不阻塞即出现）会让 Hub 拒收该事件并断连。生产 DSH ask-all 语义下
  理论上不可达，但属于「合法观感事件序列可毒杀连接」的健壮性缺口，已另立 Issue 跟进。
- live delta 丢损由设计（lossy）；Run 完成后 Runtime 子进程驻留至 supervisor 超时
  （capacity 释放策略待 P1-14/16 定稿）。
- G4-04 的 Playwright 双 BrowserContext 形态留 P1-19（Q5 门）；本 Issue 用双 WS
  客户端证明同一帧边界 diff。

## 复跑

```bash
# 单测（投影/脱敏/RunManager）
pnpm exec vitest run --project unit projection run-manager
# Hub 侧（真 PG 一次性容器）
pnpm exec tsx scripts/with-test-postgres.mts vitest run --project integration run-projection
# 全链路（含真 Runtime 子进程 replay；同一命令，文件在 apps/node/tests/integration/）
pnpm exec tsx scripts/with-test-postgres.mts vitest run --project integration run-projection-chain
# Q3 契约（replay overlay 本体）
pnpm test:dsh-contract
```
