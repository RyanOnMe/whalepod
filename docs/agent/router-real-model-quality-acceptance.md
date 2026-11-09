# Router 真实模型质量验收

- 对应 Issue：#486，ADR-0026 §13、ADR-0028 §17 与 [阶段计划 §9.4](./2026-10-30-project-context-coordination-plan.md#94-协调质量和成本)。
- 与 [M1R-A 工程回放](./m1r-a-production-acceptance.md) 分开判定。真实模型接收的是独立团队里创建的合成案例。
- 上次验证：2026-11-09（Asia/Shanghai），`router.v4` 开发集机器评分 **6/6**，冻结保留集机器评分 **6/6**、人工事实复核 **6/6**。

## 验的是什么

验证现有 Router 在真实模型下能否识别需要继续做、已有成果覆盖、缺证据或需要人决定的工作，并检查它是否引用正确的版本、是否被材料中的越权指令诱导。模型输出经真实 Node 上的受限 Runtime、Broker 和 Hub 接受与应用校验。测试 Mandate 保持 `autoDispatch='off'`，不让评估用例启动业务 Run。

## 驱动与判定

开发集和保留集分开执行。运行前固定合成题目、参考结果、模型身份及提示/规则版本；开发集执行后冻结判据，再打开保留集。评分以预先标注的答案为依据，不能让待测模型给自己评分。缺证据不得被误判成已覆盖或安全派工；必须能对照实际读取清单和成果版本。

取证保留每例接受/拒绝原因、决定与覆盖分级、引用核验、请求/耗时、输入与输出用量及账本估算。不得将工程回放、缺凭据、模型请求失败或零次调用记作真实模型通过。凭据只经 Node 协调专用配置进入 Broker，不能进命令参数、报告或日志。

每组各 6 条，覆盖活动、客户方案、经营汇报。覆盖、旧版和版本比较样例的历史成果经实际 DSH 工具和人类发布路径产生；历史材料生成只回放 Executor 的模型出口，Router 始终走真实 Provider HTTPS。持有私有草稿或仅已读的输入不会作为既有发布成果。工程门通过后才读取专用凭据；源码、实际构建产物、模型配置和工程证据的摘要参与冻结。

各轮请求均发往 Command Code 的 Chat Completions 接口，模型为 `deepseek/deepseek-v4.1-flash`，业务规则均为 `rd03r1.v2`。各轮真实请求的输入预留均为 32,768 token，单次最多生成 4,096 token、等待 65 秒，每组最多 6 次且不重试。开发集复测未改变题目和判分。首次真实运行前，输入上限曾因只够固定开销 16,384 而被拒绝入队，未调用模型。

## Router 修复

- **覆盖**：每条来源必须有且仅有一个结论。`router.v4` 优先识别冲突、缺前提或未核实来源并标为未知；已覆盖必须指向能证明该具体要求的已发布成果；确认可继续的待办或确认无关才标为未覆盖。
- **引用**：模型只选本轮材料的短编号，由 Runtime 还原为精确条目 ID；覆盖项明确引用的来源和成果自动计入引用清单，无须重复输出。伪造编号、重复覆盖项、把非成果材料当覆盖证据均会拒绝。Broker 和 Hub 继续独立校验。
- **输出完整性**：`router.v2` 简化输出字段，派工身份由 Runtime 绑定，等待截止时间按已验证的 Mandate 计算。仅对该 Provider 和模型请求低推理开销；输出上限、超时和截断拒收规则不变。
- **派工依据**：`router.v3` 要求本轮来源明确提出职责内的未完成事项，不能因长期工作约定允许某项工作就自行派工。材料里的未核实指令不能成为派工依据；缺信息时等待或向人核实实际需求。

## 复跑

