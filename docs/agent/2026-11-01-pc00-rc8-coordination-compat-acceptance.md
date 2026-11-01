# PC-00 rc.8 协调计算兼容性验收（#463）

- 对应门禁：Q0/Q1、Q3（`pnpm test:dsh-contract`）；不升级 DSH、不改协议、不接真实平台。
- 对应 Issue：PC-00 #463（上游固定提交 `6337fc823ce20251c8de8085948165c81aaa701e`；输入证据见 [2026-11-01-superagent-reuse-analysis.md](./2026-11-01-superagent-reuse-analysis.md)）。
- 上次验证：2026-11-01 · `feat/pc-00-rc8-coord-compat` · Q0 2241 例（205 文件）、Q1 1464 例（128 文件）、Q3 20 spec / 81 例。

## 验的是哪条能力

上游复用分析把「受限协调计算只回传结构化判断」列为持续协调的前提。本切片只验证这句话依赖的三项 rc.8 机制，不验证协调业务本身，也不声称协调专用装配已经成立。

1. **工具行禁用**：patch 层 `disabled: true` 让**被禁用的那一行**从模型面消失、调用不可执行；这是 rc.8 提供的机制。本切片只对 `tool-bash` 一行做判据，其他行仍挂载（见「边界」）。
2. **输入引用**：`read_artifact_input` 按清单白名单交付结构化元数据与正文；投影内容真的进入下一次模型请求；路径形 id 被拒且不带本机路径；无清单时工具不存在。
3. **结构化结果的交付面**：rc.8 的 canonical value 是 execution-local、不随 `tool/result` 落库；模型可见内容由 `output.render` 投影决定，Hub 侧要解析的判断必须走这一面。

没有真实飞书租户、真实模型与后台常驻协调者；这些仍是 `not_run`（PC-01 #448、ADR-0025–0027 Proposed）。

## 驱动

```bash
# PC-00 契约探针（7 例；真 boot 栈 + replay LLM）
pnpm exec vitest run --project dsh-contract \
  packages/runtime-dsh/tests/dsh-contract/tool-boundary.contract.spec.ts

# read_artifact_input 的模型可见投影与 64KiB 边界（11 例）
pnpm exec vitest run packages/runtime-dsh/tests/artifact-input-tool.spec.ts

# 整个 Q3 门（20 spec / 81 例）
pnpm test:dsh-contract
```

探针走与生产相同的 boot 路径 `dsh-base → whalepod bundle → replay 层`（`RuntimeBridge.start` → `bootDshTree`），只把 LLM 出口换成 replay fixture。禁用层是 `packages/runtime-dsh/tests/dsh-contract/overlays/disable-bash.yml`，通过 harness 既有的 `extraPatchFiles` 探针通道追加在 replay 层之后；这与既有 Q3 探针的通道一致，除此之外没有测试专用状态注入或直插业务表。`extraPatchFiles` 不经过 Plugin Pack 的 insert-only 校验，所以本探针证明的是 **bundle 层 id 定位行**语义，不是 Plugin Pack 可以携带 id 定位行。

## 观测

- `session.event` 的 `tool/result` data：`message.source.callId`、`message.content[0].content[].text`（模型可见内容）、block 上的 `isError`、`data.error.{name,code}`。
- Runtime 帧：`runtime.ready`、`run.completed`、`runtime.fatal`、`approval.requested`。
- 请求级证据：replay 的 `{{fromRequest:<pattern>}}` 只能解析请求里真实存在的字符串；匹配不到会以 `runtime.fatal` + 明确消息失败（不是静默跳过）。
- 真实执行 marker：正控与旁路控的 bash 结果出现 `probe-ok`；禁用用例的结果内容里绝不出现。
- 本机路径红线：输入引用的成功/拒绝结果与 `workspacePath`/`inputsDir`/`dshHomePath` 三种路径逐条不同现。

## 判定

| 场景 | 机器判据 | 用例 |
|---|---|---|
| 禁用行从模型面移除 | 模型调用返回 `UNKNOWN_TOOL`（`unknown tool "bash"`）；结果内容无 `probe-ok`；错误文本经 `{{fromRequest}}` 进入下一次模型请求；`run.completed` 恰一帧 | 「a disabled row removes the tool」 |
| 默认审批下的真实顺序 | `approval_required` 下会先出现一次 `approval.requested`（toolName=`bash`）；`allowed_once` 后执行体仍解析失败（`UNKNOWN_TOOL`）、命令不执行 | 「approval_required: a disabled tool still asks once」 |
| 正控：fixture 真能执行 | 同一 fixture 不禁用任何行时 bash 执行、结果含 `probe-ok`、`isError=false` | 「positive control」 |
| 归因控：禁用是行定位的 | 只禁用无关行 `tool-jobs` 时 bash 照常执行 | 「attribution control」 |
| 输入引用结构化交付 | 模型可见内容含 `artifactId/title/mediaType/byteSize/sha256/truncated` 与正文；路径形 id 返回 `unknown artifact input`；结果不含三种本机路径 | 「projects metadata and text content」 |
| 投影进入下一次请求 | step 2 用 `{{fromRequest:PC00_ECHO_463}}` 引用只存在于投影的正文（唯一 token，prompt/manifest 里没有）；解析成功即证明正文进了模型请求 | 「the projected content reaches the next model request」 |
| canonical value 不在事件里 | `tool/result` 的 data 与 message 都没有 `value` 字段（rc.8 execution-local 契约的 event 面判据；耐久面是 vendor 文档结论） | 同上（两条 `Object.hasOwn` 断言） |
| 无清单 fail-closed | 两次调用都是 `UNKNOWN_TOOL`（`read_artifact_input` 不注册） | 「without a manifest」 |

