# 安全负向用例族：审批归属 / 受众门 / 终态 / 伪造身份（A0，2026-10-09）

- 对应门禁：Q7（`pnpm test:security` 的 security project 半边）
- 对应来源：2026-10-08 外部架构审查「我会增加的安全验收」8 项（阶段总纲 A0 第 4 项）
- 对应文件：`apps/hub/tests/run-authorization.security.spec.ts`（7 例）、
  `apps/hub/tests/run-integrity.security.spec.ts`（4 例）
- 上次验证：2026-10-09 · `fix/p1-a0-security-negative` · PASS（Q7 全绿 4 文件/18 用例；含变异自证）

## 验的是哪条用户路径

**不是新功能，是既有安全不变量的负向面**：每条都以真人路径驱动（真 App + 真 PG + 真
Device Token 握手 / 真浏览器 WS），并用**反证**收口——拒绝之外必须证明「账本零变化、
命令零新增、旧授权没被复用」。正控与负控成对：没有正控的负向断言一律视为假通过。

## 判定（8 项 → 11 条机器判据）

| 专家项 | 判据 | 文件 |
|---|---|---|
| 1 Bob 不能批 Alice 的审批 | carol（第三方）与 alice（团队 Owner）对 bob 的 pending 审批 → 403 + 状态仍 pending + **零 decide 命令**；bob 本人 → 200 且恰好 1 条命令（正控） | authorization |
| 2 旧决定不能用于新 Run/新调用 | ① 终态后再决定：同决定幂等 200 但**不重发命令**、相反决定被拒、状态不被改写；② 同 callId 重放不把已决行拉回 pending；③ 新 callId 必须重新决定（旧放行不延续、无自动命令） | authorization |
| 3 Device 撤销后旧凭据无新权 | 撤销前能连（正控）→ 撤销后用同 token 握手 → **升级前 401**（不是"连上再踢"） | authorization |
| 4 失效授权不被复用 | 租约过期 → run `lost(RUNTIME_LOST)` + pending Approval 折叠 `cancelled`；此时 owner 再批准 → 拒绝、零新命令、Run 不复活 | authorization |
| 5 迟到事件不复活终态 | `completed`/`lost` 之后迟到 `runtime.ready` + `run.failed`：状态一字不动，但帧**落账留证**（run_event 行 ≥2，正控） | integrity |
| 6 密钥不进他人投影 | owner 受众帧含语料明文：bob（owner）收得到（正控）；carol（member）的 WS 帧与任务房间 **零出现**；同连接同 Run 的 project 行可见（强度对照：证明是受众门而非"没订阅"） | integrity |
| 7 不谎称"副作用已停" | 取消落地后终态 `cancelled` 且 `failureCode=null`、该 Task 仍只有 1 个 Run、零 `run.start` 命令（无自动重跑）；`RUNTIME_LOST` 失败不被标成 completed | integrity |
| 8 伪造身份/越权 ID | Device Token 连 Browser WS → 401；Cookie 连 Node WS → 401；第三方猜中 approval id → 403 零变化；未知 id → 404；两条非法路径零命令 | authorization |

## 变异自证（负向断言的"牙齿"）

按纪律逐族施加真实变异、确认测试变红、再回滚复绿：

| 变异 | 期望 | 实测 |
|---|---|---|
| `decide.ts` 删掉 owner 判定（`authorize(actor,'decide_approval',…)` 整段） | 专家 1 / 8 失败 | ✅ 2 例红 |
| `subscriptions.ts` 受众过滤放行一切（`payload.ownerUserId === subscriber.userId` → `true`） | 专家 6 失败 | ✅ 1 例红 |
| 回滚两处变异 | Q7 全绿 | ✅ 18/18 |

## 暴露并修复的既有缺陷：password-policy 依赖"空库起点"

本批给 security project 引入第 3、4 个文件后，`password-policy.security.spec.ts` 出现
**执行顺序相关**的间歇性红（`setup → 409`）：它从不 `resetDatabase`，默认自己是 project 里
唯一文件、PG 是 virgin。修复：文件 `beforeAll` 里补 `resetDatabase(db)`（文件内自清，
不吃别家留下的 Team）。修复后连跑 3 次全绿（此前 3 跑 2 红）。"

## 复跑

```bash
# Q7 全量（security project + secret-scan + 许可 gate）
pnpm test:security

# 只跑本族（一次性 PG）
pnpm exec tsx scripts/with-test-postgres.mts pnpm exec vitest run --project security \
  apps/hub/tests/run-authorization.security.spec.ts \
  apps/hub/tests/run-integrity.security.spec.ts
```

上次结果（2026-10-09）：security project 4 文件 / 18 用例全绿；变异两处均被抓（3 例红）。

## 边界与已知项

- **不重复覆盖已有一等用例**：G5-02（非 owner 403）在 `approval-decision.integration.spec.ts`
  已有深模块面；本族在 Q7 门内补的是组合面与反证（零命令/状态不变/正控）。
- 专家项 3 的「未完成授权不被撤销设备消费」以「撤销后无法建立连接（401）」表达——
  连接面是执行权入口；outbox 命令的投递侧已有 run-lifecycle 族覆盖。
- 专家项 7 的 UI 文案（"需验证外部状态"）由 web 面断言，不在本族；本族只钉账本语义
  （终态、failureCode、无自动重跑）。
- 检索口径的既有偏差（foreign 403 vs unknown 404）是 G5-02 已定规格，未在本批改动；
  04 §6.1「同形 404」的适用范围是 owner-only 读面（Run Event / 未发布 Artifact）。
