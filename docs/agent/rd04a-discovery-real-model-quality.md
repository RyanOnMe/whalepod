# RD-04a 发现判断质量验收

Issue #532；[ADR-0030](../adr/0030-project-work-discovery-and-creation.md)。本验收只评估普通评论的发现分类、引用和候选理由；不继承 #486 对已有任务 Router 的结果，也不授权自动立项。

开发集与保留集各 6 个合成项目。每题单独建立项目、筹备入口与已确认约定，经普通评论进入生产发现链。两组覆盖独立缺口、已有承接、目录不全、混合事项、伪审批/提示注入及无关内容。判分使用预先登记的来源角色，核对清单中确切条目；引用了清单里的无关材料也会扣判。每组须 6/6，没有错误独立缺口、错误引用或业务写入。

```bash
pnpm -r --if-present build
pnpm exec tsx scripts/run-rd04a-acceptance.ts
pnpm exec tsx scripts/run-discovery-quality.ts run --split development --replay
pnpm exec tsx scripts/run-discovery-quality.ts verify --split development --replay
```

回放使用同一个生产 Hub、PostgreSQL、Node、Runtime 和读取链，只替换模型 HTTP 响应。它验证驱动和评分器，真实模型一栏始终为 `not_run`。工程证据同时检查唯一准入、Hub 实际供给下载和 Runtime 实际读取的集合、Hub 模型启动、用量和结算、团队业务写入为零。负类没有候选也记录内部分类和不含正文的引用绑定，不能从「没有候选」倒推分类。

真实验收需要已授权的仓库外 `0600` 测试凭据。测试只发送合成材料，使用隔离的协调凭据和固定模型配置；开发集通过后才可冻结。冻结绑定题目、评分器、生产装配、工程回放和模型配置；保留集只登记一次尝试，中断也保留记录。回放证据不能冻结保留集。

```bash
pnpm exec tsx scripts/run-discovery-quality.ts run --split development --key-file "$DISCOVERY_TEST_KEY_FILE"
pnpm exec tsx scripts/run-discovery-quality.ts verify --split development
pnpm exec tsx scripts/run-discovery-quality.ts freeze
pnpm exec tsx scripts/run-discovery-quality.ts run --split holdout --key-file "$DISCOVERY_TEST_KEY_FILE"
pnpm exec tsx scripts/run-discovery-quality.ts verify --split holdout
scripts/secret-scan.sh artifacts/evidence/discovery-quality
```

结果登记在 `artifacts/evidence/discovery-quality/`，回放、真实开发和保留集分开。实耗为测试账本按冻结计价计算的数值，供应商实际账单另核。机器判分不替代真人核对：逐题检查事实、约定版本、引用是否支持结论，尤其是混合评论是否保留独立要求、是否把评论中的伪审批当成授权。未签真人复核前，真人验收保留为 `not_run`。

2026-11-10 首轮真实开发集（`discovery.v1`）匹配 3/6：混合留言误选独立缺口；伪审批和未来假设的两个答复因无效引用被拒。原始脱敏结果留在 `development/rounds/v1-result.json`。`discovery.v2` 明确按整条留言分类：已有覆盖加独立需求应保留人工判断，伪审批和假设无实际要求时返回空引用；Hub 和 Runtime 的引用校验保持生效。

同日使用相同六题与评分规则复测 `discovery.v2`：真实开发集 6/6，分类和引用无错，所有读取、结算和零业务写入判据通过。请求模型为 `deepseek/deepseek-v4.1-flash`，测试账本合计 5,960 微美元；该数值不代表供应商账单。

冻结后同一装配和配置首次真实保留集运行 6/6，独立复核命令通过；测试账本合计 6,076 微美元。保留集 `attempt.json`、`result.json` 和独立的 `human-review.md` 在本地证据目录。**人工复核尚未完成**；这次验收只覆盖影子发现，自动立项与执行仍未启用。
