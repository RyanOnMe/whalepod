# RD-04c1 发现执行授权与精确来源包验收

- Issue：[#540](https://github.com/RyanOnMe/whalepod/issues/540)（父 Issue：[#535](https://github.com/RyanOnMe/whalepod/issues/535)）；契约：[ADR-0030](../adr/0030-project-work-discovery-and-creation.md) 的 RD-04c 第一切片。
- 最近验证：2026-11-12，生产 HTTP / Node WS / 真实 PostgreSQL 装配；18 条发现创建用例（12 条 RD-04b + 6 条 RD-04c1）与 RD-04a 回归全部通过，Q0 静态门通过。
- 状态：**只授权，不派工**。执行授权记录已可建立/撤销；Mandate、dispatch intent、Run、私有候选仍属于 RD-04c2。

## 范围

RD-04b 把候选立为已承接 Task 后，责任人可以对这一件已立项工作再做一次范围更窄的确认：

- 父许可必须已到 `tier=execute`；`create` 只能立项，不能授权执行。
- 逐件固定入口评论、已发布佐证、核实回执的**当前**版本/摘要/授权代次；任一来源漂移或权限变化即整体不可用。
- 绑定 Executor 的实际路由身份（服务商/模型/端点/账户/策略代次）与不超过 24 小时的到期时间；模型用途固定为 `private_draft`。
- 同一 application 只有一份执行授权；同一幂等键重试只回放 execution id 再回读当前行（撤销后重试返回 409 `DISCOVERY_EXECUTION_REVOKED`），换摘要/Executor/到期时间 409 `DISCOVERY_EXECUTION_EXISTS`。
- 来源更正/撤回、许可撤回/换版、配置换版都会撤销已有执行授权；不创建 Mandate、不派工、不建 Run。

## 驱动和判定

```bash
pnpm -r --if-present build
pnpm test:integration apps/hub/tests/discovery-creation.integration.spec.ts
pnpm test:integration apps/hub/tests/discovery.integration.spec.ts
pnpm check
```

驱动全部走生产 HTTP + Node WS + 真实 PostgreSQL：评论、核实、发现配置、许可、立项、执行授权均为 HTTP；模型结果走 Node WS 回放；数据库只读用于独立核对。

6 条新用例与判据：

1. **授权与幂等**：`tier=execute` 的项目完成立项后，责任人 `GET /applications/:id/execution` 得到 `eligible=true`、来源 `task_message` + `receipt`、非空摘要；非责任人同路径 404。摘要不符 409 `DISCOVERY_SOURCE_MANIFEST_CHANGED`；正确摘要 + Executor 路由首次授权 200，重复提交返回同一 execution id；`discovery_execution` 一行、`discovery_execution_source` 两行；来源更正后 execution 变 `revoked/source_corrected`、`eligible=false`，Task 仍在且无 Run。
2. **档位不足**：`tier=create` 的项目同一路径 `eligible=false reason=tier_required`；POST 409 `DISCOVERY_EXECUTION_UNAVAILABLE`，不写授权。
3. **父许可撤回**：授权后 `DELETE /permit` → execution `revoked/permit_revoked`，`eligible=false`。
4. **显式撤销**：`DELETE /applications/:id/execution` → `revoked/principal_revoked`，`eligible=false reason=execution_revoked`；再 POST 409 `DISCOVERY_EXECUTION_REVOKED`。
5. **撤回后不可新授权**：作者 `POST /sources/:id/withdraw` 后 GET `eligible=false reason=source_changed`；用撤回前摘要 POST 409 `DISCOVERY_EXECUTION_UNAVAILABLE`，不写 execution。
6. **改派撤销**：授权后把发现 Task 改派给另一成员 → execution `revoked/task_reassigned`，`eligible=false`。

发布佐证路径扩展断言：`tier=execute` 下 `GET execution` 的来源为 `artifact` + `task_message`，证明佐证逐件进入来源包。

## 观测

- `GET /projects/:projectId/discovery/applications/:applicationId/execution`：`eligible/reason`、`sourceManifestDigest`、逐件 `kind/sourceId/sourceVersion/sourceDigest/authorizationGeneration`、`execution.status/executor/expiresAt`。
- 只读核对：`discovery_execution`、`discovery_execution_source`、`discovery_application`、`discovery_source_binding`。
- 结构日志 `component=hub.discovery`，action `discovery.execution.authorized`，只带 execution/application id 与来源数量。

## 归因

- `reason=source_changed`：入口评论版本/摘要与立项绑定不一致，或作者参与权失效；先看 `discovery_source_binding` 与 `discovery_source_correction`。
- `reason=evidence_changed`：佐证取消发布、摘要不符或作者/佐证拥有者失去参与权。
- `reason=receipt_changed`：回执被撤销、版本不符或核实人失去参与权。
- `reason=permit_inactive` / `tier_required`：父许可撤销、过期、换版或档位不足。
- `reason=authority_changed`：责任人不再是当前成员、Task 已改派或 Work 不再 active。
- `reason=execution_revoked` / `execution_expired`：已有授权被撤销或已过 `expiresAt`；改派、提交评审、完成/取消、Work 退休、参与权撤回与成员停用都会在同一事务撤销。

## 取证

```bash
pnpm test:integration apps/hub/tests/discovery-creation.integration.spec.ts \
  --reporter=verbose 2>&1 | tee /tmp/rd04c1-execution.log
bash scripts/secret-scan.sh
```

只记录身份/版本/摘要/代次；测试不落来源正文到日志或证据包。

## 边界

- **不派工**：本切片没有 Mandate、dispatch intent、Run、模型调用、私有候选或费用预留；这些在 RD-04c2/c3 交付前，正式阅稿与受控模型/计费继续关闭。
- 执行授权只固定「来源 + Executor 路由身份」，不代替部署侧对实际 provider/model/endpoint/account 的启用；RD-04c2 必须在出站前再次核对部署策略与父/子代次。
- 父许可额度、Run 次数和模型费用仍由既有 Run/Mandate 预算与 RD-04c3 的调用级预留裁决；本切片不产生费用。
- 已授权来源包只在库内保存身份与摘要，不保存正文；正文仍由原 TaskMessage/Artifact/回执持有，读时重验。
- 授权撤销/过期是终态；同一 application 不重新授权，后续执行切片只认这一行且会同时核对 `expiresAt`。槽位占用不可删除，重开实际需要新的发现立项路径；本切片不提供复活入口。
