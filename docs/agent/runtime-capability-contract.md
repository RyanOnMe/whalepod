# Runtime Capability Contract（A0-6 / DSH 熔断）

- 对应门禁：**Q3**（`pnpm test:dsh-contract`）、Q6、Q7；本文是「哪些能力被机器钉住、哪些只是文档话」的**单一登记处**
- 来源：外部架构审查（总纲 §工程治理「DSH 熔断」四规则 + Capability Contract 六项）
- 历史核对：2026-10-09 · `feat/p1-a0-runtime-capability` · 结论：**六能力 = 4 有判据 / 3 部分（重叠）**；
  **四规则 = 2 有判据 / 1 部分 / 1 缺口已立账（#288）**；另修掉「文档写 G0 必跑、CI 无接线」
  这条治理缺陷（Q3/Q6/Q7 已进 CI）
- 历史核对：2026-10-16 · `fix/p1-288-dsh-compat-guard` · **四规则 = 3 有判据 / 1 部分**
  （「敏感不兼容禁启动」缺口补齐：DSH 版本自报与自动派生、pack 逐包 `dshCompatibility`
  fail-closed 比对、`profileDigest` 传递对照点；回滚半边仍归 #290）
- 历史核对（#289，2026-10-16）· `feat/p1-289-contract-negatives` · **六能力里的三项「部分」补成有判据**：
  单 Run 隔离（命令 runId 闸 + 契约级负向，含 followup/shutdown 命令族与结算屏障）、指令回执
  （Q3 契约门内）、事件流范围（异会话事件 + 异 agent 状态两条过滤的负向）；cancel 竞态与 followup
  中断边界仍无判据 → 单独立账 #353
- 最新核对（#290，2026-10-16）· `feat/p1-290-rollback-drill` · **四规则 = 4 有判据**（规则 4 的
  机检半边补齐：回滚演练进 Q3，判定实现与 lock-drift 共用；真实「装另一版 → 不兼容 →
  回滚安装树」如实标为人工门，步骤与预期输出在 dsh-upgrade skill）

## 〇、这份文件为什么存在

外部审查点名的问题不是「缺某个功能」，而是**能力边界上的诚实度**：DSH 是 Preview 依赖，
升级会带来 drift；如果某条能力只是文档里写着「有」，发布时就没人能回答「哪一行代码/哪一条用例
保证它」。所以本文每一行都必须二选一：**给出可点开的判据**，或者**标记未覆盖并挂 Issue**。
空着或含糊都算没做。

机检：`scripts/tests/runtime-capability-contract.spec.ts`（Q0 的一部分）会读本文件——
引用的每个 `*.spec.ts` 必须真实存在、引用的 `pnpm`/`bash` 命令必须在 `package.json` 里有定义、
标「未覆盖」的行必须带 Issue 号、六能力与四规则必须齐全。

## 一、能力契约（六项）

