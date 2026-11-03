# RD-03d1：改派后的 owner_confirmation 显式承接验收（ADR-0028 §2/§6）

- 对应场景/门禁：Q0 / Q2
- 对应 Issue：#513（母 #486；前置 RD-01、RD-03a/03b/03c）
- 上次验证：2026-11-04 · 分支 `feat/p1-513-rd03d1-owner-confirmation` · PASS

本切片边界：Task 改派后旧工作停在 `waiting(owner_confirmation)`；新 assignee 通过显式 API 承接同一 `workKey`，同时建立属于自己的新 Mandate。ask/decisionId/authorize_scope、Run 终态自动下一 Run、私有草稿受众、`apps/web` 未做。

## 1 验的是哪条用户路径

Task 责任人：

1. Owner/Admin 把 Task 改派给另一名成员；旧工作转 `waiting(owner_confirmation)`，旧 proposed 意图取消，旧 Mandate 保留为历史；
2. 新 assignee 接受指派（Task assignment accepted）；
3. 新 assignee `POST /works/:workKey/accept`，body 与创建 Mandate 同形；
4. Hub 同一事务：
   - 校验 assignee/任务状态/Work 等待态/Mandate 体/Agent 授权；
   - 插入 `version = latest + 1` 的新 Mandate，principal/onBehalf/humanOwner/draftRecipient 都是新 assignee；
   - 更新 Work `humanOwnerUserId`、`state='active'`、清空 resumeMode/resumeCondition、`mandateId=新版本`；
   - 取消旧 proposed 意图、撤回旧订阅；
5. 返回新 Mandate view（201）；旧 Mandate 不被改写、不转移；后续派工使用新版本。

## 2 驱动与证据

- 生产 HTTP：`POST /tasks/:taskId/reassign` → `POST /tasks/:taskId/accept` → `POST /works/:workKey/accept` → `GET /works/:workKey` / `GET /works/:workKey/mandates`。
- DB：`work`（state/resumeMode/resumeCondition/humanOwnerUserId/mandateId）、`work_mandate`（新版本与主体）、`dispatch_intent`（旧 proposed cancelled）。
- 判据文件：`apps/hub/tests/work-mandate.integration.spec.ts`（accept 正控 + 幂等 + 旧/未接受 assignee + 非法 body；既有 reassign 回归）。
- 观测：HTTP 审计 `work.accept`（actor/workKey/mandateId/version）；无正文。

## 3 判定

- **正控**：改派并接受指派后，新 assignee accept 201；Work active、owner 改为新 assignee、currentMandate 为新版本（version=旧+1，principal 新 assignee）；旧 Mandate 仍在历史但 current=false；之后可继续创建下一版本。
- **负控**：承接前 Work 非 `waiting(owner_confirmation)` → 403/409；新 assignee 未接受指派 → 409；旧 assignee → 403；非法 Mandate 体（面外工具名）→ 400 且 Work 保持 waiting/old owner；已 active 的 Work 用新幂等键再承接 → 409；旧 proposed 意图不复活。
- **幂等**：同一幂等键重放返回同一 Mandate，不产生第二版本。
- **数据判据**：新 Mandate 主体四字段一致；旧 Mandate 行不被更新；Work 指针指向新版本。

## 4 门禁

| 门 | 命令 | 结果（2026-11-04） |
|---|---|---|
| Q0 | `pnpm check` | 223 文件 / 2433 项通过 |
| Q2 | `pnpm test:integration` | 90 文件 / 885 项通过（`work-mandate` 26 项） |

## 5 单点变异

| # | 判据 | 变异 | 实测 |
|---|---|---|---|
| M71 | 只承接等待态 | 删除 state/resumeMode 守卫 | 红（已 active 的 Work 再承接不再 409） |
| M72 | Work owner 改新 assignee | 删除 `humanOwnerUserId` 更新 | 红（读面 owner 仍是旧 assignee） |
| M73 | 新 Mandate 主体是调用者 | principal 改回旧 work owner | 红（新 Mandate principal 不是新 assignee） |

## 6 边界与未交付

- `ask`/`decisionId`/`authorize_scope` 的决策账本与回答绑定未做（RD-03d2）。
- Run 终态后对收件箱 pending 条目的自动下一 Run 未做（RD-03d3）；本切片只保证承接后 work 可继续被既有准入/派工使用。
- 承接必须带新 Mandate 体：这是本 API 的原子设计，避免「先 active、后建 Mandate」窗口里旧 Mandate 被误用；不提供只改状态的裸承接。
- 旧 Mandate 不自动撤销/不改写，仅被新版本取代；审计与读面按版本历史解释。
- `apps/web` 未改；无 UI 入口。

## 7 复跑

```bash
pnpm check
pnpm test:integration
```
