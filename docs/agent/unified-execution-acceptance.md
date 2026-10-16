# 统一执行入口与来源绑定验收

- 对应场景/门禁：首次执行、G4 执行/快照、G5 审批、G7 续跑；Q0/Q1/Q2/Q3/Q5/Q7
- 对应 Issue：P1-315；设计决定：[ADR-0013](../adr/0013-explicit-execution-intent.md)
- 验证基线：2026-10-14，红测试提交 `7b3f6bd` + 本 PR 实现；结果 PASS。

## 验的是哪条用户路径

已接受任务的责任人从执行栏选择 Agent、输入指令，直接开始首次执行。配置版本与环境设置默认收起，但已采用的版本和审批档可见。运行中同一输入区发送指定执行的追问；来源结束时保留草稿并阻塞发送。用户明确选择继续会话后，沿用来源版本与现场创建新执行记录。未授权成员可讨论，但没有发送输入；已授权成员使用责任人的环境和凭据，审批仍由责任人处理。

创建任务的混合选择器标为“交给谁”，分别解释真人责任与 Agent 指派即驱动的现有行为；此批未改变自动指派协议。后续可独立设计“真人责任人 + 创建后执行”两项设置（**已由 #344 落地**：见
[create-to-recovery-acceptance.md](./create-to-recovery-acceptance.md) 与 `create-form-split-acceptance.md`）。

## 评审补充

2026-10-14 两名独立 agent 评审发现并补齐以下边界；全部有先红后绿记录，组合验证结果在合入前记录：

- 明确选择现场后持续显示该选择；所选设备/工作目录失效时阻止发送并保留草稿，不改投其他可用现场。
- 父级统一持有 sending，在请求完成前锁执行方式/来源/表单，旧请求不会清空切换后的草稿。
- 触发消息/Run/Outbox/回执原子创建；在 create 返回前到达的 accepted/rejected ack 已有锚点可结算，初始 prompt 只发送一次。ready 先于 ack 也不触发补发；迟到 ack 仅结算消息，不重复改变 Run。
- 已成功追问在来源结束后，或早查无回执后同 key 提交/结束的竞争窗口，都回放本人/同任务/同来源的真实消息命运；活跃分支在命令提交后再次验证回执绑定，异作者/任务/来源的晚提交回执不能返回正文。新意图过期仍拒绝。
- Node 已拒收的首次启动保持原文与新执行方式，显示拒收理由；已明确拒收后重新点击属于新的发送尝试。
- A/B/C 合并保留发布确认与重新指派，迁移 B 的旧启动入口检查，并统一隔离环境清单读取。

## 驱动

- Web 单元：真实 Task Room/QueryClient/组件，HTTP 边界 mock；首次启动、模式切换、草稿、权限加载/失败/无权、来源版本/档位、网络失败/拒收、快捷键及完全权限确认。
- Hub 数据门：真实 PostgreSQL；HTTP 路由或命令层经既有 Orchestrator、Outbox 与 Fake Gateway；运行状态由协议帧推动。静态用户/配置/设备前置复用已登记 fixtures，不直插运行或投影。
- Q5：生产装配 Hub/Node/Runtime replay，双账号 Setup/邀请/登录，UI 创建 Agent、任务、接受、首次启动、审批、结束、显式续跑；不修改运行表或使用源码启动 Runtime。
- Q3：已有生产 initialize/resumeSessionId 契约验证上下文确实在场；它补充 Q5 的会话身份断言，身份一致本身不等于模型读到上下文。

## 观测

| component | 结构化观测 |
|---|---|
| web.execution | 主输入数量、草稿内容断言、执行意图、目标按钮可用状态、权限加载结果 |
| hub.run / hub.task-message | instructions HTTP outcome、runId、resumeFromRunId、profileRevisionId、deviceId、workspaceId、triggerMessageId、审批档及消息状态 |
| node.supervisor / runtime.bridge | 完成后现场释放；后续启动 Runtime，生产会话续接成功 |
| dsh.agent | Q3 的续跑响应包含首轮上下文；未知来源零 ready/零输出，禁止静默新建 |