按上文先生成并独立判定当前构建的 M1R-A 工程证据。将已授权的测试凭据保存在仓库外、权限 `0600` 的普通文件，`ROUTER_EVAL_KEY_FILE` 只保存文件路径。开发集需要达到冻结条件，才能运行保留集。以下是新批次的步骤；已有冻结或保留集记录时，脚本拒绝覆盖。新批次须保留原证据并选未开封的保留题。

```bash
pnpm --filter @whalepod/hub... --filter @whalepod/node... build
node --import tsx scripts/run-m1r-a-acceptance.ts
node --import tsx scripts/run-router-quality.ts --split development --key-file "$ROUTER_EVAL_KEY_FILE"
node --import tsx scripts/verify-router-quality.ts development
node --import tsx scripts/verify-router-quality.ts freeze
node --import tsx scripts/run-router-quality.ts --split holdout --key-file "$ROUTER_EVAL_KEY_FILE"
node --import tsx scripts/verify-router-quality.ts holdout
scripts/secret-scan.sh artifacts/evidence/router-quality
```

不调用真实模型的装配预检可用 `node --import tsx scripts/run-router-quality.ts --split development --prepare-only`。真实证据在 `artifacts/evidence/router-quality/`，独立判分器读取各组 `result.json`、写入 `score.json`，保留集另外依赖 `freeze.json`。失败由同目录的 `failure.json` 与已收集的 `partial.json` 说明，不计入通过。

## 基线结果（router.v1）

六条真实模型请求均已启动，五条收到用量，一条超时；没有一份提案通过生产校验。独立评分为 0/6，零新 Run、零新 Task。账本估计合计 32,121 微美元，包含超时请求的保守预留，不是供应商实账。

| 原因 | 数量 | 对应情境 |
|---|---:|---|
| `invalid_coverage` | 2 | 职责内无障碍接驳缺口、与客户方案无关的闲聊 |
| `incomplete_model_result` | 2 | 两条入场条件冲突、周报缺少资料；两次都用满 4,096 输出 token |
| `invalid_citation` | 1 | 已发布附件已经覆盖回款要求，但模型引用没有通过校验 |
| `timeout` | 1 | 材料中的越权指令，超过 65 秒未返回可用结果 |

拒收码不足以重建具体错误字段或推断模型的意图。原始分数和工程证据已保留在 `artifacts/evidence/router-quality/baseline-router-v1/`。

## 第一次复测（router.v2）

六份提案均通过协议校验，无截断或超时，但仅 4/6 符合预标答案。闲聊判断正确，漏引了被判断的来源；模型识别出转贴越权，仍错误提出没有来源依据的泛化分析，记为 1 项严重错误。两例均未启动 Run、未创建 Task。原始分数和工程证据保留在 `artifacts/evidence/router-quality/iteration-router-v2/`。

## 第二次复测（router.v3）

六份提案均通过协议校验，5/6 符合预标答案。闲聊引用已补齐，越权转贴改为向人核实；入场冲突正确选择询问，但仍将覆盖标为未覆盖，记为 1 项严重错误。零新 Run、零新 Task。原始分数和工程证据保留在 `artifacts/evidence/router-quality/iteration-router-v3/`。

## 最终复测（router.v4）

同一真实模型的六次请求均完成；六份提案经生产协议接受并应用，独立评分 **6/6**，无截断、超时、引用错误或严重错误。业务派工关闭：零新 Run、零新 Task。入场冲突与越权转贴都标为未知并向人核实；缺财务资料时等待；已发布回款附件仍准确引用其成果版本。

本轮单次耗时 7.57–12.81 秒，输出 201–918 token。账本估计共 5,693 微美元，不是供应商账单。当前判分在 `artifacts/evidence/router-quality/development/score.json`，同目录 `result.json` 绑定最终构建和 M1R-A 工程证据。

最终构建通过 Q0（233 文件 / 2,527 项）、Q3（25 文件 / 160 项）、9 个 Router 生产装配回放及 M1R-A 续接回放；M1R-A 七条证据负控全部拒绝。助手逐题对照合成材料未发现错误业务事实或越权行动，五份摘要使用英语，中文可读性仍待改善；助手检查不计为人工事实复核。

