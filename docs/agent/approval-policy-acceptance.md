# 审批档位可配置（ADR-0009 切片⑧）验收

- 对应场景/门禁：Q0/Q1/Q3（本地已跑）+ Q2（`approval-policy.integration.spec.ts` 4 用例已写，本地无 Docker 由 CI 必检项跑）
- 对应 Issue：#241（ADR-0009 决策 7；依赖：无硬依赖，TaskPermissionsPage 第二块内容与切片⑦共存）
- 上次验证：2026-09-30 · `feat/p1-241-approval-policy` · 结果 PASS（Q2 项待 CI）

## 验的是哪条用户路径

责任人对**自己凭据**的显式放权：默认每档 Run 的工具调用都要人逐次批准（ask-all）；
信任的 Agent/低风险任务可以配成 `full_access`——工具直接放行，不逐次打扰。解析链：
**Agent Revision 带默认（非空）→ Task 覆盖（nullable，NULL=继承不物化）→ 建 Run 时解析
成具体档位写 `runs.approval_policy`**，所以「Revision 更新后 Task 跟不跟」有唯一答案：
未覆盖的跟（每次建 Run 重新解析），已覆盖的不跟。

## 口径先说清（实现前对齐的冲突）

ADR-0009 决策 7 原文的「assignee=Agent 的自动 Run 解析为 full_access 须降级为
approval_required」**已被 ADR-0010 决策 5（2026-09-11 用户拍板）撤销**：「审批档位
不做自动触发降级……触发方式（人点 / 指令自动）不影响档位」。本片**不做**降级；
`docs/agent/agent-assignable-acceptance.md` 与 `instruction-starts-run-acceptance.md`
的「衔接点在⑧」边界注记已按此口径收口（改为「已按 ADR-0010 撤销，不做」）。

## 各层落点与判据

| 层 | 落点 | 判据 |
|---|---|---|
| protocol | 新 `approval.ts`（ApprovalPolicySchema + ADR 口径注释）；runtime.initialize / run.start + `approvalPolicy?`（缺省= approval_required，旧节点行为不变）；http 的 Revision 请求 + 可选档位、UpdateTask + 可空档位（值=覆盖/null=清除/缺省=不动） | `http-validation.spec` 新 5 负例/正例；roundtrip 243 过（catalog-drift 要求 wire fixture 与类型名 1:1，档位的 wire 覆盖由 Q3 真驱动承担） |
| db | migration 0009：`approval_policy` pgEnum ×3 表（revision 非空默认、task 可空、run 非空）；存量行回填 approval_required（与历史 ask-all 行为一致） | Q2 落库断言 |
| hub | orchestrator：`task.approvalPolicy ?? revision.approvalPolicy` → run.start payload 与 runs 行成对同值；updateTask：PATCH approvalPolicy **仅 Task 责任人**（403），`updateTaskFields` 键在场即生效（null 清除）；digest 七键口径（approvalPolicy 进 canonical JSON；存量 Revision 存库值不重算） | Q2 4 用例：解析链三态（默认→覆盖不跟 Revision→清除回跟）/未覆盖跟新默认（v2=full_access）/守卫（非责任人 403、enum 外值 400、视图带覆盖态）/digest 差分（只差档位的两 Revision digest 不同） |
| node | run-manager initialize 透传（缺省不携带该键——旧 Runtime 语义） | run-manager.spec 41/41（新用例：单 harness 双 Run 对照携带/缺省） |
| runtime-dsh | RuntimeSpec +approvalPolicy；session-owner 的 pre-execute 按档分支（required=ask 现状 / full_access=allow）；ApprovalPort 保持装配（full_access 下静默闲置），头部红线注释按新口径改写 | **Q3 新契约用例**：full_access 的 Run publish_artifact 直跑出 artifact.candidate，全程**零** approval.requested 帧；既有 allowed_once/rejected 两用例不红（36+1/37） |
| web | Agent/Revision 表单默认档下拉（full_access 描述写明风险）；TaskPermissionsPage「审批档位」块（覆盖状态陈述、责任人可改、full_access 走 ConfirmDialog、null 清除）；RunLauncher 解析结果提示 + full_access 确认对话框（确认前零请求）；运行卡「完全权限」标记 | `approval-policy.spec.tsx` 6 用例（表单提交体、权限页三态与守卫、launcher 确认流全程、运行卡标记唯一性） |
| 文档 | 03 §2.2（task 列）/§2.3（revision 列+digest 口径）/§2.6（runs 列）/§4（PATCH 行）/§6.3/§7.1（wire 字段） | 见对应小节 |

## 关键设计回放

- **值由 Hub 解析固化，Runtime 不自行判断**：initialize 只带解析结果——档位是
  Run 的执行姿态（与 profileDigest 同类固化事实），不是 Runtime 的本地配置。
- **wire 字段可选（缺省=approval_required）**：旧 Node/旧 Runtime 在混部窗口内
  行为不变；Q3 用例以缺省路径作对照（既有两用例即回归）。
- **digest 七键**：档位是 Revision 行为的一部分，两个只差档位的 Revision 就是
  不同的 Revision。存量 Revision 的 digest 是存库值（Run 固化的也是存库值），
  互不影响——只有新建的 Revision 用新口径（Q2 digest 差分用例钉住）。
- **放权的三个显式面**：设置时的确认对话框（TaskPermissionsPage）、启动时的
  确认对话框 + 提示（RunLauncher）、运行时的持续标记（运行卡「完全权限」——
  团队里谁都能看出这次没走逐次批准）。

## 边界与未覆盖

- Q2 四用例本地无 Docker 未跑——CI 必检项兜底（migration 0009 的空库路径同跑）。
- Q5 浏览器面未加（本地无 Docker）；e2e 的「档位快照与标记」待 Q5 扩用例。
- `RunSnapshotSchema`（reconcile 用）未带档位：快照服务孤儿判定/恢复，不需要执行
  姿态；runs 行里有（Q2 断言）。若将来 reconcile 需要重放 initialize 再补。
- 审计动作：PATCH approvalPolicy 走既有 task.update 审计 + task.changed 事件带
  approvalPolicy；没有单列 task.policy 动作（字段级审计在 24h team_event 与
  task 行双载体里已可追）。
- RunConsole/审批 tab 对 full_access Run 的呈现：无审批事件即无审批卡（空态
  由既有 empty-state 承担），运行卡标记已回答「为什么没有审批」。

## 复跑

```bash
pnpm check && pnpm test:dsh-contract   # Q0+Q1 + Q3（含 full_access 契约）
pnpm exec vitest run --project unit apps/node/tests/run-manager.spec.ts
pnpm exec vitest run --project web tests/approval-policy.spec.tsx
# Q2：pnpm test:integration -- approval-policy（需 Docker；CI 必检项同跑）
```
