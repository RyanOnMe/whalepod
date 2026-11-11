# RD-03c3a 受管来源与按件阅稿检查点

- 对应 Issue：#533（[ADR-0029](../adr/0029-private-draft-grants-and-agent-input.md)）
- 对应门禁：Q0/Q1/Q2/Q3/Q7；完整交付还要求生产链的 Q6 与 Q7，有 UI 时加 Q5。
- 2026-11-11，#533 实施分支：验证独立设备认证、清单准备、一次本机模型调用、可信候选上传，以及显式开启的本机按件阅稿。正式外部模型、计费和正式执行档仍关闭。

## 用户路径与当前状态

真正的执行档 `managed_draft_source` 仍固定返回 409：不创建 Run、不发设备命令，也不消耗获批意图。责任人仍可独立选择普通派工；同一个幂等键不能把普通 Run 回执用作受管档回执。

独立开通的 `managed_draft_source_preparation` 只验清单准备。A 先在 `GET /api/v1/tasks/:taskId/managed-draft-sources` 查看当前模型绑定，再用同路径 `POST` 明确确认这个摘要、具体任务约定版本、B、期限及再交付用途；`DELETE .../:sourceId` 撤销。获批意图的 dispatch 请求还必须给出 `managedDraftSourceId`、部署中配置的 Node、Workspace 和 Profile。准备成功会消耗此获批意图并建立一个密封的 queued Run；合法回执后结束为 `cancelled`，从未启动，无模型用量或产物，也不占正式执行次数或失败次数。发前撤销、窗口超时也结束为 `cancelled`，但没有送达回执。普通 Node 在任何情况下都不能收到专用清单。

本机验收可显式选择 `managed_draft_source_execution_check`。只有同时配置独立受管 Node、模型绑定和本机模型接收端时才可用。Hub 只把清单发给本次绑定的专用 WS。打包 Node 先启动隔离 Runtime，等内核检查通过再一次性读取固定来源并校验摘要与字节数。模型入口只收控制元数据，Hub 从同一冻结来源重新构造实际请求，以本次有效来源、现场、模型身份、端点摘要、请求摘要和长度做持久的一次性裁决。裁决提交后由 Hub 发出唯一一次本机 POST；不向 Node 签发可兑换的许可。打包 Runtime 启动前检查输出根为空；隔离进程正常退出后，只复开固定位置的新文件，核对身份、链接、摘要和长度。Node 通过专用上传入口交付核验后的字节。Hub 用已通过裁决的模型返回摘要和长度再核一遍，在同一事务登记密封候选和独立上传回执；收到与这两件记录匹配的专用结果后才把 Run 标为完成。旧版本的受管 Node 不能接收这档命令。

数据库的 `run.managed_draft_source_digest` 只能在 Run 创建时写入，必须和机器来源、受限审批档、无历史或普通输入等条件同时成立，旧 Run 不回填。普通上传、正文、预览、批注、交接、追问、续跑和通用投影不处理未正式发布的受管内容；普通派工不会下发受管执行，普通事件收口不以设备给出的受众覆盖标记。私有候选进入独立存储；普通存储、团队 HTTP/WS、Work 历史、Router 历史和普通交接均不能取到它的身份、标题、摘要或正文。普通发布仍拒绝。

本机按件阅稿另需设置 `WHALEPOD_MANAGED_DRAFT_MEMBER_REVIEW=1`，且上述独立部署条件仍须满足。A 用自己的会话在 `GET /api/v1/managed-draft-candidates` 找到已完成且证明齐全的一件，经 `GET /api/v1/managed-draft-candidates/:artifactId/content` 核对固定字节和检查回执，再为来源登记的成员 B、同一摘要和有效期限提交 `POST /api/v1/managed-draft-candidates/:artifactId/grants`。B 用自己的会话在 `GET /api/v1/draft-share-grants` 只看到邀请状态与期限；经 `POST /api/v1/draft-share-grants/:grantId/accept` 接受后，才可从该 grant 的 `/content` 下载固定字节。该通道不需要 B 配对设备，不创建 Run。正文响应不缓存，权限每次在 Hub 复核。

## 复跑与判定

```bash
scripts/run-rd03c3a-component-checks.sh
```

