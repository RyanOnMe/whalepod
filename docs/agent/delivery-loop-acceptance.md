# 交付闭环生产装配验收（#442）

## 用户路径与范围

产出者发布准确版本并邀请同事；同事批注并提交；责任人固定本轮意见和方向，明确选择新执行；真实 Node/Runtime 消费冻结上下文并产出新版；责任人显式关联及发布；意见作者对照原稿和新版并人工收口。随后继续既有的跨任务交付、接收和固定输入执行链。

成果依据通过正式读面与页面展示历史来源 Run 和绑定约定。Office 专用档验证安全回退：DOCX 候选仍可显式发布、另一成员可下载原件并整件批注，但 owner 与成员都不能读取缺少可信隔离来源的新旧预览，页面明确说明隔离转换尚未开放。此前的真实 LibreOffice 正向转换被独立安全评审发现可通过文档外链读取宿主文件，已撤回为历史记录；不再作为当前功能验收。

## 驱动与生产装配

- `pnpm exec tsx scripts/run-handoff-loop.mts`：默认双成员审阅/修订/交接链，不要求可选转换工具。
- `pnpm test:e2e:delivery`：显式启用 Office 档；需要 Docker、系统 Chrome、Node 24 和 pnpm。当前不要求 LibreOffice；缺安全回退证据、缺字段、任一驱动失败都不能 PASS。
- 真实 Hub 的包解析构建入口、真实 PostgreSQL、两套浏览器会话、真实 Node session/preparation 和真实 Runtime 子进程。通过正式 HTTP/WS 路径创建团队、任务、运行和交付物；不直写业务表制造运行状态。
- 唯一模型缝是 DSH 确定性 replay。Markdown 与最小 DOCX 是本地前置样本，通过真实 `publish_artifact`、Node 采集和 Hub 上传。`fromRequest` 必须消费批注与方向才能输出对应文字；没有证明真实模型会正确修订真实需求。
- Node 使用和生产 CLI 一样的可选 `OfficePreviewGenerator`，当前只报告 `ISOLATION_REQUIRED`，不得启动未隔离的转换进程或上传 PDF。新增本机控制口只记录、读取真实 `runtime.initialize.executionContext`，原帧照常转发；不保存工作目录、凭据或完整帧。输入快照本身由真实 Hub 构建，未添加测试专用业务接口。

## 观测、独立判定与负控

浏览器事实在 `artifacts/evidence/handoff-loop/result.json`；驱动失败前后均清除旧结果。`scripts/verify-handoff-loop-evidence.mts` 独立运行既有交接判定、新增修订判定，Office 专用档还强制 Office 判定。判定器缺证据即失败。

修订判定交叉比较原稿身份/摘要、批次 Run、新候选、Runtime 真正收到的上下文、只选中的意见、晚到意见排除、候选发布前成员 404 与发布后 200、人工前无复核记录及意见作者最终复核。另从 Node 已有的输入副本观测中核对原稿实际文件字节摘要、冻结摘要和原稿字节数；缺文件或副本摘要不同必须失败，不能用上下文中的原稿名称替代文件实际到达。依据核对准确来源 Run 与绑定历史约定，不把页面成功等同于事实正确。

Office 判定要求两侧 preview-info 都返回 `ISOLATION_REQUIRED` 且不暴露历史预览元数据，直接 GET /preview 都必须拒绝，页面不得保留 iframe；原件发布前对成员三路隐藏、发布后下载摘要与字节不变，整件批注仍绑定原件及真实作者。旧的 PDF 成功事实不能通过当前判定。两侧原件下载都从可见 review-download 链接点击、等待真实浏览器下载事件、读取实文件字节和摘要后清理，独立核对下载路由及原件摘要，不能用独立 HTTP 直取替代页面可用性。历史 ready/旧回执拒绝由 repository seam 负控和真实 HTTP 整体拒绝共同证明，此条 Q5 不生成历史 PDF 前置。

负控分别在 `scripts/lib/delivery-review-evidence.spec.ts`、`scripts/lib/office-preview-loop-evidence.spec.ts`，包括缺数据、错摘要、漏隐私、漏批注、晚到意见、未消费修订方向、缺人工复核等。既有交接判定负控继续保留。

## 结果与证据

原有 248 项浏览器核对及转换成功记录已因独立安全评审失效，保留在 `artifacts/evidence/delivery-loop/history/pre-isolation-review/`，仅用于历史追溯。当前合并候选必须重新通过安全回退与修订重试/崩溃恢复的检查后记录最新结果。

当前证据仍归档为 `artifacts/evidence/delivery-loop/result.json`、`summary.json`、`verdict.json`。模型出口是合成角色和材料，不包含用户真实会话或凭据；自动驱动不代表团队效率提升。人员真实试用仍 not_run。本次用户明确授权独立 review agents 通过后合入，评审记录明确标注 AI 身份。

## 归因

| 现象 | 首先检查 |
|---|---|
| 意见未固定、批次重复或候选选错 | `web.delivery.revision` 的请求与 `hub.review` 的 round / Run 绑定 |
| Runtime 未收到意见或混入晚到意见 | `hub.run` execution-context 构建、`node.run` initialize 与 `runtime.bridge` 实际消费；本机只读观测口 |
| 原稿/依据错误或未知被当为空 | `hub.review` delivery-basis 的 Run 历史绑定、逐件可见性和 Web 文案 |
| 私有候选或原始诊断泄露 | `hub.review` actor 过滤、`hub.artifact` preview 归一化与历史回执投影 |
| Office 未出现可读 PDF | `node.artifact` 隔离策略拒绝、Hub preview-info 与直接读取拒绝、`web.office-preview` 回退说明 |
| 脚本绿但独立判定红 | result.json 对应节的缺字段/不一致；不要用旧结果替代 |

失败诊断来自本次结构化事实和 Playwright 失败附件；原始临时环境、Token、绝对路径不归档。复跑使用上述 runner，不单独跑浏览器后跳过判定器。

## 未覆盖及下一步

- 本人双账号体验与真实双人对照均 `not_run`，按 [内部体验手册](./delivery-loop-internal-trial.md) 记录，不能从回放推出团队效率。
- 浏览器当前只走明确选择新执行；恢复/续接的故障与权限分支由相关 Unit/Q2 覆盖，未新增真实模型续接质量结论。
- PDF/图片区域锚点、复杂 Office 版式保真、历史预览回填、外部 IM/个人 Agent 集成继续暂缓。
- 本次不代表发布级 20 连、完整全项目 Q5 或 Q8/Q9；正式发布前继续按对应 release 门执行。
