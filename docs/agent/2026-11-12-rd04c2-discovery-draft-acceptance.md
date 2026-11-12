# RD-04c2：新任务获授权后生成责任人私有草稿

- Issue：#542（父任务 #535），前置 #540，契约 ADR-0030。
- 工程切片只允许隔离的本机模型回放。普通 Hub/Node 启动不启用；真实模型、逐调用额度与供应商计费留 RD-04c3，正式阅稿未启用，真实飞书仍等测试租户。
- 2026-11-12：正向装配和首读前撤权装配均通过，两位独立评审复核 READY。正向只有一个 Run；同键并发授权复用同一条记录，未批准的回放账户返回 409。

## 驱动与判定

同项目先有一个讨论 Task 和独立核实人的已发布成果。成员照常发表评论；受限发现用其确切评论和已发布成果提出候选，Hub 按预授权建新的 Task、派生约定和 Work。此前必须没有 Run。责任人在生产 HTTP 接口确认当前来源包和回放路由后，Hub 自动建立一条子许可、派工意图、私有 Run 及待发送命令；重试授权不再建第二个 Run。驱动不手建目标 Task、发指令或搬材料。

使用正式包解析的 Hub、PostgreSQL、Node、DSH Runtime 及 HTTP/WS。只替换模型响应。DSH 读取工具必须将同一来源的实际字节送回模型请求；独立判定按授权来源版本/摘要、Run 清单、读取回执及实际工具结果的摘要对账。没有正文读取、只下载，或摘要相同但版本不符均不通过。回放只允许固定 HTTP 回环路由，Executor 不带真实供应商凭据；支持的源文件须是有界 UTF-8，不能用新版本或普通跨 Task 输入替代。

DSH 产出私有 Markdown 候选；责任人下载 200、第二名成员下载公开对照 200、私有候选 404，草稿不能发布或转成交接。探针检查成员 HTTP、WebSocket 实时与重放有对照状态，但均无私有标记。派工状态与专用读取回执可查，内容不进入团队投影或 Router。负控在已送达、首次工具读之前通过生产 HTTP 更正原始评论，要求阻断读取、后续模型请求与草稿登记。

两轮都观察到本次 Run 的两个私有目录，子进程退出后目录被清理，注册工作区不留草稿。正向产出后显式撤回执行授权，原责任人下载转为 404，任务页不再显示私有标题。首读前更正用例仅观察到首个本机模型请求，两份材料已送达，但零成功读取、零后续模型请求、零草稿。运行状态与候选标题、正文、最终回复均做了成员可见性检查；未另行注入带专用标记的原始工具错误。真实模型、调用级费用、外部接入和 Hub 孤立内容文件的留存/清理仍不计入本次验收。

## 复跑与取证

```bash
pnpm --filter @whalepod/hub... --filter @whalepod/node... build
node --import tsx scripts/run-rd04c2-acceptance.ts
node --import tsx scripts/run-rd04c2-acceptance.ts --revoke-before-read
node --import tsx scripts/verify-rd04c2-acceptance.ts
node --import tsx scripts/verify-rd04c2-acceptance.ts artifacts/evidence/rd04c2/revoke-before-read/result.json
node --import tsx scripts/check-rd04c2-evidence-negatives.ts
```

脱敏证据在 `artifacts/evidence/rd04c2/`，按 application、execution、Run、逐件来源 ID 和草稿 ID 关联。独立判定器为 `scripts/verify-rd04c2-acceptance.ts`，用实际构建和事件文件摘要约束证据；缺任何一环即拒绝。授权/版本先查 `hub.discovery` 和执行来源行；派工查 Run 与 outbox；下载、读取、撤权查 `node.work_input` 与 `hub.work_input`；候选登记、下载与双账号对照查 `artifact.store` 和 HTTP 状态。
