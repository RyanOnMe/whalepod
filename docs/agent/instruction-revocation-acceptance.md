# 授权撤销与责任交接验收（#321）

## 用户路径与规则

责任人撤销协作者指令权后，新请求403，旧网页草稿保留且禁用发送。尚未入Outbox、或Outbox.attempt_count=0的追问拒绝为FORBIDDEN并发状态事件；attempt_count>0可能已经抵达Node，保留实际回执，不伪造撤回。撤销不自动取消已创建Run；停止整次执行按既有取消权处理。

Task→活跃Run→该追问Outbox→消息锁序，与进入running/claim/ack串行化。第一次claim是无法保证撤回的边界：worker先claim则真实回执继续settle，撤销先拿到未尝试命令则置failed_at，worker不再派发。补发器额外查作者当前指令权和成员启用状态；成员停用后也不能把排队追问放行。

进行中责任交接保持禁止改派；先结束活跃Run，再由Owner/Admin改派和新责任人接受，授权名单保留，历史会话/候选拥有关系不转移。承重决定记录ADR-0015，合入需独立评审。

## 六原语

- 驱动：真实PG，HTTP创建/接受/授予/发指令/撤销/停用；Orchestrator+Outbox+FakeGateway与协议帧推进Run，无直接写运行/投影。Web走真实task.changed帧接线；Q5生产双浏览器与replay。
- 观测：hub.task-grants的HTTP结果；hub.task-message拒绝/受理状态和原因；Outbox attempt_count/failed_at；真实pg锁等待；web.execution草稿和权限。
- 判定：撤销先完成零成员派发，责任人合法指令仍补发；未尝试命令永久失败；已派发迟到ack仍accepted；停用成员零补发；新请求403；旧页草稿不丢且没有私有现场请求。
- 归因：错派发先查grant和作者启用态、Run/Outbox锁顺序；错撤回查attempt_count与ack事实；旧页可发查task.changed→instruction-grants失效。
- 取证：artifacts/evidence/instruction-revocation/ 脱敏门禁与布尔结果；不保存原始会话/秘密/绝对路径。
- 发现：此文与ADR/领域规则登记索引。

## 复跑

```bash
pnpm check
pnpm exec tsx scripts/with-test-postgres.mts vitest run --project integration apps/hub/tests/instruction-revocation.integration.spec.ts apps/hub/tests/instruction-queue.integration.spec.ts apps/hub/tests/instruction-grant.integration.spec.ts
pnpm test:security
pnpm --filter @whalepod/hub... build
pnpm --filter @whalepod/runtime... build
pnpm exec playwright test --config playwright.operations.config.ts --project p1-315
bash scripts/secret-scan.sh artifacts/evidence/instruction-revocation
```

先红100fddb、b102e13（修正HTTP真实时钟与worker受控时钟后3条稳定失败、已派发正控通过）；精确提交与结果见证据目录。尚未明确副作用是否已发生的在途执行不会被伪造取消，真实模型provider不在replay验证范围。
