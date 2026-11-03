# RD-03c1：固定草稿工具面与 Mandate 步级预批准验收（ADR-0028 §7）

- 对应场景/门禁：Q0 / Q2 / Q3
- 对应 Issue：#509（母 #486；前置 RD-03a #505、RD-03b #507）
- 上次验证：2026-11-04 · 分支 `feat/p1-509-rd03c1-draft-tool-surface` · PASS

本切片边界：机器 Run 只装配固定草稿面；免审批步骤必须同时满足「面内工具名 + Mandate allowlist + 固定 action class + 路径/资源范围」。读限工作区与随 Run 下发的只读材料根，写限工作区内 `.whalepod/drafts/`；越界直接拒绝，不进入审批。`mandateInvalidated` 的逐次实时复核、跨 Run 授权状态同步、私有草稿受众扩展未做（RD-03c2/后续）。

## 1 验的是哪条用户路径

Task 责任人：

1. 在 Work 上建 active Mandate，显式选择 `allowedToolNames`（`read/write/edit/glob/grep` 的子集）；
2. RD-03a/03b 人工或自动派工创建机器 Run；
3. Hub 把 `{mode:'draft', allowedToolNames, mandateVersion, workKey}` 固化进 `run.start`；Node 原样透传进 `runtime.initialize`；
4. Runtime `tools/pre-execute`：
   - 面外工具（bash/run_code/workflow/subagent*/job*/skill/web/str_replace_editor/todo/goal/ralph…）→ `deny`，不产生 `approval.requested`、不执行；
   - `publish_artifact`/`read_work_input`/`read_project_context` → `allow`（结果/授权读取通道，私有草稿仍是 candidate）；
   - 面内 `read/write/edit/glob/grep` 命中 allowlist 后还要过路径范围：
     - `read/glob/grep` 目标必须在工作区或 `artifactInputsDir`/项目上下文 `entriesDir`/工作输入 `entriesDir` 内（含 symlink 归一）；`../`、绝对越界、symlink 逃逸 → `deny`；
     - `write/edit` 只能落在工作区 `.whalepod/drafts/` 内，其他路径 → `deny`；
   - 面内未命中 allowlist → 现有 `ask`；
   - 同一裁决另注册为 DSH 单调 `tools.guard`：即使后续 Plugin Pack 在 pre-execute waterfall 前置返回 allow，面外/越界调用仍被拒（guard 只能 deny，不能 force-allow）；
5. 人类 Run 不携带 policy，approval_required/full_access 语义不变。

## 2 驱动与证据

- Hub：`POST /works/:workKey/mandates` → 准入/approve/dispatch（RD-03a/03b 路径）→ `run.start` outbox payload。
- Node：`RunStartSchema.parse`（生产 wire schema）→ `run-manager` → `runtime.initialize`，单测断言 toolPolicy 原样透传、人类 Run 不携带。
- Runtime：`machineDraftToolDecision` 纯裁决表 10 项（含绝对路径、`../`、symlink、草稿区写、缺参/Windows 盘符）；`approval.contract.spec.ts` + `tool-path-scope.contract.spec.ts` 用真 boot/replay：
  - `tool-approval` fixture：policy 下 `publish_artifact` 零 `approval.requested`、仍产 `artifact.candidate`；
  - `tool-boundary` fixture：policy 下 `bash` 被 deny，零审批，tool/result 不含命令输出 `probe-ok`；
  - `tool-path-outside` fixture：allowlist 内 `read ../probe-secret.txt` 被 deny，零审批，正文不进 tool/result；
  - `tool-path-inside` fixture：allowlist 内 `read out/report.md` 零审批且读到正文；
  - `tool-path-draft-write` fixture：allowlist 内 `write .whalepod/drafts/probe.md` 零审批且真实落盘。
- 判据文件：
  - `packages/runtime-dsh/tests/tool-policy.spec.ts`（10）
  - `packages/runtime-dsh/tests/dsh-contract/approval.contract.spec.ts`（+2）
  - `packages/runtime-dsh/tests/dsh-contract/tool-path-scope.contract.spec.ts`（3）
  - `apps/hub/tests/work-dispatch.integration.spec.ts`（+4：run.start policy、缺 policy 拒绝、人类带 policy 拒绝、升级前缺 policy 的 queued Run 不下发）
  - `apps/node/tests/run-manager.spec.ts`（+2：machine 透传/人类缺省，透传前先过 `RunStartSchema`）
- 观测：`run.start.payload.toolPolicy`、`runtime.initialize.payload.toolPolicy`；不新增正文/路径字段，拒绝理由不含绝对路径。