复跑需 Node 24 和可用的本机 PostgreSQL 容器环境。上一检查点在 macOS 宿主实际跑通：25 项单元、98 项真实 PostgreSQL 集成、21 项 DSH/运行器组件。运行器的内核隔离只在 macOS 验证；Linux、未知宿主及正式模型提供方未测，不得开启。11 月 10 日本机执行检查点：全量 `pnpm check` 236 文件/2,564 项；Q2 兼容组合 135 项，最终受管相关 Q2 40 项；普通租约 Q6 13 项、macOS 运行器 Q3 22 项、Q7 18 项及敏感扫描和依赖许可检查均通过。 11 月 11 日上传与阅稿检查点：`managed-draft-source.integration.spec.ts` 20/20，受管组件单元 26/26，打包 Node 15/15，运行器及模型契约 Q3 22/22，租约 Q6 13/13，Q7 18/18；本次变更文件敏感扫描通过。

- 真实 PostgreSQL、生产 HTTP：获批派工要求受管档时连续两次得到 409，`run` 和 `dispatch_outbox` 无新增，意图仍为 `approved`；显式普通派工成功，再请求受管档仍不能重用该 Run。尝试修改普通 Run 的持久标记必须被数据库拒绝，不得留下修改。测试先在旧入口的 400、随后在不存在标记的 42703 跑红。
- 首个来源登记：仅当前责任人创建后未被编辑、并由同一人确认的最新任务约定可登记；保存来源字节摘要、接收人、再交付用途、模型出口身份和期限。来源换版、受管模型绑定变化、撤销、停用或改派均拒绝旧登记。改派 A → B → A 的旧登记复活曾实际跑红，现由改派事务同步撤销。
- 固定清单要求调用方先提供独立核验的受管现场，缺少该事实时拒绝，且检查当前 Mandate 并冻结约定、模型和到期；控制面契约拒绝自由指令、工作区路径、凭据槽和会话复用。单独的清单计算不写库；只有已获批、现场匹配的准备请求能把它与 Run 和专用出站命令一起提交。
- 受管通道：仅普通设备令牌、错独立凭证、普通 Device 借用独立凭证、未完成 hello、错部署代次都被拒绝。打包 Node 在实际 Hub/PostgreSQL 上收到严格清单并回执；普通 Node 只收到普通命令。受管 Node 不加载普通 Workspace、通用运行器或状态文件；准备档不读取来源正文。
- 生产清单链：HTTP 注册真实约定和模型绑定，批准真实意图，经持久 Outbox 锁内复核后由真实 WebSocket 发给打包 Node；对照普通 WS 没有清单，正文与普通提示均不入帧。数据库密封 Run 的普通上传和普通输入清单返回 404。合法回执只证明清单校验；发出前撤销或超时，`sent_at`、`acked_at` 均为空。普通重启恢复不得为受管准备补发普通命令。
- 真实执行检查：生产 HTTP/WS 和真实 PostgreSQL 驱动，打包 Node 启动打包 macOS Runtime；模型接收端实际收到且只收到一次固定 POST，其字节摘要与 `managed_draft_execution` 的决定一致。对照包括普通凭证、错请求摘要、重复读取和重复请求、换 attempt、普通输出口、进程退出以及断线时的清理与拒绝重放。先撤销来源时模型接收端收到零 POST；请求已经在途时，撤销可在接收端放回响应前提交，Hub 不再回送该模型响应。实际持 Outbox 行锁期间更换 WS，旧读请求未收到正文；临时恢复旧判定会返回 200。模型 HTTP 客户端保持连接时替换受管 WS，会主动中止已在途的本机请求；未加取消信号时该测试实际超时。
- 普通派工、Artifact、团队审阅、实时消息保留已有对照。独立复核后增加了设备切换的旧租约、改派后的 Work 历史脱敏和准备不消耗执行次数的真实对照；送达与回执在最终锁内检查真实时间。
- 阅稿资格组件：输入是服务端应在授权事务内取得的事实。正常完成、所有者、固定候选字节、写件与上传回执、当前 Mandate 和每一项来源权限均吻合时才给出最晚期限；16 项组件断言覆盖历史/失败 Run、普通上传、错误摘要、错用户/项目、换代与到期。组件通过不授予下载权。
- DSH 组件：固定 boot 的真实 Agent 的首轮及工具后的次轮都走同一个模型端口，端口拒绝越界 provider/model/session、辅助请求和取消；异常不携带来源字节，显式再试产生新的 attempt。macOS 上打包后的来源进程通过文件和网络隔离负控；真实本地 HTTP 接收端的出站检查证明授权绑定到发送字节，先撤权时零请求，重复与跳转均不重发。工作进程正常退出后，采集器复开固定空根内新写的文件并校验写件回执和字节；替换、软硬链接、失败退出、大小或摘要异常、重复采集均拒绝。本机链路补了 Hub 在线裁决与实际转发的证据，正式模型供应方和计费未验证。

