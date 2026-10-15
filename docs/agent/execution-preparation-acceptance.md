# 首次执行准备验收（#320）

## 用户路径与条件

责任人选择Agent与固定Revision，手动“检查本次准备条件”。HTTP严格校验Task责任人与本人的实际设备/Workspace；复用生产resolveRunTarget，自动选中的现场成功检查后明示并固定到本次显式选择。

准备检查使用新的只读Node请求/结果，实际调用WorkspaceRegistry.resolve和SecretStore.resolve（文件与环境变量），状态只返回可用/不可用/未确认以及已配置/未配置/未确认，不返回秘密、路径或模型响应。管理员和已获指令权的协作者都不能探查别人的私有现场。

检查不启动Runtime、不调用模型、不产生Run、消息、业务Outbox或命令回执。结果绑定随机requestId、Device和同一活跃连接；替换连接拒绝旧等待者；即使结果已交付，在HTTP最终返回前也重新核对同一连接实例，连接替换后不得复用旧快照。超时/旧Node/断连均未确认。每设备8、全Hub128个并发上限，等待5秒有界。网页目标或版本变化、30秒到期后须重新确认。

网页串起已验证的Alpha源码安装、设备配对、Workspace登记、本机凭据配置。设备页与准备区共用node apps/node/dist/cli.js命令前缀；固定到与Hub同一发布版本并说明占位符替换，不依赖另一套全局安装命令。试运行仅填空草稿，不覆盖已有草稿、不自动发送；可能有真实模型费用，仍由用户点击现有执行入口并沿用当前审批设置。模型调用始终显示“尚未验证”，直到用户观察真实执行结果；检查不担保网络、额度、插件或未来永久可运行。

## 六原语

- 驱动：真实本机registry/SecretStore；真Node bin经CLI配对/登记/启动与环境凭据；Cookie HTTP+真实Device WS；生产Hub/Node包解析装配（与CLI共用session检查处理）/Runtime真bin replay Q5，不直插Run或投影。
- 观测：node.preparation、hub.device 的关联结果；web.preparation中固定版本/目标、状态与草稿；运行数据检查零Run证明探针无执行副作用。
- 判定：文件和环境变量正控；缺失凭据/目录拒绝就绪；权限错误只回未确认；错设备/连接/迟到/版本不符不能复用；失效配置不改投；试运行只有预填；无私有信息泄漏。
- 归因：HTTP403先查Task责任人与Device/Workspace归属；503先查连接及Node版本；本机缺项查registry/SecretStore；不同版本或目标查网页scope绑定。
- 取证：artifacts/evidence/execution-preparation/ 脱敏结果、门禁与关联事实，不保存凭据正文或本机路径。
- 发现：登记此文及ADR-0014；Node上下行schema/fixtures/生成物同步。

## 复跑

```bash
pnpm check
pnpm exec tsx scripts/with-test-postgres.mts vitest run --project integration apps/hub/tests/device-inventory.integration.spec.ts
pnpm test:security
pnpm --filter @whalepod/hub... build
pnpm --filter @whalepod/node... build
pnpm --filter @whalepod/runtime... build
pnpm exec playwright test --config playwright.operations.config.ts --project p1-315
bash scripts/secret-scan.sh artifacts/evidence/execution-preparation
```

先红提交710a0be。具体最终提交与门禁结果见证据目录；真实远端provider和用户理解成本不由replay替代，DSH/Runtime wire及Task责任规则未改变。旧Node不支持只读探针时提示连接/版本未确认，不阻止参与讨论。

评审回归：已完成响应后由真实新WS替换旧连接，HTTP必须409；完全权限确认期间迟到的未配置结果必须关闭确认、禁用启动并保留草稿。先红提交9688971，连接单元检查和网页确认检查均已复现失败。

新鲜度回归：按checkedAt计算30秒截止时间；过期或未来时间的响应不得就绪，临近到期只保留剩余时长。先红提交a73c164，旧响应和近到期响应均有可失败检查。