| 能力 | 判定命令 | 判据文件 | 覆盖状态 |
|---|---|---|---|
| sessionResume | `pnpm test:dsh-contract` | `packages/runtime-dsh/tests/dsh-contract/resume.contract.spec.ts` | 有判据：正向（同 session id + `fromRequest` 上下文命中 + 日志线性增长不复制）+ 负向（ghost id 拒绝启动、零帧） |
| 单 Run 隔离 | `pnpm test:dsh-contract`、`pnpm test:unit` | `packages/runtime-dsh/tests/dsh-contract/single-run-isolation.contract.spec.ts`（#289 新增）、`apps/node/tests/run-manager.spec.ts`、`packages/runtime-dsh/tests/dsh-contract/event-stream.contract.spec.ts` | 有判据：命令 runId 闸（跨 Run 的 prompt/followup/cancel/decide/shutdown 显式拒 + 正控收敛后清总账的零副作用 + 正控）、Node 串扰防护、事件关联 |
| 中断模式（cancel） | `pnpm test:dsh-contract` | `packages/runtime-dsh/tests/dsh-contract/agent-control.contract.spec.ts`、`cancel-race.contract.spec.ts`（#353 新增） | 有判据：cancel → `run.cancelled` 且**不得再出** `run.completed`；**竞态与 followup 边界**（#353）：① 流式中取消（同步点用 hang 前缀内容帧，收敛屏障后清总账：恰 1 turn/end aborted、0 completed、0 fatal）；② **取消与收尾撞车**（turn/end 已提交、settle 在途时送 cancel → completed 成立、**不得**补出 cancelled、不得 fatal，且取消不毒化会话：随后 followup 照常起第二 turn 的正控）；③ **中断边界的 followup**（运行中入队的 followup 被中断吞掉：零第二串 turn、零 fatal、恰 1 aborted；并以 spliced 事件钉住「followup = next-turn 入队，不是 steer 插话」）。窗口正中那一类交错无判据（见第五节） |
| 审批桥 | `pnpm test:dsh-contract`、`pnpm test:security` | `packages/runtime-dsh/tests/dsh-contract/approval.contract.spec.ts`、`apps/hub/tests/run-authorization.security.spec.ts`、`apps/hub/tests/approval-decision.integration.spec.ts` | 有判据：allowed_once / rejected / full_access 三态 + **未知 callId 双向 no-op**（A0-6 新增，Runtime 层此前零测试）+ Hub owner-only/一次性/过期 |
| 指令回执 | `pnpm test:dsh-contract`、`pnpm test:integration` | `packages/runtime-dsh/tests/dsh-contract/instruction-receipt.contract.spec.ts`（#289 新增）、`apps/hub/tests/instruction-queue.integration.spec.ts` | 有判据：契约门内覆盖「initialize 前显式拒且零帧 / 重复 initialize 显式拒 / 受理的 prompt 有回执且先于结算」；Hub 侧指令状态结算照旧 |
| 事件流范围 | `pnpm test:dsh-contract` | `packages/runtime-dsh/tests/dsh-contract/event-stream.contract.spec.ts`、`event-stream-scope.contract.spec.ts`（#289 新增） | 有判据：seq 单调/关联/顺序 + **越界（异会话）事件不转发、不结算**与**异 agent 状态不成帧**的负向（变异自证：两条过滤各自单点削弱即红）；范围语义自订阅面起算，总线分发作用域未覆盖（见第五节） |

## 二、熔断四规则

| 规则 | 判定命令 | 判据 | 状态 |
|---|---|---|---|
| 未知事件不给权 / **未知 Approval 只拒不放行** | `pnpm test:dsh-contract`、`pnpm test:unit`、`pnpm test:security` | Runtime 层：`approval.contract.spec.ts` 的未知 callId 双向夹逼（放行腿/拦截腿都不得被误认领，A0-6 新增）；Node 层：`apps/node/tests/projector.spec.ts`（未知 callId 回显零事件）；Hub 层：`run-authorization.security.spec.ts`（伪造 403 / 未知 404 且命令零新增）；协议层：`strictObject` 拒多余字段 | 三层都有判据（**A0-6 补齐了最靠近模型执行的那一层**） |
| **建不起归属不确认成功** | `pnpm test:dsh-contract`、`pnpm test:integration` | 续跑 ghost id → 拒绝启动、零帧（A0-6 新增）；Hub 非本设备 `run.event` → FORBIDDEN；artifact 实收字节 sha256 ≠ 声明 → `ARTIFACT_HASH_MISMATCH` 不落库；pack digest 三方复算；catalog↔tarball↔加载树闭环 | 有判据 |
| **敏感不兼容禁启动** | `pnpm test:dsh-contract`、`pnpm test:unit`、`pnpm test:integration` | #288 起有判据：Runtime 自报发行版身份（与 boot 锚同源，`dsh-distribution.contract.spec.ts`）、`--print-dsh-version` 真 bin 探针（`apps/runtime/tests/dsh-contract/dsh-version-probe.contract.spec.ts`）、pack 逐包 `dshCompatibility` 与本机版本 fail-closed 比对（descriptor 与本地命中两条路径 + 版本不可知都拒绝，`apps/node/tests/plugin-preflight.spec.ts`）、`profileDigest` 的 Node↔Runtime **往返**对照点（`boot.contract.spec.ts` 回声 + `apps/node/tests/run-manager.spec.ts` 不符即 `PROFILE_MISMATCH` 并终止；不校验 Runtime 装载内容）。原有：凭据缺失 spawn 前即 `MODEL_CREDENTIAL_UNAVAILABLE`、pack digest/信任级/lockfile 校验、overlay 行契约 fail-closed | **有判据**（#288；操作面与边界见 [dsh-compat-guard-acceptance](./dsh-compat-guard-acceptance.md)） |
| **升级失败回滚固定版** | `pnpm test:dsh-contract` | `packages/runtime-dsh/tests/dsh-contract/lock-drift.spec.ts`（三方一致：`dsh.lock.json` ↔ catalog ↔ pnpm-lock，判定实现见 `packages/runtime-dsh/tests/dsh-contract/helpers/lock-drift.ts`）+ `rollback-drill.contract.spec.ts`（#290 回滚演练：部分升级三种顺序（漏改 pnpm-lock / 只改 catalog / 登记项被删）、装错 tarball、catalog 写 range、空清单必红，单包三处自洽升级不红，回滚到锁定副本必绿且逐字节相同，锁 == 实际安装树（十项依赖）；七条变异自证）；真实安装回滚的步骤与预期输出在 `.agents/skills/dsh-upgrade/SKILL.md` 的「回滚」节 | **有判据（#290；锁三方一致 A0-6 起进 CI，回滚演练随之进 Q3）**；**真实「装另一版 → 触发不兼容 → 回滚安装树」仍是人工门**（需 registry/网络与真安装，含跨版本会话日志兼容性）——边界与演练复跑见 [dsh-rollback-drill-acceptance](./dsh-rollback-drill-acceptance.md) |

