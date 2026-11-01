# PC-00 rc.8 协调计算兼容性验收（#463）

- 对应门禁：Q0/Q1、Q3（`pnpm test:dsh-contract`）；不升级 DSH、不改协议、不接真实平台。
- 对应 Issue：PC-00 #463（上游固定提交 `6337fc823ce20251c8de8085948165c81aaa701e`；输入证据见 [2026-11-01-superagent-reuse-analysis.md](./2026-11-01-superagent-reuse-analysis.md)）。
- 上次验证：2026-11-01 · `feat/pc-00-rc8-coord-compat` · Q0 2240 例（205 文件）、Q1 1463 例（128 文件）、Q3 20 spec / 79 例。

## 验的是哪条能力

上游复用分析把「受限协调计算只回传结构化判断」列为持续协调的前提。本切片只验证这句话依赖的三项 rc.8 能力，不验证协调业务本身：

1. **工具禁用是权限边界**：patch 层 `disabled: true` 让插件不挂载，模型调用失败、命令零执行；不是 `ctx.tools.restrict()` 那种可见性遮罩。
2. **输入引用可达模型**：`read_artifact_input` 按清单白名单交付结构化元数据与正文；路径形 id 被拒且不带本机路径；无清单时工具不存在。
3. **结构化结果的可交付面**：rc.8 的 canonical value 是 execution-local、不随 `tool/result` 落库；模型可见内容由 `output.render` 投影决定，Hub 侧要解析的判断必须走这一面。

没有真实飞书租户、真实模型与后台常驻协调者；这些仍是 `not_run`（PC-01 #448、ADR-0025–0027 Proposed）。

## 驱动

```bash
# PC-00 契约探针（5 例；真 boot 栈 + replay LLM）
pnpm exec vitest run --project dsh-contract \
  packages/runtime-dsh/tests/dsh-contract/tool-boundary.contract.spec.ts

# read_artifact_input 的模型可见投影（3 例新增，共 10 例）
pnpm exec vitest run packages/runtime-dsh/tests/artifact-input-tool.spec.ts

# 整个 Q3 门（20 spec / 79 例）
pnpm test:dsh-contract
```

探针走与生产相同的 boot 路径 `dsh-base → whalepod bundle → replay 层`（`RuntimeBridge.start` → `bootDshTree`），只把 LLM 出口换成 replay fixture；没有测试专用近道，也没有直插业务表。禁用层是 `packages/runtime-dsh/tests/dsh-contract/overlays/disable-bash.yml`，通过 harness 的 `extraPatchFiles` 追加在 replay 层之后。

## 观测

- `session.event` 的 `tool/result` data：`message.source.callId`、`message.content[0].content[].text`（模型可见内容）、block 上的 `isError`、`data.error.{name,code}`。
- Runtime 帧：`runtime.ready`、`run.completed`、`approval.requested`（禁用用例必须为零）。
- 真实执行 marker：正控与旁路控的 bash 结果里出现 `probe-ok`；禁用用例的结果内容里绝不出现。
- 本机路径红线：输入引用的成功/拒绝结果与 `workspacePath`/`inputsDir`/`dshHomePath` 不同现。

## 判定

| 场景 | 机器判据 | 用例 |
|---|---|---|
| boot 层禁用工具 | 模型调用返回 `UNKNOWN_TOOL`（`unknown tool "bash"`）；结果内容无 `probe-ok`；零审批帧；`run.completed` 恰一帧 | `tool-boundary.contract.spec.ts`「a disabled row removes the tool」 |
| 正控：fixture 真能执行 | 同一 fixture 不禁用任何行时 bash 执行、结果含 `probe-ok`、`isError=false` | 「positive control」 |
| 归因控：禁用是行定位的 | 只禁用无关行 `tool-jobs` 时 bash 照常执行 | 「attribution control」 |
| 输入引用结构化交付 | 模型可见内容含 `artifactId/title/mediaType/byteSize/sha256/truncated` 与正文；路径形 id 返回 `unknown artifact input`；结果不含 `inputsDir`/`workspacePath`/`dshHomePath` | 「projects metadata and text content」 |
| 无清单 fail-closed | 两次调用都是 `UNKNOWN_TOOL`（`read_artifact_input` 不注册） | 「without a manifest」 |

