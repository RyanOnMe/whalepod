# 交付闭环生产装配验收（#442）

## 用户路径与范围

产出者发布准确版本并邀请同事；同事批注并提交；责任人固定本轮意见和方向，明确选择新执行；真实 Node/Runtime 消费冻结上下文并产出新版；责任人显式关联及发布；意见作者对照原稿和新版并人工收口。随后继续既有的跨任务交付、接收和固定输入执行链。

成果依据通过正式读面与页面展示历史来源 Run 和绑定约定。Office 专用档额外走 DOCX 真实 LibreOffice 转换、产出者页面检查、显式发布、另一成员原件/预览阅读和整件批注；XLSX/PPTX 的真实转换由 Node 三格式检查覆盖，未宣称浏览器全部格式排版保真。

## 驱动与生产装配

- `pnpm exec tsx scripts/run-handoff-loop.mts`：默认双成员审阅/修订/交接链，不要求可选转换工具。
- `pnpm test:e2e:delivery`：显式启用 Office 档；需要 Docker、系统 Chrome、Node 24、pnpm 和执行机上的 `soffice`。缺转换工具、缺字段、任一驱动失败都不能 PASS。
- 真实 Hub 的包解析构建入口、真实 PostgreSQL、两套浏览器会话、真实 Node session/preparation 和真实 Runtime 子进程。通过正式 HTTP/WS 路径创建团队、任务、运行和交付物；不直写业务表制造运行状态。
- 唯一模型缝是 DSH 确定性 replay。Markdown 与最小 DOCX 是本地前置样本，通过真实 `publish_artifact`、Node 采集和 Hub 上传。`fromRequest` 必须消费批注与方向才能输出对应文字；没有证明真实模型会正确修订真实需求。
- Node 使用和生产 CLI 一样的可选 `OfficePreviewGenerator` 及上传客户端。新增本机控制口只记录、读取真实 `runtime.initialize.executionContext`，原帧照常转发；不保存工作目录、凭据或完整帧。输入快照本身由真实 Hub 构建，未添加测试专用业务接口。

## 观测、独立判定与负控

浏览器事实在 `artifacts/evidence/handoff-loop/result.json`；驱动失败前后均清除旧结果。`scripts/verify-handoff-loop-evidence.mts` 独立运行既有交接判定、新增修订判定，Office 专用档还强制 Office 判定。判定器缺证据即失败。

修订判定交叉比较原稿身份/摘要、批次 Run、新候选、Runtime 真正收到的上下文、只选中的意见、晚到意见排除、候选发布前成员 404 与发布后 200、人工前无复核记录及意见作者最终复核。另从 Node 已有的输入副本观测中核对原稿实际文件字节摘要、冻结摘要和原稿字节数；缺文件或副本摘要不同必须失败，不能用上下文中的原稿名称替代文件实际到达。依据核对准确来源 Run 与绑定历史约定，不把页面成功等同于事实正确。

Office 判定交叉比较 `sourceSha`、`previewSourceSha`、PDF 元数据、两侧可见 iframe 实际 Blob 的签名/摘要/字节、正式 HTTP 下载摘要；候选三路读取均须 404，公开后须 200，整件批注绑定原件版本及作者。PDF 魔数和字节一致不证明排版正确。

负控分别在 `scripts/lib/delivery-review-evidence.spec.ts`、`scripts/lib/office-preview-loop-evidence.spec.ts`，包括缺数据、错摘要、漏隐私、漏批注、晚到意见、未消费修订方向、缺人工复核等。既有交接判定负控继续保留。

## 结果与证据

2026-10-26 本地最终整合通过：build；Q0（203 文件、2,295 例）；Q2/Q6/Q7 合并串行项目检查（87 文件、635 例）；Q3（19 文件、74 例）；Office 专用 Q5（1 条双成员完整路径、248 项独立核对）；secret-scan 11 项自检、实扫与 626 包许可检查。最后源码为 `ccd0b9b`，后续仅证据/文档归档。

脱敏合成样本与摘要登记在 `artifacts/evidence/delivery-loop/result.json`、`summary.json`、`verdict.json`。未执行的门或真人试用不填通过。自动驱动用的是合成角色和材料，不包含用户真实会话或凭据。组合检查不等于正式发布全量门。

## 归因

| 现象 | 首先检查 |
|---|---|
| 意见未固定、批次重复或候选选错 | `web.delivery.revision` 的请求与 `hub.review` 的 round / Run 绑定 |
| Runtime 未收到意见或混入晚到意见 | `hub.run` execution-context 构建、`node.run` initialize 与 `runtime.bridge` 实际消费；本机只读观测口 |
| 原稿/依据错误或未知被当为空 | `hub.review` delivery-basis 的 Run 历史绑定、逐件可见性和 Web 文案 |
| 私有候选或原始诊断泄露 | `hub.review` actor 过滤、`hub.artifact` preview 归一化与历史回执投影 |
| Office 未出现可读 PDF | `node.artifact` converter/upload、Hub preview-info 的稳定码、`web.office-preview` PDF fetch 与 Blob 生命周期 |
| 脚本绿但独立判定红 | result.json 对应节的缺字段/不一致；不要用旧结果替代 |

失败诊断来自本次结构化事实和 Playwright 失败附件；原始临时环境、Token、绝对路径不归档。复跑使用上述 runner，不单独跑浏览器后跳过判定器。

## 未覆盖及下一步

- 本人双账号体验与真实双人对照均 `not_run`，按 [内部体验手册](./delivery-loop-internal-trial.md) 记录，不能从回放推出团队效率。
- 浏览器当前只走明确选择新执行；恢复/续接的故障与权限分支由相关 Unit/Q2 覆盖，未新增真实模型续接质量结论。
- PDF/图片区域锚点、复杂 Office 版式保真、历史预览回填、外部 IM/个人 Agent 集成继续暂缓。
- 本次不代表发布级 20 连、完整全项目 Q5 或 Q8/Q9；正式发布前继续按对应 release 门执行。