## 三、版本锁现状（2026-10-09 核对）

- `dsh.lock.json`：`@deepseek-ai/cordis` 4.0.1；`dsh` / `dsh-agent` / `dsh-app-boot` /
  `dsh-base` / `dsh-llm` / `dsh-llm-replay` / `dsh-session` / `dsh-tools` / `dsh-user-approval`
  全部 0.1.0-rc.8，各带 sha512 integrity；`requiredContracts` 8 项。
- workspace 依赖无 range/latest（`pnpm-workspace.yaml` catalog 全精确版本，`packages/runtime-dsh`
  全 `catalog:`）——机检在 `lock-drift.spec.ts`。
- **本机版本来源（#288 起）**：不再是操作者声明的字符串——Runtime 以 `--print-dsh-version`
  自报（解析 `@deepseek-ai/dsh/package.json` realpath，与 boot 锚同源），Node 启动时探针一次并用它
  上报 `node.hello.dshDistributionVersion`、同时供 pack 兼容闸比对。**升级 DSH 后必须重启 Node**
  （探针只在启动时跑一次；`dsh-upgrade` 流程本就要求重启）。
- **已知边界**：`plugins/fixtures/whalepod-fixed-time/package.json` 的
  `peerDependencies["@deepseek-ai/dsh-tools"]` 写作 `^0.1.0-rc.8`。它是 fixture 插件 tarball 的
  源码（不是 workspace 依赖），`lock-drift.spec.ts` 不覆盖它。范围锁定由该 fixture 的确定性
  tarball 重生成（`scripts/build-fixture-plugin.mts --check`）负责，不由版本锁负责。

## 四、CI 接线（A0-6 修掉的最大治理问题）

盘点的第一条结论不是「哪条判据缺失」，而是**门根本没跑**：门禁分级文档把 Q3/Q6/Q7 写成
G0「release 必跑、PR 必跑」，而 `.github/workflows/check.yml` 只跑 Q0（`pnpm check`）与 Q2。
本批把这四条门接到已有的必检 job 上（不新增 job = 不改仓库保护规则）：

| 门 | 位置 | 本机实测 |
|---|---|---|
| Q3（`pnpm test:dsh-contract`） | `check.yml` · `check` job 末尾 | 16 spec / 63 用例 ~3s（无 PG/Docker/网络；A0-6 接线时 39，#288/#289/#290 新增 24 条） |
| Q7（`pnpm test:security`） | `check.yml` · `integration` job 末尾 | 17.5s（含一次性 PG） |
| Q6（`pnpm test:resilience`） | `check.yml` · `integration` job 末尾 | 32 用例 9.5s（含一次性 PG） |
| Q5 / Q8 / Q9 | 保持 release 级 | 有明确理由：真实浏览器 / 机器规格判据 / 镜像构建；见 g0g1g2-tiers 与 compose-standard-loop-acceptance |

口径：**「必跑」只许写 CI 真会跑的门**；不打算接 CI 的门，要在门禁分级文档里写清为什么
（并写清它因此不能作为 PR 门的事实）。

