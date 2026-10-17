# 两成员交接闭环生产验收（#381 / ADR-0017 验证节）验收记录

> 状态：实现与机器判据随批次④合入；本页登记「验了什么、怎么复跑、边界在哪」。
> 关联：ADR-0017、03 §「跨 Task 交接与下游固定输入」、docs/agent/evidence-map.md。

## 一句话

真 Hub（生产入口）+ 真 Node + 真 Runtime（DSH replay）把整条闭环**一次走完**：后端成员
启用约定并确认 v1 → 业务 Run 正常完成、**收尾自动整理**交接草稿（那次模型调用由录制+
旁车脚本化）→ 责任人核对后发布不可变 v1 → deliver 给前端成员（建同项目下游任务）→
前端成员填「本次准备做什么」确认（确认≠接受任务、不自动起 Run）→ 接受任务、配对自己
设备、默认勾选交接材料后执行 → 下游 Run 以**固定交接输入**执行：材料按快照摘要下载
（Node 副本实字节摘要 == 上游发布摘要）。负向面同步验：私有草稿对他人 404、重复确认
不重复创建且不覆盖首次理解、上游发 v2 不改任何历史 Run 的输入。事实落盘后由**独立
判定器**重判（缺证据/自相矛盾即 FAIL）。

## 机器判据（复跑入口）

| 判据 | 入口 | 覆盖 |
|---|---|---|
| 闭环生产装配（真浏览器+真 Hub/Node/Runtime） | `pnpm test:e2e`（`tsx scripts/run-handoff-loop.mts`，project `p1-381`） | 上面的全链 + 四个负向面；事实写 `artifacts/evidence/handoff-loop/result.json` |
| 独立判定器 | 同上 runner 链尾（`scripts/verify-handoff-loop-evidence.mts`） | 交叉一致性判据（材料身份与摘要三处同一；v2 前后 Run 快照 revisionId 相同；重复确认不覆盖；**隔离性检查必须跑在下游 Run 且与后端 Run 不是同一条**——评审 B10）；退出码即 runner 退出码 |
| 判定器自证 | `pnpm test:unit`（`scripts/lib/handoff-loop-evidence.spec.ts`） | 正控 + **22** 条逐条负控（每一类「缺证据/说了谎/同一条 Run 冒充两条」都判 FAIL；新增两条即 B10 的 Run 身份判据） |
| Runtime 收尾调用的脚本化 | `scripts/fixtures/handoff-loop/{session.jsonl,replay.override.json}` | 与契约探针同一录制协议；主回合（业务产出）+ 第二次调用（交接 JSON 叙述）。e2e 自持一份的理由：契约 fixture 的叙述内嵌契约测试自己的 runId，交叉任务引用会被发布校验拒绝 |
| Node 副本实字节取证 | `scripts/e2e-node.mts` 的 `prepareArtifactInputs` 观测缝（`copied[].fileSha256`） | 不改产品路径：prepare 的内部校验照常 fail-closed，观测只记录 |

## 六原语对位

- **驱动**：浏览器走产品 UI（建任务/启用约定/起草确认/开始执行/发布材料/发布交接包/
  交付/确认接收/接受任务/再执行）；配对码、换设备与 v2 发布走真人同款 HTTP；Node 生命
  周期走 e2e-serve 控制面（只做进程，不做产品动作）。
- **观测**：Task Room 聚合（assignmentStatus/runs/artifacts；**backend.runStatus 直接取自
  聚合行**）、`GET /runs/:id/handoff-draft`（owner 200 vs 他人 404；**draftOrigin/draftStatus
  取读面而非字面量**——评审 B10）、deliveries/receipts 列表、`GET /runs/:id/handoff-input`
  快照、Node 控制口 `copied[].fileSha256`、run 终态事实。
- **判定**：`result.json` 的离散事实 + 独立判定器的交叉一致判据（见上表）。
- **归因**：收尾整理在 runtime-dsh，草稿/发布与交付/确认在 hub.handoff，快照在
  hub.run.handoff-input，下载与摘要校验在 node.artifact-inputs，页面在 web.handoff-*。
- **取证**：`artifacts/evidence/handoff-loop/result.json`（脱敏、无路径/Token）；失败时
  Playwright trace 与 hub/node/vite 日志尾由既有 `collectEvidenceOnFailure` 归档。
- **发现**：本页与 03 文档、ADR-0017 已登记；索引见 `docs/agent/README.md`。

## 边界（不得当成已完成）

1. **真人试用一律 not_run**：本页只证机器闭环；「≥2 队闭环 / 80% 无口头补充正确接手 /
   交接耗时中位数降 30% / ≥2 队愿再用」是试用包
   （`operation-flow-usability-trial.md` 第六批 + 模板 `handoffTrial`）里的**决策目标**，
   不是已验证收益或统计结论。
2. **摘要不匹配的「失败」分支**：本批在真装配里证的是「按快照摘要下载且逐字节一致」的
   正向链；不匹配 → 明确失败（ARTIFACT_HASH_MISMATCH + 清目录 + run.start 拒绝）由
   Node 单测与 hub 集成裁决（批次③），e2e 不人为腐蚀内容。
3. **真实 Provider 不在本批**：replay 只证装配与状态链；真实模型延迟/质量/费用由产品方
   在试用中记录。
4. **单 Node 环境限制**：e2e-serve 同时只跑一台 Node，故按成员先后换设备（SIGKILL +
   重新配对）——这与真人「各自电脑」等价性由控制面说明承担，不是产品限制。
5. **v2 发布在本用例里走 HTTP 而非 UI**：发布入口的 UI 路径已由批次②的发布动作在本闭
   环中走过（v1）；v2 只是为负向面「上游更新不改历史 Run」造事实。
