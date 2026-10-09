# Runtime Capability Contract（A0-6 / DSH 熔断）

- 对应门禁：**Q3**（`pnpm test:dsh-contract`）、Q6、Q7；本文是「哪些能力被机器钉住、哪些只是文档话」的**单一登记处**
- 来源：外部架构审查（总纲 §工程治理「DSH 熔断」四规则 + Capability Contract 六项）
- 上次核对：2026-10-09 · `feat/p1-a0-runtime-capability` · 结论：**六能力 = 4 有判据 / 3 部分（重叠）**；
  **四规则 = 2 有判据 / 1 部分 / 1 缺口已立账（#288）**；另修掉「文档写 G0 必跑、CI 无接线」
  这条治理缺陷（Q3/Q6/Q7 已进 CI）

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
| 单 Run 隔离 | `pnpm test:unit` | `apps/node/tests/run-manager.spec.ts`、`packages/runtime-dsh/tests/dsh-contract/event-stream.contract.spec.ts` | 部分：串扰防护在 Node 单测、事件关联在契约门；「一子进程只服务一 Run」的契约级负向未覆盖（#289） |
| 中断模式（cancel） | `pnpm test:dsh-contract` | `packages/runtime-dsh/tests/dsh-contract/agent-control.contract.spec.ts` | 有判据：cancel → `run.cancelled` 且**不得再出** `run.completed`；竞态与 followup 边界未覆盖（#289） |
| 审批桥 | `pnpm test:dsh-contract`、`pnpm test:security` | `packages/runtime-dsh/tests/dsh-contract/approval.contract.spec.ts`、`apps/hub/tests/run-authorization.security.spec.ts`、`apps/hub/tests/approval-decision.integration.spec.ts` | 有判据：allowed_once / rejected / full_access 三态 + **未知 callId 双向 no-op**（A0-6 新增，Runtime 层此前零测试）+ Hub owner-only/一次性/过期 |
| 指令回执 | `pnpm test:integration` | `apps/hub/tests/instruction-queue.integration.spec.ts` | 部分：Hub 集成与 Node 单测有覆盖，**Q3 契约门内零覆盖**（#289） |
| 事件流范围 | `pnpm test:dsh-contract` | `packages/runtime-dsh/tests/dsh-contract/event-stream.contract.spec.ts` | 部分：seq 单调、runId/dshSessionId 关联、turn 边界顺序齐；「越界事件必须被拒」的负向未覆盖（#289） |

## 二、熔断四规则

| 规则 | 判定命令 | 判据 | 状态 |
|---|---|---|---|
| 未知事件不给权 / **未知 Approval 只拒不放行** | `pnpm test:dsh-contract`、`pnpm test:unit`、`pnpm test:security` | Runtime 层：`approval.contract.spec.ts` 的未知 callId 双向夹逼（放行腿/拦截腿都不得被误认领，A0-6 新增）；Node 层：`apps/node/tests/projector.spec.ts`（未知 callId 回显零事件）；Hub 层：`run-authorization.security.spec.ts`（伪造 403 / 未知 404 且命令零新增）；协议层：`strictObject` 拒多余字段 | 三层都有判据（**A0-6 补齐了最靠近模型执行的那一层**） |
| **建不起归属不确认成功** | `pnpm test:dsh-contract`、`pnpm test:integration` | 续跑 ghost id → 拒绝启动、零帧（A0-6 新增）；Hub 非本设备 `run.event` → FORBIDDEN；artifact 实收字节 sha256 ≠ 声明 → `ARTIFACT_HASH_MISMATCH` 不落库；pack digest 三方复算；catalog↔tarball↔加载树闭环 | 有判据 |
| **敏感不兼容禁启动** | （缺口为主） | 有：凭据缺失 spawn 前即 `MODEL_CREDENTIAL_UNAVAILABLE`、pack digest/信任级/lockfile/dshCompatibility schema 校验、overlay 行契约 fail-closed。**无**：`dshCompatibility` 从不与本地 DSH 比对、`expectedProfileDigest` 只透传不比对、本机 DSH 版本由操作者声明（缺省 `unmanaged`） | **缺口**（#288，release notes 必须如实列出） |
| **升级失败回滚固定版** | `pnpm test:dsh-contract` | `packages/runtime-dsh/tests/dsh-contract/lock-drift.spec.ts`：`dsh.lock.json` ↔ catalog ↔ pnpm-lock 三方一致 + runtime-dsh 依赖必须 `catalog:`；回滚流程在 `.agents/skills/dsh-upgrade/SKILL.md` | 部分：**版本锁有判据**（A0-6 起进 CI）；回滚本身只有流程文档、无机检（#290） |

