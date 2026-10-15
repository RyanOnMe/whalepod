# ADR-0016：执行输入清单的身份与内容快照

- 状态：已采纳（两名独立评审认可设计；协议与migration仍须最终提交复审与质量门通过后合入）
- 日期：2026-10-15
- Issue：#325；界面消费#326、#327

## 问题

现有input-manifest每次查询Task当前已发布材料。Node延迟派发或重试时，新增发布会改变旧Run的输入；内容本身有sha256，但输入集合尚未固化。

## 决定

所有新Run在创建事务内保存artifact_input_manifest（taskId与至多64个ArtifactManifestEntry：artifactId、来源runId、title、mediaType、byteSize、sha256、publishedAt）。与Run、Outbox和幂等回执一起提交；不以首次下载作为快照时点。新执行缺省在一次查询中取当时全部published；显式artifactInputIds按请求顺序精确选择，重复、超限、非同Task或未发布身份拒绝，不泄露候选是否存在。空选择合法且永久为空。

续跑/重跑缺省继承来源清单；显式artifactInputIds可以为本次新Run重选已发布材料，历史Run不变。HTTP追问不得携带输入选择；旧自动路由也不得携带，避免将材料要求变成追问后丢失。输入选择不覆盖来源Agent/版本/环境，续跑仍受原守卫。续跑历史上下文可能有旧材料，本次清单不代表全部会话内容。

Node读取已保存清单，仍走原生产下载、sha256/byteSize校验与按Run隔离副本。Session成员可经GET /runs/:id/input-manifest查看无路径快照；不把私有现场、会话或候选夹进响应。只读副本不约束Agent整体工具权限，审批沿既有设置。

迁移旧Run保留NULL：无法证明历史，不回填当前材料或空列表。成员读接口返回null明确未知；Node读未知返回409 CONFLICT，禁止默默漂移。旧已运行Runtime不被重放或终止；对旧Run可开始新执行，或显式选择材料后重跑/续跑。该变更要求升级Hub后再创建需要快照的新工作。

## 并发与验证

单次published查询是输入集合的线性化点；并发发布在其前/后均有确定结果，后续不再重查。材料身份/内容在发布后不可变；不额外引入发布与Task的反向锁。真实HTTP/设备帧创建Run与上传/发布材料，覆盖空、晚发布、幂等、子集、跨Task/候选、上限、设备鉴权及续跑继承/显式新选择；旧NULL在已有迁移前fixture边界单独验证。所有新增链路禁止直写运行状态。
