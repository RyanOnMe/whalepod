# 约定与交接内容实际消费验收（#396）

- 关联：ADR-0020；Q0/Q2/Q3/Q5/Q6/Q7。
- 2026-10-19：本地 Q0 PASS（1912 passed，7 expected fail）；Q3 PASS（74）；新增集成与浏览器验收等待可用 Docker 或 CI。不能把历史 #381 的 PASS 当成本次 PASS。

## 用户路径与驱动

责任人确认约定 → 业务 Agent 收到固定约定 → owner 检查/发布自动交接草稿 → 接收人先读指定正文再确认理解 → 下游 Agent 收到固定正文、理解、差异与材料身份 → 真人发布下游成果、提交验收并完成任务。

- Q0：`pnpm check`。辅助起草页面测试检查私有 JSON 候选、采用 CAS 令牌与不自动确认；正文请求失败明确报错、禁止接收确认。
- Q2：`pnpm exec tsx scripts/with-test-postgres.mts pnpm exec vitest run --project integration handoff-receipt.integration.spec.ts handoff-draft.integration.spec.ts task-agreement.integration.spec.ts`。验证无 Artifact 仍下发正文、固定输入不随上游变更、采用版本竞态 409、自动事件不能自报已核实而人工编辑可以。
- Q3：`pnpm test:dsh-contract`。`execution-context.contract.spec.ts` 的回放输出用 fromRequest 从真实模型请求中取值，缺上下文就无法成功生成；persisted resume 必须读到 CURRENT_REVISION=2，不能只从第一轮历史取值。非合作流截止与迟到结果拒绝在 handoff-draft 单测中判定。
- Q5：`pnpm exec tsx scripts/run-handoff-loop.mts playwright.operations.config.ts`。现有隔离端口，不占用开发服务；与生产同样的包解析 Hub、Node、Runtime，模型出口为 replay。

## 观测、判定与取证

`artifacts/evidence/handoff-loop/result.json` 新增 semantic 与 finalization：实际生成输出必须包含约定目标/验收条件、接收页实际文本必须包含发布正文、下游输出必须包含正文与接收理解，任务经 in_progress→in_review→done 收敛。独立判定器检查交叉一致；缺任一节/丢正文/把 Run completed 冒充 Task done 均 FAIL，负控随 Q0 运行。出包走 `scripts/secret-scan.sh artifacts/evidence/handoff-loop`。

归因：hub.run 的 execution-context / handoff-input → node.run 的 initialize 透传 → runtime.bridge 的 SessionOwner 首条指令；接收正文在 web.handoff 的 HandoffPublishedContent，草稿信任边界在 runtime.handoff 与 hub.handoff。发现入口登记于本页和索引。

## 边界

真实 Provider 的内容质量、延迟、费用和三队真人试用仍为 not_run。历史快照没有正文的，只能如实提示未知；不以当前上游版本替代。辅助起草不引入新的提案 wire：沿已有 Artifact 上传/拥有者读取/人工采用路径，候选不会自动发布。协议/Runtime 变更仍需两份独立评审后才能合入。