## 3 判定

- **正控**：机器 Run 的 run.start policy 与 Mandate 版本/受控工具名/workKey 一致（测试用非默认 allowlist `write/edit`）；`publish_artifact` 在 policy 下零审批并产候选；allowlist 内工作区 `read` 零审批读到正文；allowlist 内 `.whalepod/drafts/` 写入零审批落盘。
- **负控**：policy 下 `bash`/`run_code`/`workflow`/`subagent*`/`job*`/`skill`/`web_*` 等逐名 deny；不产生审批、不执行；面内未 allowlist 的 `write/edit/grep` 走 ask；绝对越界/`../`/symlink 逃逸读与草稿区外写均 deny 且不产生审批；机器 Run 缺 toolPolicy 被创建核心拒绝；人类 Run 带 toolPolicy 被拒；升级前已入队、payload 缺 toolPolicy 的机器 Run 在 `beforeDispatch` 被取消；人类 Run 行为不变。
- **数据判据**：`RunToolPolicySchema` 只接受 `mode='draft'`、受控工具名、正版本、UUID workKey；`run.start`/`runtime.initialize` strict schema 拒绝面外工具名；路径裁决 fail-closed（缺参、空白、NUL、Windows 盘符）。

## 4 门禁

| 门 | 命令 | 结果（2026-11-04） |
|---|---|---|
| Q0 | `pnpm check` | 223 文件 / 2421 项通过（runtime policy 10 + Node 2） |
| Q2 | `pnpm test:integration` | 90 文件 / 871 项通过（`work-dispatch` 47 项） |
| Q3 | `pnpm test:dsh-contract` | 23 文件 / 93 项通过（approval +2、path scope +3） |

## 5 单点变异

| # | 判据 | 变异 | 实测 |
|---|---|---|---|
| M52 | 面外工具 deny | 面集合检查改恒假 | 红（bash 不再 deny） |
| M53 | 隐式结果/读取通道 | 删 implicit allow | 红（publish/read_input 被 ask） |
| M54 | 面内未 allowlist ask | allowlist 判断改恒真 | 红（write/edit/grep 被 allow） |
| M55 | Hub 固化 toolPolicy | 删 createMachineRunForIntent 的 policy | 红（run.start 缺 policy） |
| M56 | 机器 Run 必须有 policy | 删创建核心检查 | 红（缺 policy 仍建 Run） |
| M57 | Node 透传 policy | 删 initialize 映射 | 红（Runtime 收不到 policy） |
| M58 | 读路径越界 deny | 读根检查改恒真 | 红（`../probe-secret` 读到正文） |
| M59 | 写只进草稿区 | 写根检查改恒真 | 红（工作区其他路径可写） |
| M60 | 升级前缺 policy 不下发 | 删 beforeDispatch guard | 红（旧行仍返回 send） |
| M61 | 人类 Run 禁带 policy | 删创建核心 rejection | 红（人类 Run 接受 machine policy） |

## 6 边界与未交付

- `mandateInvalidated` 的逐次工具实时复核、跨 Run 授权状态同步未做；暂停/撤销仍只取消未执行 Run（RD-03a），已执行 Run 的工具调用本切片不因 Mandate 变化而阻断（RD-03c2）。
- 私有草稿沿用既有 Artifact candidate：只有 owner 可见，未发布不进入团队投影；`draftRecipientUserId` 仍未扩展跨成员受众。
- 读边界是「工作区 + 本次 Run 的只读材料根」；工作区内的敏感文件（如本地 `.env`）仍属于授权读取范围，是否进一步收窄到白名单由后续切片决定。写边界是 `.whalepod/drafts/`；项目源码的修改不进入机器 Run 自主面。
- 路径裁决在 pre-execute 做 realpath 归一后判定；本进程不防本机其他进程在检查与打开之间的 symlink 替换（威胁模型是工作输入提示注入，不是本机并发攻击者）。
- 工具名按 ADR-0026 的实施清单（`read/write/edit/glob/grep` 等）；rc.8 的 `read_image` 不在固定面内，图像输入机器 Run 会 fail-closed deny，若后续需要按 boot 清单扩展。
- `toolPolicy` 不落 Run 表，只存在不可变 `run.start` outbox payload；`beforeDispatch` 只对「缺 policy 的机器 Run」fail closed，不重新解析 allowlist（创建事务已校验，outbox 不可改）。
- 人类 Run 的 approval_required/full_access 行为完全不变；full_access 仍禁止用于机器 Run。

## 7 复跑

```bash
pnpm check
pnpm test:integration
pnpm test:dsh-contract
```
