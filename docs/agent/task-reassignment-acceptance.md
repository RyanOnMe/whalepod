# 拒绝后的网页重新指派验收

- Issue：P1-314；G2-04/G2-05，Q0/Q1/Q2/Q5。
- 验证日期：2026-10-14；页面新旧链 14 条通过；Q2 4 条通过；Q5 1 条通过。
- 红绿与变异：4 条入口/阻塞判据先红；删除 command_receipt 事务去重时相同 key 重试回 409，判据红；还原后回放同一 pending 结果。

## 用户路径与驱动

Bob 拒绝 → Alice（Owner）在任务房选择启用成员并重新指派自己 → 任务 pending、Alice 必须接受 → 在 Alice 配对的 Node 与 Workspace 启动真实 Run、审批并完成。成员直接改派仍 403。停用成员无候选；名册失败/加载和活跃执行阻塞有独立提示；冲突保留选择。

```bash
pnpm -r --if-present build
pnpm exec vitest run --project web apps/web/tests/task-reassignment.spec.tsx apps/web/tests/assignment.spec.tsx
pnpm exec tsx scripts/with-test-postgres.mts vitest run --project integration apps/hub/tests/assignment.integration.spec.ts
pnpm exec playwright test --project p1-314
```

本次本地 Q5 临时复用 #313 的 operations 隔离配置（生产 Hub bin、真 Node/Runtime、DSH replay），避免占用已有开发服务；业务 PR 与 #313 独立。默认冷启命令如上，#313 合入后也可用 operations 配置。

## 观测、判定与取证

成功证据：`artifacts/evidence/task-reassignment/result.json`，`component=web.assignment`，含 taskId、对端 403、pending、现任 assignee、后续 run owner/device/status；实际落点取真人同一路径的 owner Run HTTP 查询，不扩散控制面白名单。缺数据或链路缺环失败。证据不含 Cookie/Token、路径、模型秘密或私有正文。

```bash
bash scripts/secret-scan.sh artifacts/evidence/task-reassignment
```

页面无法选人 → web.assignment/成员接口；重试冲突 → hub.task/command_receipt；新 Run 落点不对 → hub.run 的归属守卫。证据地图与索引已登记。

## 边界

本入口只补拒绝后的恢复，不做进行中责任接管、不提供 Agent 改派入口。保持当前授权名单保留语义，历史 Artifact owner、Run owner、Workspace/凭据均不转移。接受仍是真人独立决定。HTTP 重试键按 actor/task 隔离；新选择生成新意图。
