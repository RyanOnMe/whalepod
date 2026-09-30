# 关键动作可测性盘点（#85）验收

- 对应场景/门禁：Q5（e2e 定位稳定性）的前置摸底
- 对应 Issue：#85（P1-19 预审，切片⑥ 完成后收口盘点）
- 上次验证：2026-09-30 · `chore/p1-85-testid-inventory` · 结果 PASS

## 验的是哪条用户路径

e2e 与后续 Q5 用例对关键动作（审批决策、Run 取消/重跑、交付物发布/下载）的
定位稳定性：文案改了不该让测试断链；键盘路径要真的能走通。

## 盘点结果（选择器清单 + 证据）

| 动作区 | data-testid（组件落点） | e2e 使用证据（full-chain.spec.ts） |
|---|---|---|
| Approval 卡 | `approval-card` / `approval-tool` / `approval-reason` / `approval-preview` / `approval-expires` / `approve-button` / `reject-button` / `approval-waiting`（`RunTimeline.tsx:215-253`） | 310-332（allow：focus+键盘）、370（reject：focus）、318-319（等待态投影）、469/580/851 |
| Artifact | `artifact-download-button`（`ArtifactList.tsx:156`）、`artifact-publish-button`（`:221`） | 415（发布）、446（下载 digest 校验） |
| Run 操作（**本批补齐**） | `cancel-run-button` / `rerun-button` / `rerun-confirm-button` / `rerun-prompt`（`RunActions.tsx`） | 取消此前用 `getByRole` name 定位（760，键盘路径已实证）；现在文案与选择器双保险 |
| 观测面 | `run-live-events` / `run-lineage` / `run-placement` / `task-assignee` / `comment-author` / `instruction-*` 系列（切片⑥ 各分片随做随挂） | 272 等 |

## 键盘路径结论

- 全部动作控件是**原生 button**：Tab/Enter 天然可达，无需定制 tab 序。
  e2e 实证：`approve-button.focus()` 后键盘提交（332-334）、取消按钮
  `getByRole + focus`（760-762）。
- 下拉（审批无；Agent/设备选择走 SelectMenu）：键盘全路径 + 关闭回焦，
  判据在 select-menu acceptance。
- 覆盖层 Esc：RunConsole（⑥d）与 ConfirmDialog（#229）均有组件级判据。
- **未发现键盘不可达的关键动作**——无需可击替代。

## UI 驱动 vs HTTP 旁路分工（e2e 现状，写明口径）

| 动作 | 走法 | 理由 |
|---|---|---|
| 建项目/任务/接受指派/创建 Agent/启动 Run/审批 allow/发布/下载/取消 Run | **UI**（role/name 或 testid + 键盘） | 产品金路径必须真人走 |
| 邀请开通第二名成员 | HTTP 旁路（`hubApi POST /invites`） | 邀请 UI 属 #141 邀请链用例（invite-accept.spec），全链场景不重复 |
| 设备/任务状态轮询等待 | HTTP 旁路（只读 GET） | 观测等待不是用户动作 |
| 审批 denied（部分场景） | HTTP 旁路（`POST /approvals/:id/decisions`） | 同一决策路径已有 UI 判据（370 的 reject-button 键盘路径），旁路用于并发场景提速 |

## 本批改动

纯 `data-testid` 属性补齐（RunActions 四处），零行为变化；`run-actions.spec.tsx`
8/8 不变绿。

## 复跑

```bash
pnpm exec vitest run --project web apps/web/tests/run-actions.spec.tsx
```