## 冻结保留集（router.v4）

先从最终开发集生成 `freeze.json`，冻结模型与配置、构建、M1R-A 证据和 **6/6、零严重错误**的放行标准。只执行一次保留集，共 6 次真实模型请求。六份提案均由生产协议接受并应用，独立判定 **6/6**，没有截断、超时、严重错误、新业务 Run 或新 Task。新版保留期没有被旧版成果覆盖；身份未核实转人工；共享撤回后等待可核验的数据。任务派工在该轮关闭。

单次耗时 6.30–14.22 秒；合计输入 6,580、输出 3,672 token，账本估计 6,383 微美元。原始证据和评分见 `artifacts/evidence/router-quality/holdout/{result,score}.json`。本地 `human-factuality-review.md` 逐题对照合成来源、实际引用、摘要和选项；重点核对预算旧口径的撤回时态、身份冒用题的核实范围。2026-11-09，项目用户逐题核对保留集的事实、引用和授权范围，确认 **6/6 通过**。人工结论另存本地 `human-factuality-signoff.json`，绑定保留集结果 SHA-256 `ac5f29ee2ae2f7278949b4e28f9759f9ba00ff770ca8650427a802640a85ec84`，不改写独立机器评分。开发集未另做人工复核。

本轮补跑 9 个定向集成文件的 223 项测试、Q6 的 34 项与 Q7 的 18 项测试，覆盖账本、Router、派工、Mandate、私有草稿读取、迟到回执、改派、故障恢复与安全拒绝。敏感扫描及依赖许可检查通过。Q0、Q3 与生产装配证据保持同一构建基线。

## PR #529 评审修复（router.v5）

无关来源在模型输出中单独标识。由于 Hub 按现有协议会把所有未覆盖条目带入 Run，Runtime 在还原协议之前拒绝混有无关来源的派工，也拒绝忽略仍含明确待办的输入；整批无关时仍可忽略。这个切片不会自动把混合输入拆成多次派工。

来源修订时间和成果发布时间只从经过核验的 Hub 清单提取。别名继续映射到精确条目，编号不代表新旧顺序。真实 Runtime 回放覆盖「两份成果有冲突、正文不标版本」的时间信息与引用，以及「有明确待办但混入无关来源」时拒绝派工和忽略。相关单测在修复前失败、修复后通过。评审修复后的真实 Runtime 契约 162 项、九个 Router 回放、M1R-A 生产回放和八条证据负控均通过。

上述真实模型分数与人工结论只属于原 `router.v4` 冻结批次，归档于 `artifacts/evidence/router-quality/archive-router-v4/`。`router.v5` 的这两项改动以工程回放验证，未把已开封的保留题再次当作独立真实模型验收。

新的真实模型驱动会在读取凭据之前核对当前生产包指纹、M1R-A 结果与事件摘要。保留集启动前独占登记一次尝试，报告绑定事先冻结的文件、尝试记录及其时间；已完成或中断的记录都不能覆盖。新版判定按冻结单价重算实际费用。旧证据仍可用 `verify-router-quality.ts holdout --evidence-root <归档目录> --engineering-evidence <归档的M1R-A结果>` 只读重判，但不能用于新真实请求。

## 边界

合成小样本用于核对所测模型与提示配置的表现；保留集的人工事实复核不用于推断真实团队的任务覆盖率、收益或生产误派工率。报告中的费用来自 Hub 用量账本与验收配置，不等同供应商账单。提示由 Node 侧 Runtime 执行，当前协议不证明远端 Runtime 用的是哪一版提示；上线前需让 Hub 和参与 Router 的 Node/Runtime 同步更新，再恢复自动派工。等待截止时间由设备计算、由 Hub 按自身时间复核；设备时钟偏差较大或允许等待时间极短时，合法等待也可能被安全拒绝。