## 判定

1. 无历史 Run 时执行栏只有一个主输入；选择 Agent 与输入即可启动已就绪环境，不另找启动表单。
2. 追问绑定来源 Run；后台终态保留草稿且禁用发送。改变方式必须由用户触发。新执行竞争时只启动一个，失败请求不形成追问。
3. 同 key 并发首次启动返回同一 Run 与同一触发消息，锚点不被第二条消息覆盖；失败重试保留草稿与同意图 key。
4. 续跑创建新 Run，来源血缘、非空会话身份、来源 Revision/Device/Workspace 一致。Agent 后来升级为完全权限不替换来源版本；当前 Task 覆盖变化按实际解析并要求重新确认。
5. 无会话、旧责任人、不可用来源、撤销设备/离线等失败不能当作成功续跑；原草稿仍可明确切换为新执行。
6. 发送前展示的审批档与服务端不一致时，两个 HTTP 入口均返回冲突且零指令。完全权限保留二次确认；权限加载中/失败不当作有权，也不误报为无权。
7. 禁用继承自 fieldset 的按钮按浏览器 `:disabled` 识别；同区域受阻说明仍接受对比度扫描。Micro 的现有窄屏/键盘/提示/主题检查继续有效。

## 归因

- 请求意图与所见方式不同：先查 web.execution 与 instructions 请求体。
- 状态竞争产生追问或新会话：查 hub.run 锁、单活跃约束及 hub.task-message；缺省 legacy 自动路由与显式意图区分。
- 续跑血缘正确但上下文不在场：查 runtime.bridge initialize.resumeSessionId 和 Q3 dsh.agent；不能靠相同 ID 判通过。
- 协作者无法发送：区分 grants 加载/失败/撤销，再查服务端 resolveInstructionRight；不以管理员角色代替指令权。

## 取证

成功 Q5 写 `artifacts/evidence/unified-execution/result.json`：component、Task/Run 血缘及布尔判据；不存原始会话 ID、草稿正文、凭据或本地路径。Q5 失败使用已有 E2E 分层日志与事实白名单产包。Micro 证据沿用 `artifacts/evidence/run-micro/`；生成后执行敏感扫描。

## 边界与未覆盖

- 新字段兼容旧客户端；旧客户端与 Agent 指派缺省的自动追问行为保留。
- 不改 Node/Runtime wire、DSH 版本、指令权/审批权/候选私有性，也不改变终态不复活。
- 本批没有完成首次安装/凭据准备向导、产物版本绑定的专用复核或个人待办；实际用户是否理解操作需要后续小团队试用。
- 真实模型凭据与远端 provider 不在本地 replay 验证范围；Q3 只证明已支持的 DSH 会话续接契约。
- 协议与控制策略 PR 至少两人评审后合入。

## 复跑

```bash
pnpm check
pnpm --filter @whalepod/hub... build
pnpm --filter @whalepod/runtime... build
pnpm exec tsx scripts/with-test-postgres.mts vitest run --project integration apps/hub/tests/instruction-start-run.integration.spec.ts apps/hub/tests/run-resume.integration.spec.ts apps/hub/tests/instruction-grant.integration.spec.ts
pnpm exec vitest run --project dsh-contract packages/runtime-dsh/tests/dsh-contract/resume.contract.spec.ts
pnpm exec tsx scripts/with-test-postgres.mts vitest run --project security apps/hub/tests/run-authorization.security.spec.ts apps/hub/tests/run-integrity.security.spec.ts
pnpm exec playwright test --config playwright.operations.config.ts --project p1-315
pnpm exec playwright test --config playwright.operations.config.ts --project p1-306
bash scripts/secret-scan.sh artifacts/evidence/unified-execution
```

本地实测使用第一批 P1-313 提供的隔离 harness：独立端口与环境清单，避免干扰别的工作树运行中的服务。P1-313 已合入，可用 `playwright.operations.config.ts --project p1-315` 复跑同一 production 路径。
