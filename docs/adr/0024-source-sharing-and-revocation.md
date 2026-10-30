# ADR-0024：外部来源以整团队共享绑定，撤销按授权代次级联失效

- 状态：已采纳（#450，2026-10-30；用户 2026-10-31 指示开始开发，按本 ADR 实施 PC-02a #455）
- 承接：计划 §4.1、§5、§5.3、§6「来源共享与撤销」
- 基线：`origin/main` `feb5856`。当前没有 Project 私有 ACL，也没有来源、同步水位、采集租约或后台任务设施

## 问题

下一阶段要把外部办公来源（群、云文档、表格）中允许共享的内容纳入项目上下文。来源绑定是新的授权面：它把外部内容变成整个 Team 可读的团队资产。现有实现没有 Project 私有 ACL，也没有来源、同步、采集和保留设施。如果不先固定绑定、权限重验、撤销级联与保留策略，PC-02 的 migration、协议和权限会各自发明一套，撤销容易只删原文而留下可重组内容。

本 ADR 只决定来源的共享、生命周期与撤销边界；上下文条目分类、后台模型提取和 Run 装配分别由 ADR-0025/0026/0027 决定。

## 决定

### 1 绑定粒度与共享范围

- 一条 ProjectSource 只绑定一个明确的外部资源身份：一个群、一个群内线程、一份云文档或一个表格范围。「群里的全部附件」不作为隐式范围。
- 同一 `(platform, resourceKey)` 同一时刻最多一个活动绑定；跨项目复用必须先撤销，不做一份外部内容同时进入多个 Project。
- 共享范围固定为整个 Team。当前没有 Project 私有 ACL，绑定后的正文、规范化副本、派生条目与引用对整个 Team 可见；私有 Workspace 不因绑定自动共享（ADR-0003）。
- 绑定请求必须显式确认 `shareScope: 'team'`，缺少即 400。Web 在提交前展示「哪些内容会进入 WhalePod、谁可以看到、撤销后哪些历史不可读」。
- 不满足整团队可读的来源（例如仅绑定成员可见的私人文档）只能保存链接，不纳入正文；不新增成员级来源 ACL。
- 绑定同时记录 `autoExtraction`（默认 `false`）。启用后也要等 ADR-0026 接受且采集 Node 声明相应能力，才允许后台模型提取。
- Project 归档时其来源自动暂停；不删除来源。Project 当前没有删除接口，本 ADR 不新增删除语义。

### 2 绑定、暂停与撤销的权限

- 任意成员可以绑定来源；记录 `boundBy`、采集 Node 与凭据槽位。首轮以「应用可读」加绑定成员显式确认「自己有权把该内容分享给整个 Team」为准，不做每成员 OAuth 令牌；若真实平台只有用户级授权才能读取，PC-01 必须记录并调整方案，不能把应用可读冒充成员授权。
- 暂停/恢复：绑定者或管理员（`owner` / `admin`）。
- 撤销：绑定者或管理员；撤销必须提供理由并写入审计。撤销是破坏性团队操作，同一绑定不能恢复。
- 成员被禁用或移除不自动撤销团队来源；管理员可撤销。采集 Node 被撤销、解绑或超过租约期离线时，来源进入 `unavailable`，不自动切换其他 Node。
- 外部资源无权限或不存在统一返回 403 `SOURCE_NOT_READABLE`，不区分存在性；不支持的来源类型返回 400 `SOURCE_UNSUPPORTED`；同一 `(platform, resourceKey)` 已有活动绑定时返回 409 `SOURCE_ALREADY_BOUND`；采集 Node 不在线返回 409 `SOURCE_COLLECTOR_OFFLINE`；离线且已绑定后的同步失败只更新来源状态，不删除绑定。

### 3 外部身份映射

