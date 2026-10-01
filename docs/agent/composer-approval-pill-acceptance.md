# composer 审批档位胶囊验收（P1-UX-6 / #244，父账 #243 第 1 条）

## 这条切片改变什么

ADR-0009 切片⑧（#241）给审批档位落了三个「配置/回看」位：Revision 表单（配置）、RunLauncher
提示（启动前）、运行卡徽标（事后）。**发送中的知情位缺了一口**：被授权成员在任务房执行栏打字，
这句话将以什么档位起 Run（或作为追问进哪个档位的 Run），发送前看不到。

本切片补上：InstructionComposer 常驻审批档位胶囊（档位 + 来源），`full_access` 时发送前过
ConfirmDialog（与 RunLauncher 的启动确认同口径——显式放权要显式确认，ADR-0009 决策 7）。
对照 ChatGPT Work 台的发送框权限胶囊（#243 取证）：**抄的是「发送前可见」，不抄「发送时可改」**——
改档是责任人动作（ApprovalPolicyBlock，assignee-only），composer 的读者可能是被授权成员。

## 档位解析链（单一真源，两处成对）

「这句话将以什么权限跑」按优先级解析（`TaskRoomPage`，`ApprovalPreview` 类型导出在
`InstructionComposer.tsx`）：

1. 有活跃 Run → 这句话会成为追问，档位 = 该 Run 已固化的 `runs[].approvalPolicy`（来源「当前运行」）；
2. Task 覆盖 → `task.approvalPolicy`（来源「任务覆盖」）；
3. 其余 → 服务端预解析的 Revision 默认（来源「Revision 默认」）；
4. 都没有（本任务还没跑过）→ null，胶囊如实显示「未知」，不猜。

第 3 条是服务端字段 `GET /tasks/:id` 聚合的 `nextRunApprovalPolicy`（`task/view.ts` 的
`resolveNextRunApprovalPolicy`）：`task.approvalPolicy ?? 上一 Run 的 Agent 当前 Revision 默认`。
为什么在服务端算：Run 投影按 #211 口径**不出 agentId**（id 不进团队投影），前端无法自行知道
「会继承哪个 Agent」；且预览跟的是 Agent 的**当前** Revision 默认，不是上一 Run 自己固化的档
（Revision 默认可能在上一 Run 之后改过，新 Run 每次重新解析）。该函数与
`run/orchestrator.ts` 的建 Run 解析**同式**，两处成对，改要成对改。

null 语义：本任务还没有 Run 可继承（首句本就走 RunLauncher，那里有自己的确认），或其 Agent
已归档/无当前 Revision（这种情况下一条指令本会被 Hub 拒，走既有错误路径）。

## 驱动与判定

- **Q1 web 面**（`apps/web/tests/instruction-composer.spec.tsx`，#244 组 7 例）：三条来源的
  胶囊文案（含默认态可见、未知态不编造）；full_access 先弹确认——取消不发且正文保留、确认后
  恰好一次；approval_required 不弹确认直接发。Cmd+Enter 与按钮同走 form submit，闸门共享。
- **Q2 集成面**（`apps/hub/tests/approval-policy.integration.spec.ts` 末例，CI 验）：无 Run →
  null；有 Run → 当前 Revision 默认；**关键区分度**——同一载荷里预览=full_access（跟 v2 默认）
  而 `runs[0].approvalPolicy`=approval_required（上一 Run 固化值），证明预览不是抄运行卡；
  Task 覆盖优先、清除回跟。
- **Q0**：`pnpm check` 全绿（1332 过 / 7 预期失败为既有深色 `it.fails` 债）。

## 设计取舍记录

- **不做「点开改档位」**：责任边界（改档=ApprovalPolicyBlock 的 assignee-only 动作）。对照物
  的三档菜单也不抄——我们协议只有两档，第三档（自动）没有对应语义。
- **视觉**：full_access 才升格成带底胶囊（warn-900 字 + warn-soft 底，与被拒理由块同 900 档
  AA 判据族）；approval_required/未知保持 muted 小字。放权要显著，常态不打扰。
- **pendingBody 快照**：确认动作发送「用户看到的那句话」——对话框模态期间正文不可编辑，但
  发送别在关闭时重读 state。

## 边界与债

- Q5 e2e 未补（本地 Docker 不可用），挂 #243 总账的既有债；组件 spec 已覆盖行为面。
- 预览是**读模型快照**，确认框弹出期间档位可能被责任人改掉——Hub 建 Run 时按当时值重新解析
  固化，UI 预览不越权预判结果（与 RunLauncher 的 run-policy-hint 同口径）。
