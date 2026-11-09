# RD-04a 影子发现验收

- Issue：#532；契约：[ADR-0030](../adr/0030-project-work-discovery-and-creation.md) 的 RD-04a。
- 当前证据：先在未接入发现能力的生产装配运行，Hub、PostgreSQL 与 Node 正常启动，配置发现入口返回 404，未产出通过证据。真实模型质量 `not_run`。

成员在已有订阅的场地 Task 补充座席要求，应当直达既有收件箱。另一条普通评论从同一项目的筹备讨论报告独立接驳缺口，引用本项目允许参与评估的已确认约定，应当产生一条仅责任人可读的候选。测试使用已存在的讨论 Task，不需要新建目标 Task、指派 Executor 或发额外指令。

## 驱动和判定

```bash
pnpm -r --if-present build
pnpm exec tsx scripts/run-rd04a-acceptance.ts
pnpm exec tsx scripts/verify-rd04a-acceptance.ts artifacts/evidence/rd04a/result.json
scripts/secret-scan.sh artifacts/evidence/rd04a
```

驱动启动 Hub/Node/Runtime 的包入口和一次性 PostgreSQL；配置、确认、评论及撤权全部从生产 HTTP/CLI 发起。只有模型 HTTP 响应回放，数据库只读用于独立核对。必须同时看到：

- 场地评论的唯一准入与收件箱项关联原订阅；该评论 Router 调用为零。
- 筹备评论幂等重放仍指向同一来源；发现评估仅一次，绑定清单、读取回执、候选和一对费用预留/实际结算；无伪造的 Work 或 Inference。
- 责任人通过禁止缓存的接口读到私有候选；另一已登录成员能读公开对照但不能读候选；撤权后责任人也不能读。实时和重放 WebSocket 都读到撤权后的公开评论对照，但不包含候选探针。HTTP、持久团队事件和结构化日志也不含探针。
- Task、约定、Work、问题、派工意图及 Run 数不变；撤权后新发评论不会追加模型调用或评估。证据缺项或使用了不同的构建指纹，判定失败。

## 归因和取证

订阅不达先查 `hub.work_entry` 的准入和 `work_inbox_item`；发现没评估先查 `discovery_admission` 的入口归属、许可和候选记录，再查 `coordination_evaluation` 的用途、状态与读取集合；用量核对 `coordination_usage_ledger` 的同一评估/尝试。先区分 Hub 未派发、Node 未领用、Runtime 未读齐以及模型未返回。授权读面和团队投影分别取证，不能用候选 HTTP 404 代替实时和回放检查。

驱动只在全部判据满足时写脱敏 `result.json`，保留身份、计数、构建指纹和状态，不写评论、模型提示、私有候选文本或凭据。判定器自测覆盖错来源、缺读取、重复收费、访问越权、缺回放、团队泄漏和额外 Run；自测不是产品验收。真实模型保留集、自动立项、Executor 实际草稿以及真人收益分别验收。