## 归因

- 禁用失效时不是「fixture 坏了」：正控与旁路控同时绿，失败只能来自被禁用的那一行；探针注释写明 `approvalPolicy=full_access` 是为了让失效当场以 marker 暴露而不是挂在审批上超时。
- 输入引用失效时按 `tool/result` 的 block 内容定位：`isError`/`data.error.code` 区分「工具不存在」「白名单拒绝」「读取失败」。
- 结构化结果断层不是 DSH 错误：`data.message` 里没有 canonical value 是 rc.8 的文档化设计（`dsh-tools` README：「value … never replayed」），投影缺失只能由工具作者负责。

## 取证

```text
Q3：packages/runtime-dsh/tests/dsh-contract/tool-boundary.contract.spec.ts（5 passed）
Q1：packages/runtime-dsh/tests/artifact-input-tool.spec.ts（10 passed）
```

证据是测试输出与代码注释，不落 `/tmp`、不进 git 的绝对路径；探针断言本身阻止 `workspacePath`/`inputsDir` 进入结果面。

## 负控变异自证

| 单点变异 | 观察 | 复原 |
|---|---|---|
| `disable-bash.yml` 改成 `disabled: false` | 「a disabled row removes the tool」红：`isError` 期望 true 得到 false（bash 真执行） | 复原后 5/5 绿 |
| `artifact-input-tool.ts` 的 render 退回 `artifact input: <id>` | 「projects metadata」红：模型可见内容缺 `title`/正文 | 复原后 10/10 绿 |
| 不提供清单（既有负控） | 两次调用 `UNKNOWN_TOOL` | — |
| 只禁用无关行 `tool-jobs`（归因控） | bash 照常执行 | — |

## 发现与修复（#463）

1. **`read_artifact_input` 的模型可见投影缺失**：修复前 `render` 只回 `artifact input: <id>`，正文与结构化字段都没进模型上下文——Reviewer 实际读不到材料，只有接口。修复后投影含 `title/mediaType/byteSize/sha256/truncated/note` 与正文（超限截断沿用 64KiB 上限），单测与 Q3 探针同时钉住。协议、清单格式与读取白名单未变。
2. **`ctx.tools.restrict()` 不是权限边界**：vendor README 原文「live visibility composition, not an authority boundary」。协调计算的工具限制只能来自 boot 层插件禁用（本切片判据）、审批策略与沙箱；这条作为 ADR-0026/0027 的设计输入。
3. **结构化结果不随会话落库**：canonical value 是 execution-local，resume/replay 都拿不回来。跨 Hub 的结构化判断必须由 `output.render`（或 `finalizeContent`）投影成模型可见内容再解析，不能假设存在可回放的 JSON 值。

## 边界与未覆盖

- 只验证了 `tool-bash` 的禁用；其他工具行假定同一 vendor 行语义（`id` 定位 patch + `disabled`），未逐行探针。
- `tools.restrict()` 的「非权限边界」结论来自 vendor README，没有做运行期探针（需要探针专用 agent-scope 接缝）；本切片不以它作为控制手段。
- Code Mode `run_code`、subagent/fork 的工具面、沙箱升级路径未覆盖。
- 真实飞书租户/应用授权（PC-01 #448）`not_run`；真实模型、后台常驻协调、跨 Run 输入水位与 PostgreSQL 接线设计均未实现（ADR-0025–0027 接受前只做隔离试验）。
- 上游 144+4 项是隔离证据，不是本切片验收；本切片只复用其结论与固定提交。

## 复跑

```bash
pnpm exec vitest run --project dsh-contract \
  packages/runtime-dsh/tests/dsh-contract/tool-boundary.contract.spec.ts
pnpm exec vitest run packages/runtime-dsh/tests/artifact-input-tool.spec.ts
pnpm test:dsh-contract
```

任何一条红都按「未通过」处理；replay fixture 不存在或零用例执行同样算失败，不能沿用上次结果。
