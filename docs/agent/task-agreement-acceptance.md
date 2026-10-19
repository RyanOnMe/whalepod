# 任务约定（#378 / ADR-0017 §1-2）验收记录

> 状态：实现与机器判据随批次①合入；本页登记「验了什么、怎么复跑、边界在哪」。
> 关联：ADR-0017、03 §「任务约定与 Run 绑定」、docs/agent/evidence-map.md。

## 一句话

Task 内的四段约定（目标/约束/验收条件/待确认问题）有了版本化实体：草稿可编辑、责任人确认后
不可变；**启用约定流程后，全部 Run 创建入口统一绑定已确认版本**（缺省最新，可显式选任一本
Task 已确认版本），辅助 Run 按用途豁免；历史空值显示「未绑定」不补造。

## 机器判据（复跑入口）

| 判据 | 入口 | 覆盖 |
|---|---|---|
| 状态边与用途纯逻辑 | `pnpm test:unit`（`packages/domain/tests/task-spec.spec.ts`） | draft→confirm 唯一边；confirmed 终态；令牌 +1；辅助用途判定 fail-closed |
| HTTP 面（真路由+真会话+真 PG） | `pnpm test:integration`（`apps/hub/tests/task-agreement.integration.spec.ts` 前半） | 空态；草稿新建/CAS 409/版本递增/幂等重放；确认权限（非责任人 403/陈旧令牌 409/重复确认 409）；目标空白 400；开关权限与随时启用/停用；丢弃幂等；未知 Task 404 |
| 绑定收口 | 同文件后半（orchestrator/命令层直驱） | 启用后无版本→AGREEMENT_REQUIRED（含草稿在手也不放行）；显式绑定草稿 409；缺省=最新；显式旧版本=继承（新版本不改历史 Run）；停用不绑定；重跑缺省新版本；续跑缺省新版本/显式继承旧版本；辅助 Run 免绑定且投影如实；执行区指令与自动指派两条路都不得绕过；room 投影带版本号、历史行 null |
| 页面（真 Router+真 Query） | `pnpm test:unit`（`apps/web/tests/task-agreement.spec.tsx`） | 起草→保存→确认全链路（含请求体令牌）；非责任人无确认/开关；409 提示并重取、不静默重试；绑定提示；已启用未确认的显式提示；执行中更新横幅三选一（追问填入草稿/取消请求/保持本次收起）；未绑定历史运行不触发横幅 |

## 六原语对位

- **驱动**：integration 前段走真人同一条 HTTP（inject + 会话 Cookie + Idempotency-Key）；后段直驱
  orchestrator/sendInstruction/updateTask——与被拒路径同一批生产函数，无测试专用近道。
- **观测**：断言 HTTP 响应体、RunView/TaskRoomView 投影与 team_event（task.changed 带
  agreementEnabled）结构字段。
- **判定**：错误码（AGREEMENT_REQUIRED / CONFLICT / FORBIDDEN / VALIDATION_FAILED）、版本号、
  绑定 id 与「不落 Run」的计数断言。
- **归因**：绑定解析收敛在 `run/spec-binding.ts`（hub.run），草稿/确认在 `task/agreement.ts`
  （hub.task），页面在 web.task-agreement。
- **取证**：本页 + PR 描述；复跑命令见上表。
- **发现**：本页与 03 文档、ADR-0017 已登记；索引见 `docs/agent/README.md`。

## 边界（不得当成已完成）

1. **2026-10-19 #396 补齐 Agent 辅助起草入口**：责任人通过已有 Run 与私有 JSON Artifact 起草，检查后以检查前的草稿 CAS 令牌采用；仍需真人确认。不新增提案 wire，细节与复跑见 [内容实际消费验收](./handoff-context-consumption-acceptance.md)。
2. **未做竞态注入的编号分配压测**：编号分配在 Task 行锁 + 部分唯一索引下完成，但未写 deterministic
   并发用例；真实并发面由数据库约束兜底。
3. **停用不追溯**：停用后新 Run 不绑定、旧 Run 绑定与已确认版本不动（刻意）；「有确认版本但停用」
   的任务在 UI 上会同时显示「未启用」与「当前正式版本 vN」——这是事实陈述而非矛盾，如试用反馈
   有歧义再调文案。
4. **resume/rerun 的版本继承出默认采用最新**（ADR-0017 §2 的口径）：「显式继承来源版本」在协议层
   可用（传 specRevisionId），页面暂未提供该选择器——执行中更新横幅承担的是「追问/取消/保持」，
   不是版本切换，试用期先看真实需要。