- 平台账号不自动等于团队成员，也不因显示名相同而映射。
- 首轮只支持一种可验证映射：成员在 WhalePod 发起认领 → Hub 生成一次性码（10 分钟 TTL，只存 SHA-256）→ 成员用该平台账号在已绑定的群或线程发送该码 → Node 只读地读到「发送者平台 id + 码」并上报 → Hub 校验后记录映射。WhalePod 不向平台发送消息。
- 映射需要同一应用下的已绑定群或线程作为验证通道；只有云文档绑定时不提供映射通道，所有外部作者保持未映射，决定必须由成员在 WhalePod 内确认。
- 未映射的平台身份只作出处元数据（不透明 id 与显示名）；其文字不得自动升级为「决定」或「已批准」，界面显示「身份未核实」。
- 映射随来源撤销或成员被移除而失效；不跨来源复用，除非重新验证。

### 4 采集者、凭据与租约

- 绑定指定 `collectorNodeId` 与本地 `credentialSlot`。平台应用凭据只存采集 Node 的 SecretStore（0600）；Hub 只保存槽位名与不透明来源身份，不接收 secret、tenant token、文档绝对路径或平台私密名称。
- 同一应用事件流同时只有一个有效采集租约：绑定检查时 Node 返回不透明 `appKey`（平台应用与租户身份的哈希，不是 app id 或密钥），Hub 以 `(platform, appKey)` 为 `source_collection_lease` 的单位；租约 TTL 90 秒、每 30 秒续租，过期后 Hub 不再接受该持有者的观察。换 Node 必须显式重新绑定并创建新代次，不能抢占旧租约继续提交。
- 授权代次 `authorizationGeneration` 单调递增：首次绑定为 1；恢复、重新验证、更换采集者各 +1。观察、提取任务与模型结果都携带代次；Hub 只接受当前代次，旧代次提交返回 409 `SOURCE_STALE_GENERATION`，不落入读面。
- 非租约持有者提交观察返回 409 `SOURCE_LEASE_LOST`。

### 5 权限重验与未知状态

- 绑定前，Hub 通过有界只读 RPC（≤5 秒，形如 `node.preparation_check`，不进 Outbox、不启动 Runtime）让采集 Node 检查目标资源可读性；只返回 `readable / denied / not_found / unsupported`、可选资源版本与不透明 `appKey`，不传正文。
- 运行期每次同步前重验权限；即使没有同步，也至少每 24 小时重验一次。明确 denied 或平台撤销 → `permissionState=denied`，立即停止新采集与正文使用，来源进入 `unavailable`。
- 网络或平台故障导致无法验证，且超过 `permissionExpiresAt` → `permissionState=unknown`：停止新采集、新提取与新 Run 装配，读面不再下发正文与引用摘录，显示「权限待重验」与最后成功验证时间；版本与时间等元数据可以继续显示。`unknown` 连续 7 天未恢复 → 按 `unavailable` 处理并执行正文清除（保留审计身份）。恢复必须重新验证并增加代次。

### 6 暂停、不可用与撤销

- **暂停**：立即停止采集与提取，保留绑定、正文与读面；未提交结果按代次拒绝并在恢复后重试；恢复需重新验证权限并增加代次。
- **不可用**：外部资源被删除/撤回、采集器离线或权限明确失效。停止采集与正文使用，保留绑定与墓碑；成员可撤销或重新绑定。
- **撤销**：绑定永久关闭，不能恢复；执行第 7 节级联。

### 7 撤销级联（必须同时发生）

1. 采集租约作废；Node 的下一次续租或提交失败，立即停止该来源的采集。
2. 未提交的观察、提取任务与迟到模型结果按代次拒绝，不进入当前读面。
3. 项目读面停止下发该来源的条目、引用与正文；派生 ContextEntry/Relation 标记 `invalid`，引用摘录在 24 小时内清除。
4. 新 Run 不装配该来源；历史 Run 保留来源版本与 `source_revoked` 标记，正文不再经 HTTP 读面下发。已有的 Artifact 固定输入、任务约定与交接快照不因来源撤销被改写（ADR-0016/0017）。活跃 Run 只显示「本次执行依据已变化（来源已撤销）」，不插入追问、不取消工具、不改写正在执行的上下文，也不声称清除了模型已经看到的内容。
5. 正文与规范化副本在 24 小时内物理清除；摘要、位置索引与审计身份按第 8 节保留。
6. Team Event 只广播一次 `source.changed`，载荷只含不透明 `sourceId`、状态与时间，不含正文、平台名称、成员姓名或摘要。
7. Web 明确说明「已交付给执行者的内容无法收回」，不把撤销渲染成全面删除。

