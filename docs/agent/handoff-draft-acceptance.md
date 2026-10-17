# 交接草稿与发布（#379 / ADR-0017 §3-4）验收记录

> 状态：实现与机器判据随批次②合入；本页登记「验了什么、怎么复跑、边界在哪」。
> 关联：ADR-0017、03 §「交接草稿与发布」、docs/agent/evidence-map.md。

## 一句话

正常完成的执行在**成员 Runtime 收尾内**自动整理一份交接草稿（一次模型调用、≤60s、无业务
写入工具），失败/超时只标「交接草稿未生成」、业务结果不变；草稿是**责任人私有面**（owner
受众单条投影，管理员不可见，HTTP 404 收口），编辑走 CAS 令牌，发布校验（启用约定、证据附
引用、材料已发布）通过后成为**不可变版本**，修改=以上一版为种子新建再发布；失败/取消的
Run 不自动调用，owner 可手工新建/编辑（失败恢复）。

## 机器判据（复跑入口）

| 判据 | 入口 | 覆盖 |
|---|---|---|
| Runtime 契约（真 Runtime + replay） | `pnpm test:dsh-contract`（`packages/runtime-dsh/tests/dsh-contract/handoff-draft.contract.spec.ts`） | 成功帧序（handoff.draft 先于 run.completed、恰好一帧、单次调用）；超时→status:'failed' 且 run.completed 照发（业务结果不变）；无绑定时零帧；取消的 Run 零帧；**追问第二回合不再二次整理**（每 Run 至多一次，脚本耗尽作负向；单点变异有红）；**取消撞收尾窗口**取消胜出（零草稿帧、无 run.completed、恰一帧 run.cancelled） |
| 收尾调用模块 | `pnpm test:unit`（`packages/runtime-dsh/tests/handoff-draft.spec.ts`） | prompt 装配（约定/Artifact/对话尾部截断）；成功解析（含围栏 JSON、超 24KB 拒收）；失败分类（invalid-json/timeout/aborted）；DSH 终止 chunk 语义（adapter 失败不 throw 而是 finish{aborted}）；env 超时解析；**外部取消信号**（在途中断/已取消入口都归为 aborted，不干等超时） |
| HTTP 面（真路由+真会话+真 PG） | `pnpm test:integration`（`apps/hub/tests/handoff-draft.integration.spec.ts`） | 事件落库幂等且不复活终态；失败草稿→手工替换；**隐私**（他人与管理员 GET 均 404）；**受众纪律**（非 owner 受众的 handoff.draft 帧 fail-closed：VALIDATION_FAILED+整帧回滚，run_event/草稿行/团队扇出都不落）；running→409；编辑 CAS 409；发布校验链（未启用/证据无引用/候选材料/跨 Task run 引用）+ v1/v2 编号单调 + 发布后不可变；**容量**（材料>64 → failed('capacity-exceeded') 不抛穿 ingest 且换 seq 重发仍不抛；显式路径内容超 32 KiB → 409 且草稿不动；守卫按 DB 的 jsonb 文本口径计上界）；发布后重放帧不产生新草稿（含**换新 seq** 的已发布短路）；published 档 `failure_reason is null` 约束负向插行；**发布发 task.changed**（增量判据） |
| Node 投影 | `pnpm test:unit`（`apps/node/tests/projector.spec.ts`） | `handoff.draft` 恰好一条 **owner 受众** 的 run.event（无 project 镜像）；generated/failed 两态字段 |
| 页面（真 Router+真 Query） | `pnpm test:unit`（`apps/web/tests/handoff-draft.spec.tsx`） | ready 草稿编辑（含引用 token 逐键输入）→保存带并发令牌→发布后不可变提示；无草稿说明+手工新建；失败说明与未启用禁用；非 owner 404→面板整体不出现；running 不查询不渲染；发布校验失败原样展示不重试；引用 token 解析往返；**脏态闸门**（有未保存修改时发布禁用+提示，保存后恢复） |

## 六原语对位

- **驱动**：契约判据走真 Runtime spawn + replay provider（与生产同一条 run.start→帧路径）；
  hub 判据走真人 HTTP（inject+会话+Idempotency-Key）与 orchestrator 直驱；页面走真 Router。
- **观测**：runtime output 帧序、run.event 投影行（audience/字段）、HTTP 响应体与草稿/
  版本读模型、team_event、无人受众可见性用「他人 GET 404」实测。
- **判定**：帧的 status 与顺序断言、错误码（CONFLICT/NOT_FOUND/VALIDATION_FAILED）、
  版本号单调、CAS 不覆盖、发布后再次重放不新增行。
- **归因**：收尾调用在 runtime-dsh（`handoff-draft.ts`+bridge），持久化/发布在 hub.handoff，
  投影在 node.projector，页面在 web.handoff-draft。
- **取证**：本页 + PR 描述；复跑命令见上表。
- **发现**：本页与 03 文档、ADR-0017 已登记；索引见 `docs/agent/README.md`。

## 边界（不得当成已完成）

1. **整理质量未机器判定**：判据钉的是「帧到了、内容合 schema、失败不改业务结果」；叙述的
   事实正确性靠真人核对（`verified` 默认 false 的语义）——不做出题人兼裁判的自动评分。
2. **超时后晚到的成功不采用**：60s 上限到期即判 failed（AbortController）；模型若随后返回
   也会被丢弃——拒绝「迟到帧复活」，重试走 owner 手工新建。
3. **跨 Task 引用在发布层被拒**：artifact/run 引用必须属本 Task；跨任务材料的**合法**通道
   是批次③的显式交接输入（只允许同项目已发布成果），不在本批开放。
4. **管理员不可见是刻意收口**：草稿与未发布内容不进团队投影（03 §12 隐私规则），管理员
   排查问题需 owner 主动共享——试用期若反馈运维盲区再议（先例：#180 口径）。
5. **网页编辑器不做富文本/markdown 渲染**：六段纯文本 + 引用 token；格式美化留待试用反馈。
6. **内容容量守卫按上界计**：32 KiB 口径对齐 DB 的 `octet_length(content::text)`（jsonb
   文本为分隔符补空格），守卫把字符串里的 `:`/`,` 也计入 = 只会略早拒、不会漏拒
   （评审 F1：只数 `JSON.stringify` 会留窗口，超限行撞 23514 又成毒帧路径）。