- 可信上传：更新前真实打包链路虽然完成 Run，但候选为零，新断言跑红。现有完整链用真实 PostgreSQL、HTTP、WS 与打包进程生成一份精确候选；分别验证模型摘要绑定、写件和上传两个回执、持久记录防修改、旧版 Node 拒绝、错误设备、缺独立凭证、旧文件、模型 attempt 或内容不符、重复上传、撤销后上传、伪造完成与未完成候选不可见。普通成员的真实 WS 回放只获固定运行状态。
- 本机指定成员：真实候选由 A 核稿及发出按件邀请，B 无设备、接受前无正文、接受后只下载指定版本；其他成员、管理员和普通路径拒绝，读与授权均不新增 Run。撤销或来源失效后，旧邀请、接受回执和正文不能恢复读取。两个读撤顺序以同一 Task 行锁控制，B 经真实 TCP 连接请求正文；撤销先提交时响应无正文、无读回执，已先准入的一次读取仍返回固定字节，此后再读拒绝。普通 Run 对照能上传和发布，普通工作订阅能引用它；相同订阅入口拒绝密封 Run 或候选。任务提交评审再被普通 Run 带回进行中时，旧授权仍不能读取。

## 归因与取证

派工异常先看生产 HTTP 判据、`dispatch_intent` 状态、`run` 与 `dispatch_outbox` 的计数。检查本机执行时把 `managed_draft_execution` 的 WS 附着标识、读取裁决、模型 attempt 和请求摘要，与模型接收端的 POST 计数及字节摘要对应。上传看 `managed_draft_candidate` 与 `hub.managed-draft` 的 `candidate.verified`；人读授权看 `draft_share_grant`、`draft_share_read_admission` 与 `hub.draft-share`，不用 HTTP 日志里的正文核验。历史候选误分类先核对源 Run 的持久标记与迁移状态。资格证据只记录稳定拒绝原因；禁止在通用日志与证据包记正文、模型请求、候选标题、令牌、凭据或本机路径。通过运行结果和数据库断言区分组件、兼容回归与未运行的端到端场景，不记录虚构的 grant 或出站回执。

## 未达到的退出条件

配置默认关闭。准备检查需运维单独配对未承载普通 Run 的 Device、预登记它自己的 Workspace 标识和 Profile；`WHALEPOD_MANAGED_DRAFT_HOST` 配置 `deviceId`、`ownerUserId`、`workspaceId`、`profileRevisionId`、`managedHostGeneration`、`proofSha256`，只保存独立 32 字节随机值的小写十六进制字符串的 SHA-256。Node 用专用服务身份运行 `whalepod-node start --managed-draft-config <path>`，文件只允许服务账号读，含 `hubUrl`、同一部署身份与 `deviceToken`、`managedHostToken`，不与普通 Node 共用状态。公网必须 TLS；经 TLS 反代时固定直接对端 `tlsProxyAddress` 并让反代覆盖转发协议头。仅本机验收可使用 loopback 明文。`WHALEPOD_MANAGED_DRAFT_MODEL_ROUTE` 仅配置 `provider`、`model`、`endpointId`、`accountId`、`policyGeneration`、`expiresAt`，不配置凭证或请求 URL。

本机执行检查额外要求在 Hub 配置 `WHALEPOD_MANAGED_DRAFT_LOOPBACK_ENDPOINT`（仅支持带明确端口的数字回环 HTTP，不携带凭据），并在 Node 独立配置写入 `managedDraftExecution: true`。来源确认会绑定规范化端点地址摘要；更换端点或调整模型策略期限必须提高代次并重新确认。Hub 在数据库保留已激活代次的下限；旧进程或回滚配置无法恢复较早来源的权限。当前证据只覆盖 macOS 的隔离宿主与无凭据回环接收端。宿主被强制终止时可能留下仅服务账号可访问的临时文件，尚无跨重启清理验收。

正式外部模型、受控账户、计费和正式执行档尚未接入；人读默认为关闭，仅在本机验证部署显式启用。强制中断、写盘后连接失效或数据库提交失败可能留下未关联的私有文件；普通路径无法读取，跨重启清理和保留期限未验收。没有接入正式发布、Feishu 或 c3b。