## 归因

- 禁用失效时不是「fixture 坏了」：正控与旁路控同时绿，失败只能来自被禁用的那一行；`approvalPolicy=full_access` 只用于让失效当场以 marker 暴露而不是挂在审批上超时，审批顺序另有专门用例。
- 输入引用失效时：投影缺失会让 `{{fromRequest}}` 解析失败并带 pattern 原样出现在 `runtime.fatal` 的 summary 里，能直接定位到「正文没进请求」。
- 错误码只对 `UNKNOWN_TOOL` 稳定（`ToolNotFoundError` 是 vendor `HarnessError`）；白名单拒绝与副本不可读是普通 `Error`，只有 `isError` + 消息文本，没有稳定 code。归因时不要假设 `data.error.code` 能区分它们。

## 取证

```text
Q3：packages/runtime-dsh/tests/dsh-contract/tool-boundary.contract.spec.ts（7 passed）
Q1：packages/runtime-dsh/tests/artifact-input-tool.spec.ts（11 passed）
```

证据是测试输出与代码注释，不落 `/tmp`、不进 git 的绝对路径；探针断言本身阻止三种本机路径进入工具结果面。

## 负控变异自证

| 单点变异 | 观察 | 复原 |
|---|---|---|
| `disable-bash.yml` 改成 `disabled: false` | 「a disabled row removes the tool」红：`runtime.fatal` 明确报 `fromRequest pattern "Error: unknown tool \"bash\"" matched nothing`（命令执行了、错误文本不存在） | 复原后 7/7 绿 |
| `artifact-input-tool.ts` 的 render 退回 `artifact input: <id>` | 「projects metadata」红（缺 title/正文）；「projected content reaches the next model request」同样红并在 fatal summary 里指出 pattern 未命中 | 复原后 11/11 单测绿 |
| 不提供清单（既有负控） | 两次调用 `UNKNOWN_TOOL` | — |
| 只禁用无关行 `tool-jobs`（归因控） | bash 照常执行 | — |

64KiB 截断由单测边界用例钉住：先断言常量就是 64KiB（只拿常量生成样本的话，改常量不会红），再断言恰好 `INPUT_TEXT_ECHO_LIMIT_BYTES` 不截断、`+1` 截断到上限且 `truncated=true`。

## 发现与修复（#463）

1. **`read_artifact_input` 的模型可见投影缺失**：修复前 `render` 只回 `artifact input: <id>`，正文与结构化字段都没进模型上下文——Reviewer 实际读不到材料，只有接口。修复后投影含 `title/mediaType/byteSize/sha256/truncated/note` 与正文（超限截断沿用 64KiB 上限），单测与 Q3 探针同时钉住「内容进入下一次请求」。协议、清单格式与读取白名单未变。
2. **数据流变化**：正文现在会随 `tool/result` 进入模型可见内容，也会写进 Node 本地 DSH session 日志（`whalepod.patch.yml` 设为明文 `compression: none`）。这与既有 `tool-fs` 读取的可见性同级，`runtime-inputs` 下载副本仍按终态清理；证据包必须排除完整 DSH JSONL，只留脱敏片段。前提是 artifact 输入本身是团队可见的非凭据材料；含 Token/凭据的内容应在发布前过 secret-scan，不应作为输入交付。
3. **`ctx.tools.restrict()` 不是权限边界**：vendor README 原文「live visibility composition, not an authority boundary」。协调计算的工具限制只能来自 boot 层插件禁用（本切片判据）、审批策略与沙箱；这是机制层规则，协调专用装配尚未验证。这条作为 ADR-0026/0027 的设计输入。
4. **结构化结果不随会话落库**：canonical value 是 execution-local，resume/replay 都拿不回来。跨 Hub 的结构化判断必须由 `output.render`（或 `finalizeContent`）投影成模型可见内容再解析，不能假设存在可回放的 JSON 值。
5. **禁用工具仍会打扰一次审批**：vendor native 路径先经 `tools/pre-execute`，批准后执行体才解析失败。命令始终不执行，但「禁用行不产生审批打扰」不成立；若产品要求零打扰，需要在 pre-execute 之前加路由 guard（后续切片）。

## 边界与未覆盖

- 只验证了 `tool-bash` 的禁用。同一生产 bundle 仍挂载 `tool-fs`（read/write/edit）、`tool-fs-search`、`tool-workflow`、`tool-str-replace-editor`、`tool-web`、`tool-jobs`、`tool-subagent*`、`tool-todo`、`tool-goal` 等行；协调专用装配需要逐项禁用并各自探针，归 #463 的后续切片（ADR-0026/0027 接受前不实现）。`tool-workflow` 的 worker 不是安全沙箱（vendor README 明示），不能把「bash 被禁」当成执行面已关闭。
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
