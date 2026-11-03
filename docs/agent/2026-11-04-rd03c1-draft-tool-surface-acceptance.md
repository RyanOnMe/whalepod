# RD-03c1：固定草稿工具面与 Mandate 步级预批准验收（ADR-0028 §7）

- 对应场景/门禁：Q0 / Q2 / Q3
- 对应 Issue：#509（母 #486；前置 RD-03a #505、RD-03b #507）
- 上次验证：2026-11-04 · 分支 `feat/p1-509-rd03c1-draft-tool-surface` · PASS

本切片边界：机器 Run 只装配固定草稿面；面内命中 Mandate `allowedToolNames` 的步骤免逐次审批，面内未命中走现有审批，面外直接拒绝。`mandateInvalidated` 的逐次实时复核、跨 Run 授权状态同步、私有草稿受众扩展未做（RD-03c2/后续）。

## 1 验的是哪条用户路径

Task 责任人：

1. 在 Work 上建 active Mandate，显式选择 `allowedToolNames`（`read/write/edit/glob/grep` 的子集）；
2. RD-03a/03b 人工或自动派工创建机器 Run；
3. Hub 把 `{mode:'draft', allowedToolNames, mandateVersion, workKey}` 固化进 `run.start`；Node 原样透传进 `runtime.initialize`；
4. Runtime `tools/pre-execute`：
   - 面外工具（bash/run_code/workflow/subagent*/job*/skill/web/str_replace_editor/todo/goal/ralph…）→ `deny`，不产生 `approval.requested`、不执行；
   - `publish_artifact`/`read_work_input`/`read_project_context` → `allow`（结果/授权读取通道，私有草稿仍是 candidate）；
   - 面内 `read/write/edit/glob/grep` 命中 allowlist → `allow`（步级预批准）；未命中 → 现有 `ask`；
5. 人类 Run 不携带 policy，approval_required/full_access 语义不变。

## 2 驱动与证据

- Hub：`POST /works/:workKey/mandates` → 准入/approve/dispatch（RD-03a/03b 路径）→ `run.start` outbox payload。
- Node：`RunStartSchema` → `run-manager` → `runtime.initialize`，单测断言 toolPolicy 原样透传、人类 Run 不携带。
- Runtime：`machineDraftToolDecision` 纯裁决表 5 项；`approval.contract.spec.ts` 用真 boot/replay：
  - `tool-approval` fixture：policy 下 `publish_artifact` 零 `approval.requested`、仍产 `artifact.candidate`；
  - `tool-boundary` fixture：policy 下 `bash` 被 deny，零审批，tool/result 不含命令输出 `probe-ok`。
- 判据文件：
  - `packages/runtime-dsh/tests/tool-policy.spec.ts`（5）
  - `packages/runtime-dsh/tests/dsh-contract/approval.contract.spec.ts`（+2）
  - `apps/hub/tests/work-dispatch.integration.spec.ts`（+2：run.start policy、缺 policy 拒绝）
  - `apps/node/tests/run-manager.spec.ts`（+2：machine 透传/人类缺省）
- 观测：`run.start.payload.toolPolicy`、`runtime.initialize.payload.toolPolicy`；不新增正文/路径字段。

## 3 判定

- **正控**：机器 Run 的 run.start policy 与 Mandate 版本/受控工具名/workKey 一致；`publish_artifact` 在 policy 下零审批并产候选；policy 下 `read` 在 allowlist 时零审批。
- **负控**：policy 下 `bash`/`run_code`/`workflow`/`subagent*`/`job*`/`skill`/`web_*` 等逐名 deny；不产生审批、不执行；面内未 allowlist 的 `write/edit/grep` 走 ask；机器 Run 缺 toolPolicy 被创建核心拒绝；人类 Run 带 toolPolicy 被拒（若走内部入口）；人类 Run 行为不变。
- **数据判据**：`RunToolPolicySchema` 只接受 `mode='draft'`、受控工具名、正版本、UUID workKey；`run.start`/`runtime.initialize` strict schema 拒绝面外工具名。

## 4 门禁

| 门 | 命令 | 结果（2026-11-04） |
|---|---|---|
| Q0 | `pnpm check` | 223 文件 / 2416 项通过（新增 runtime policy 5 + Node 2） |
| Q2 | `pnpm test:integration` | 90 文件 / 869 项通过（`work-dispatch` 45 项） |
| Q3 | `pnpm test:dsh-contract` | 22 文件 / 90 项通过（approval +2） |

## 5 单点变异

| # | 判据 | 变异 | 实测 |
|---|---|---|---|
| M52 | 面外工具 deny | 面集合检查改恒假 | 红（bash 不再 deny） |
| M53 | 隐式结果/读取通道 | 删 implicit allow | 红（publish/read_input 被 ask） |
| M54 | 面内未 allowlist ask | allowlist 判断改恒真 | 红（write/edit/grep 被 allow） |
| M55 | Hub 固化 toolPolicy | 删 createMachineRunForIntent 的 policy | 红（run.start 缺 policy） |
| M56 | 机器 Run 必须有 policy | 删创建核心检查 | 红（缺 policy 仍建 Run） |
| M57 | Node 透传 policy | 删 initialize 映射 | 红（Runtime 收不到 policy） |

## 6 边界与未交付

- `mandateInvalidated` 的逐次工具实时复核、跨 Run 授权状态同步未做；暂停/撤销仍只取消未执行 Run（RD-03a），已执行 Run 的工具调用本切片不因 Mandate 变化而阻断（RD-03c2）。
- 私有草稿沿用既有 Artifact candidate：只有 owner 可见，未发布不进入团队投影；`draftRecipientUserId` 仍未扩展跨成员受众。
- `write/edit` 的路径范围依赖 DSH 工具自身的 workspace 边界；本切片不额外做路径白名单。
- 工具名按 ADR-0026 的实施清单（`read/write/edit/glob/grep` 等）；若真实 Node 的工具名不同，Runtime 会 fail-closed deny，需以 boot 清单更新映射。
- `toolPolicy` 不落 Run 表，只存在不可变 `run.start` outbox payload；`beforeDispatch` 不重新解析 policy（创建事务已校验，outbox 不可改）。
- 人类 Run 的 approval_required/full_access 行为完全不变；full_access 仍禁止用于机器 Run。

## 7 复跑

```bash
pnpm check
pnpm test:integration
pnpm test:dsh-contract
```
