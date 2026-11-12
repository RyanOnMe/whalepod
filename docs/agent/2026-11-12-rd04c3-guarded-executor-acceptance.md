# RD-04c3：真实模型出站与逐调用结算

- Issue：#544（父任务 #535），前置 #542，契约 ADR-0030 §5。
- 真实模型只在独立的验收装配显式启用。默认 Hub/Node 不启用；正式阅稿和飞书接入沿原边界。
- 2026-11-12：最终构建的 c2 正向、首读前撤权和 c3 无外网拒绝场景均通过。缺授权、账户或密钥不符、授权撤回、预算不足时，未产生模型请求。
- 同日通过一次真实装配验收：Command Code 的 `deepseek/deepseek-v4.1-flash` 完成 4 次调用，供应商报告输入 9,570、输出 1,352 tokens。Team、Project、父许可和 Work 的增量一致，按冻结费率折算为 4,495 微美元（USD 0.004495），无残留预留。供应商扣款对账仍为 `not_run`。
- 一个授权只生成一个已完成的 Run。DSH 读到两份冻结来源，草稿保留了两份来源各自独有的合成校验值；责任人下载 200，另一成员查看公开对照 200、查看草稿 404。HTTP、实时和重放无私有标记；正式发布入口 404，私有运行目录已清理。独立验真通过。

## 工具错误隔离补验

PR #545 独立评审发现：原 c2/c3 成功路径没有实际制造带私有标记的工具错误，不能仅凭三面零泄漏证明错误内容隔离。补验不修改生产策略：真实 Runtime 在两份授权来源读取后，调用未知 ID 的 `read_work_input`。仅在下一次模型请求收到精确调用身份及完整错误结果后，回环供应商才继续成功写稿、登记候选和最终答复。错误使用独立标记，不复用草稿或最终答复标记。

```bash
node --import tsx scripts/run-rd04c2-acceptance.ts --tool-error-followup
node --import tsx scripts/verify-rd04c2-acceptance.ts --tool-error-followup
node --import tsx scripts/check-rd04c2-evidence-negatives.ts --tool-error-followup
```

运行前提交 harness；输出独占 `artifacts/evidence/rd04c2/tool-error-followup/<commit>/`，已有目录拒绝覆盖。新证据必须是 v2，独立判定绑定当前提交、harness 和生产 assembly 指纹；错误结果缺失、错配、重复，或 HTTP、实时 WS、历史重放任一面缺观测/泄漏均失败。删除错误事件后重算指纹仍拒绝。状态机及判定器单元自证接入 check，生产补验与负控接入 integration CI。补验只使用回环响应，新增真实供应商请求为零。

原真实批次 `f0e2b73` 的 c2、guard、计划、密钥绑定、attempt 和 live 证据保留原字节；只能用原冻结 harness 及匹配生产构建复核。整改改变 harness 指纹，当前 c3 验真会拒绝旧计划，不能把它写成新 harness 的 live 通过，也不能重签原计划或重发真实调用。原批次扣款对账与新提交工具错误补验分别取证。

## 验什么

生产 HTTP/WS 创建筹备讨论、成员、公开佐证和已承接工作。成员评论触发新任务，责任人通过生产入口确认执行。评论原作者、佐证所有者、核实回执创建者分别对实际 Executor 接收方授权；没有全套逐件授权、来源改版或账户不符，Hub 拒绝出站，不回落到默认模型。验收只把合成资料送给显式允许的测试账户，发现和公开对照仍使用回环回放。

每次调用前，Hub 复核 Run、在线设备、来源、父许可和子 Work，再从 Team、Project、父许可槽位和 Work 同时预留。成功的新尝试才可发送；同一 Run 的重复尝试或相同请求摘要不再放行。Runtime 只有回环凭据；Node 固定接收方、请求体上限和输出 token 上限，强制要求供应商零数据留存，不隐式重试、不跳转。响应在实际用量入账后才交给 DSH。Node 先持久记录结算事实；掉线或重启只补发结算。未知结果保留预留，确认缺失用量按上限记账；实际用量超出预留时如实入账，停止后续发送。设备凭据被撤销时，未送达的结算仍待人工对账，预留不会提前释放。

实际 token 来自供应商的终端流式用量事件；Hub 金额按冻结费率折算。这个金额用于本地预算和核对，供应商实际扣费仍需从 Studio 的同批请求逐项对账。公开价目和账本结果都不能替代供应商账单。

## 复跑与取证

```bash
pnpm --filter @whalepod/hub... --filter @whalepod/node... build
node --import tsx scripts/run-rd04c2-acceptance.ts
node --import tsx scripts/run-rd04c2-acceptance.ts --revoke-before-read
node --import tsx scripts/run-rd04c3-acceptance.ts --guard-negatives
node --import tsx scripts/run-rd04c3-acceptance.ts --prepare-only
node --import tsx scripts/run-rd04c3-acceptance.ts --bind-credential --key-file "$WHALEPOD_C3_KEY_FILE"
node --import tsx scripts/run-rd04c3-acceptance.ts --accept-charges --key-file "$WHALEPOD_C3_KEY_FILE"
node --import tsx scripts/verify-rd04c3-acceptance.ts
```

先验证同一构建的 c2 正向和撤权证据。真实请求只用已授权的测试账户，密钥文件须在仓库外、权限为 0600。先在不出网的步骤绑定该文件的密钥指纹，来源授权和 Node 出站复用同一指纹；换密钥即拒绝。同一验收计划只允许发起一次。出现断线、供应商拒绝或用量不明时先检查已有尝试，不重发。

脱敏证据在 `artifacts/evidence/rd04c3/`，按 application、execution、Run 和 attempt ID 关联。授权和派工看执行来源、逐件授权及 dispatch；发送和供应商用量看 `node.discovery_execution`；预留、结算和未知结果看调用账本及四级计数；DSH 读取看冻结清单与回执。私有候选用两名成员、HTTP、实时和重放对照复核。