### 8 保留与删除

| 对象 | 有效期间 | 撤销/失效后 |
|---|---|---|
| 来源规范化正文（Hub） | 绑定有效期间；每来源最多 100 个版本或 90 天，先删最旧正文、保留摘要与位置索引 | 24 小时内清除 |
| SourceRevision 摘要、上游版本、位置索引 | 绑定有效期间 | 保留 30 天墓碑后清除 |
| 派生 ContextEntry/Relation 正文与引用摘录 | 当前有效条目 | 24 小时内清除；关系墓碑保留 30 天 |
| RunProjectContext 冻结正文 | 随 Run 记录保留 | 不删除已交付记录；当前权限不足时不读取、不展示正文，只显示版本与不可用标记 |
| 绑定/暂停/恢复/撤销/权限变化审计 | Team 存续期间 | 保留；不含正文、平台名称、成员姓名 |
| 平台身份映射 | 来源有效期间 | 随来源撤销或成员移除失效；审计保留不透明 id |
| Node 规范化副本与待提交队列 | 上传确认前 | 撤销或解绑后 24 小时内清除；已确认队列随 ack 清除，未确认最多保留 7 天 |

- 删除外部资源不等于删除审计身份；Web 在撤销确认中说明实际效果。
- 本 ADR 接受后，才允许启用真实团队正文持久化；接受前 PC-02 只用录制/回放样本。
- 运行期 `unknown` 超过 7 天按 `unavailable` 执行正文清除，避免长期保留无法证明仍有权限的内容。

### 9 协议与部署顺序

- Hub ↔ Node 保持 `protocolVersion: 1`。`node.hello` 增加可选 `sourceCapabilities`（首轮 `['feishu.read.v1']`，缺省表示不支持）；Hub 只向声明支持的 Node 发起绑定检查与来源帧，未声明的 Node 返回升级提示，不静默降级。
- 新增帧：`source.permission_check` / `source.permission_result`（有界 RPC，只读元数据）；PC-03 再增加 `source.observation`。新帧类型只发给已声明能力的 Node，旧 Node 不会收到未知帧。
- 部署顺序：先升级 Hub，再升级 Node。旧 Hub 会以 strict schema 拒绝新 Node 的 hello 未知字段，因此不支持「新 Node + 旧 Hub」混跑；PC-10 固定受支持的 Hub/Node 版本并在升级说明中写明。后续若需要必填字段，按协议 §11 升 `protocolVersion`，不借本 ADR 绕过。

### 10 API 与数据（PC-02 范围）

- `POST /api/v1/projects/:projectId/sources`（`Idempotency-Key`；正文含 `kind`、`resourceKey`、`displayLabel`、`collectorNodeId`、`credentialSlot`、`shareScope: 'team'`、`autoExtraction`）；绑定前完成第 5 节权限检查。
- `GET /api/v1/projects/:projectId/sources`、`GET /api/v1/sources/:sourceId`：状态、权限状态、最近成功读取、代次、待处理数量、缺口。
- `POST /api/v1/sources/:sourceId/pause`、`/resume`、`/revoke`（撤销正文必须带 1–500 字符理由）；恢复与撤销都要求 `Idempotency-Key`，同一 key 重放返回同一结果。
- 表：`project_source`、`source_collection_lease`、`source_audit_event`（PC-02）；`source_revision` 与身份映射表由 PC-03/PC-04 按 ADR-0025 落地，但都携带 `sourceId` 与 `authorizationGeneration`。
- 所有视图不含凭据、绝对路径、平台私密名称与正文片段；`displayLabel` 由绑定成员填写，不作为平台名称的存储。