## 三、版本锁现状（2026-10-09 核对）

- `dsh.lock.json`：`@deepseek-ai/cordis` 4.0.1；`dsh` / `dsh-agent` / `dsh-app-boot` /
  `dsh-base` / `dsh-llm` / `dsh-llm-replay` / `dsh-session` / `dsh-tools` / `dsh-user-approval`
  全部 0.1.0-rc.8，各带 sha512 integrity；`requiredContracts` 8 项。
- workspace 依赖无 range/latest（`pnpm-workspace.yaml` catalog 全精确版本，`packages/runtime-dsh`
  全 `catalog:`）——机检在 `lock-drift.spec.ts`。
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
| Q3（`pnpm test:dsh-contract`） | `check.yml` · `check` job 末尾 | 39 用例 ~3.5s（无 PG/Docker/网络） |
| Q7（`pnpm test:security`） | `check.yml` · `integration` job 末尾 | 17.5s（含一次性 PG） |
| Q6（`pnpm test:resilience`） | `check.yml` · `integration` job 末尾 | 32 用例 9.5s（含一次性 PG） |
| Q5 / Q8 / Q9 | 保持 release 级 | 有明确理由：真实浏览器 / 机器规格判据 / 镜像构建；见 g0g1g2-tiers 与 compose-standard-loop-acceptance |

口径：**「必跑」只许写 CI 真会跑的门**；不打算接 CI 的门，要在门禁分级文档里写清为什么
（并写清它因此不能作为 PR 门的事实）。

## 五、未覆盖清单（别读成已验）

- `dshCompatibility` / `profileDigest` 比对、本机 DSH 版本自动派生（#288）。
- 单 Run 隔离、指令回执、事件流范围的**契约级**负向（#289）。
- `session identity mismatch` 硬闸：常规路径由 DSH 的 `session not found` 先拦；A0-6 的变异自证
  （把 resume 包成「失败就退化成新建」）证明该硬闸确实接住了退化（`bridge: session identity
  mismatch — expected <ghost>, DSH reports <新会话 id>`、零帧），但没有独立的常驻判据。
- cancel 竞态（取消与 turn 收尾同时发生）、followup 在中断边界的行为（#289）。
- 升级失败回滚固定版：仅流程文档，无机检（#290）。

## 六、复跑

```bash
pnpm test:dsh-contract     # Q3：39 用例，约 3.5s
pnpm test:security         # Q7：18 用例 + secret-scan 自检/实扫 + 许可门
pnpm test:resilience       # Q6：32 用例
pnpm check                 # Q0（含本文件的机检：scripts/tests/runtime-capability-contract.spec.ts）
```

## 七、变更纪律

- 动了 `packages/runtime-dsh`、`apps/runtime`、`dsh.lock.json`、catalog 的 PR：Q3 必跑（现在 CI 会跑）。
- 装了新 DSH 版本：先按 `.agents/skills/dsh-upgrade` 走，再回来核对本文件第三节与第五节。
- 本文件的覆盖状态列只许按**新加的判据**改；拿「反正有测试」当理由是改不动这张表的。