## 五、未覆盖清单（别读成已验）

> #288 已从本清单划掉两项：`dshCompatibility`/`profileDigest` 的比对与对照点、本机 DSH 版本
> 自动派生。#289 划掉三项：单 Run 隔离、指令回执、事件流范围的契约级负向。#290 划掉一项：
> 升级失败回滚（换进线性化的回滚演练，真实安装回滚如实降级为人工门）。#353 划掉一项：
> cancel 竞态与 followup 中断边界（换进 `cancel-race.contract.spec.ts` 的三条判据；同一句里
> 新增的两条更窄的边界改挂 #363 与机制层记账）。剩下的条目维持原状。

- **「收尾窗口正中」的 cancel 撞车无判据**（#363）：replay harness 只能表达「每帧内容」，
  没有 per-frame delay / 动态 readyFile / gate 条目 ⟹ 「cancel 恰好落在 finish chunk 与
  turn/end 之间」这种**两侧都可控**的时序构造不出来。现有判据钉的是窗口两侧（流式中取消、
  turn/end 已提交后的迟到取消，后者由进程内微任务序确定性保证）；进程边界（真子进程）上的
  同一交错也未覆盖——`apps/runtime/tests/dsh-contract/stdio.contract.spec.ts` 没有 override
  环境通道。边界与理由见 [cancel-race-acceptance](./cancel-race-acceptance.md)。
- **中断时「在途 followup 不执行」的机制层未钉**：判据钉的是**结果**（无第二串 turn、无
  fatal、收敛到 idle）；vendor 内部到底是 `inbox.clear()` 还是「abort 后驱动直接抛出」都满足
  该结果（实测：把 `cancel` 改成 `keepInbox` 语义在 abort 路径下也不改变结果——所以判据对
  这个旋钮不敏感，这是如实记账，不是遗漏）。#353 的裁决不依赖该机制。
- 越界事件的**总线分发作用域**本身（事件该不该被派发到本订阅面，由 DSH 拥有）：无判据。
  #289 的范围判据自订阅面（`deliverSessionEvent` / `deliverAgentStatus`）起算，注入的是
  合成输入（探针接缝 `RuntimeProbeFace`，生产恒不设置）；边界见
  [runtime-contract-negatives-acceptance](./runtime-contract-negatives-acceptance.md) 的「边界与未覆盖」。
- `session identity mismatch` 硬闸：常规路径由 DSH 的 `session not found` 先拦；A0-6 的变异自证
  （把 resume 包成「失败就退化成新建」）证明该硬闸确实接住了退化（`bridge: session identity
  mismatch — expected <ghost>, DSH reports <新会话 id>`、零帧），但没有独立的常驻判据。
- 升级失败回滚的**真实安装面**：本演练判仓库四份锁定文件的一致性与回滚语义；「装另一版 →
  触发一次已知不兼容 → 回滚安装树」需要 registry/网络与真安装（registry 拉包）+ rebuild，含跨版本
  会话日志兼容性，属**人工门**（步骤与预期输出在 `.agents/skills/dsh-upgrade` 的「回滚」节，
  边界见 dsh-rollback-drill-acceptance）。
- Hub 侧 `profile_digest` 的产出面（从 Revision 行复算 == 存库值）无独立判据；#288 的对照点只覆盖
  Node↔Runtime 的往返一致（见 dsh-compat-guard-acceptance 的语义边界节）。

## 六、复跑

```bash
pnpm test:dsh-contract     # Q3：16 spec / 63 用例（含 apps/runtime 两文件 5 条），约 3s
pnpm test:security         # Q7：18 用例 + secret-scan 自检/实扫 + 许可门
pnpm test:resilience       # Q6：32 用例
pnpm check                 # Q0（含本文件的机检：scripts/tests/runtime-capability-contract.spec.ts）
```

## 七、变更纪律

- 动了 `packages/runtime-dsh`、`apps/runtime`、`dsh.lock.json`、catalog 的 PR：Q3 必跑（现在 CI 会跑）。
- 装了新 DSH 版本：先按 `.agents/skills/dsh-upgrade` 走，再回来核对本文件第三节与第五节。
- 本文件的覆盖状态列只许按**新加的判据**改；拿「反正有测试」当理由是改不动这张表的。
