# 执行输入快照验收（#325）

## 用户路径

发布产出后启动复核/修订，新Run在创建事务固定输入身份与sha256；新发布不能改变旧清单。显式选择为精确集合（0–64唯一UUID）；候选/其他Task/未知统一拒绝。续跑/重跑默认保留来源材料，显式新选择只改新Run。旧Run未知与已确认空清单分开，绝不猜历史。

## 六原语与判据

- 驱动：真实setup、插件包查询、Agent/Task/接受、配对、Device WS hello/inventory、运行HTTP和上传/发布HTTP；Fake Adapter只驱动生产Outbox/ack/runtime事件处理。不直写Run/投影。
- 观测：Run读取、固定manifest、协议回执、Node下载与Runtime输入观测缝，组件hub.run/node.artifact/runtime.bridge。
- 判定：空清单不漂移、晚发布/幂等不漂移、显式顺序与子集、创建前上限、候选/跨Task/错设备拒绝、续跑继承与显式反馈。旧fixture证明未知拒绝、Session为null和显式恢复；该迁移前fixture沿既有登记，不把近道用到新增运行链。
- 归因：创建400查选择格式/意图；404查published及Task；409查上限/旧未知；下载失败查Node digest验证；UI事实与实际manifest对照。
- 取证：artifacts/evidence/operation-flow-batch3/input-snapshot/，不保存Token、本机路径或原始用户文本。
- 发现：本页与ADR-0016、第三批实施方案、evidence-map登记。

## 复跑

```bash
pnpm build
pnpm check
pnpm exec tsx scripts/with-test-postgres.mts vitest run --project integration apps/hub/tests/run-input-snapshot.integration.spec.ts apps/hub/tests/artifact.integration.spec.ts apps/hub/tests/run-resume.integration.spec.ts apps/hub/tests/run-rerun.integration.spec.ts packages/db/tests
pnpm exec playwright test --config playwright.operations.config.ts --project p1-19
pnpm test:security
```

失败基线a1c9829：真实PG7失败+1错设备正控通过；协议2失败+2拒绝正控通过。实现后新增8条真实链通过；最终提交、完整门禁及组合结果见证据包。迁移没有可追溯旧历史时保留NULL；旧Runtime不强制终止、不自动重放，新建或显式选择后重跑/续跑恢复。副本只读不限制整个Agent工具权限。

评审回归：材料 UUID 按小写规范身份；大写选择与小写等价，混合大小写的重复选择在协议入口拒绝（400），既有快照不变。真实 HTTP 用例 `accepts uppercase material UUIDs` 覆盖创建与统一指令入口。

评审补查：大写 Task 路由与小写身份等价；快照始终保存锁定 Task 的规范身份。真实 HTTP 覆盖创建后的 Node/成员清单读取、直接续跑与统一指令续跑继承，避免已创建的执行因身份拼写差异无法读取材料。