字段草图（实施时以协议与 migration 为准）：

- `project_source`：`id`、`projectId`、`platform`、`kind`、`resourceKey`（不透明）、`displayLabel`（成员填写，≤120 字符）、`collectorNodeId`、`credentialSlot`、`appKey`（不透明哈希）、`shareScope`（固定 `team`）、`autoExtraction`、`status`、`permissionState`、`permissionCheckedAt`、`permissionExpiresAt`、`authorizationGeneration`、`lastSuccessAt`、`latestRevisionId`、`boundBy`、`boundAt`、`pausedAt`、`unavailableAt`、`revokedAt`、`revokedBy`、`revokeReason`。部分唯一索引保证 `(platform, resourceKey)` 在非 `revoked` 状态下只有一条；撤销后重新绑定是新行、新代次。
- `source_collection_lease`：`(platform, appKey)` 主键、`deviceId`、`generation`、`expiresAt`、`acquiredAt`、`renewedAt`。续租只延长 `expiresAt`；换持有者必须经显式重新绑定并提升代次。
- `source_audit_event`：`id`（bigserial）、`sourceId`、`action`、`actorMemberId`、`authorizationGeneration`、`reason`、`createdAt`、`payload`（只含非敏感字段；不含正文、平台名称、成员姓名）。

### 11 观测与取证

- Hub：`hub.context` 记录 `source.bound`、`source.paused`、`source.resumed`、`source.revoked`、`source.permission_changed`、`source.lease_changed`，字段只含不透明 id、平台、类型、状态与时间。
- Node：`node.source` 记录租约获取/续租/丢失、权限检查结果、队列积压、按代次拒绝；不含正文、平台名称、成员姓名或本机路径。
- 证据包按计划 §9.2 的 `artifacts/evidence/project-context/<scenario>/<attempt>/` 归档；实现 PR 同时登记 `docs/agent/evidence-map.md`。
- 脱敏负控必须覆盖群名、成员显示名、文档标题、正文片段、凭据与绝对路径。

### 12 验证

PC-02 至少包含：

- 正向：两账号绑定 → 状态可见 → 暂停 → 恢复 → 撤销；撤销后读面与历史标记符合第 7 节。
- 负控：无会话/非成员；越权绑定与不存在资源返回同一错误；重复 `Idempotency-Key` 返回同一结果；采集 Node 离线；旧代次观察/结果；租约丢失；权限过期；撤销后正文读取；日志与证据泄漏扫描。
- 外部接口边界使用录制/脱敏的协议服务替身；真实平台烟测由 PC-01 提供，不在 CI 声称真实权限。
- 每条负控做一次单点变异自证；没有机器证据不记为完成。

### 13 不做什么

- 不新增 Project 私有 ACL 或成员级来源 ACL；需要时先另写 ADR。
- 不向外部平台发送消息，不自动把来源内容转发到群。
- 不自动切换采集 Node，不自动重建已撤销绑定。
- 不在本 ADR 引入模型提取、上下文条目分类或 Run 装配规则（分别由 ADR-0025/0026/0027 决定）。
- 不重新启用 ADR-0023 暂停的 LibreOffice 预览转换。

### 14 后果与重新评估

- 首个平台若无法提供整团队可读的群与文档，只能保留链接；PC-01 应记录并考虑更换平台。
- 若团队需要私有来源或按项目隔离，必须先做 Project ACL；本 ADR 的「整团队」假设随之失效。
- 24 小时正文清除与审计/排障需求冲突时，先调整保留策略再启用真实正文；不允许用「以后再说」绕过。
- 若 5 秒权限检查在真实平台不可行，PC-01 必须给出可验证的替代时延与失败语义，否则不绑定。

## 验证登记

本 ADR 是文档，不含机器证据。PC-02 实现时创建 `docs/agent/project-source-acceptance.md`，登记绑定/暂停/撤销、权限重验、代次拒绝、租约与脱敏判据；未完成前 PC-02 保持未实现。
