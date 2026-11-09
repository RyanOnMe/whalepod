# M1R-A 既有任务自动续接验收

- 对应 Issue：#486，ADR-0028 §3、§13、§17。
- 基线：`7a19287`。本轮生产装配结果见下文；模型语义另见 [Router 真实模型质量](./router-real-model-quality-acceptance.md)。
- 上次验证：2026-11-09（Asia/Shanghai）。Agent 单价修复后两次独立复跑通过；PR #529 的 Router v5 评审修复后再次通过，八条证据负控全部被拒绝。

## 验的是哪条用户路径

团队成员在已有任务的讨论区补充需求。有效订阅把补充送入工作收件箱，工作在允许的 Run 边界复核覆盖、授权和预算，再自动启动下一次 Run。后一 Run 通过 DSH 的 `read_work_input` 实际读取补充，产出未发布的私有草稿。补充消息不是执行指令，测试不从普通建 Run、人工追问或直接写库启动后一次执行。

## 驱动与判定

使用独立团队、两位成员、一次性 PostgreSQL、按包名解析的 Hub、真实 Node 服务与 DSH Runtime。工作、约定、Mandate、订阅及 Task 讨论都走生产 HTTP；真实 Node 经 WS 接收派发和上传执行回执。Node 使用包内与 CLI 相同的启动装配，通过已有 Runtime 环境白名单将 DSH 模型出口指向回环回放；生产 CLI 不开放此选项。工具、文件落盘、草稿上传及读权限走实际实现。

在 Work 仍可接收订阅时，两条普通讨论分别成为引导项和补充项。责任人仅用生产准入入口启动第一条；确认第一 Run 的清单不包含补充项，补充仍在原收件箱条目等待。第一份草稿由责任人显式发布，为终态复核提供真实的已覆盖依据。第二次派工不发执行、追问、重评或确认请求。

| 检查 | 必须观察到的事实 |
|---|---|
| 订阅与等待 | 订阅有效，补充的来源身份与收件箱条目对应；入口不调用模型；首个 Run 尚活跃时不创建后一次 Run |
| 自动续接 | 首个机器 Run 终态引发复核；后一次 Run 由原 Task 和 Mandate 授权，关联系统派工意图，没有人为确认此次派工；首个 Run 的快照保持不变 |
| 消费 | 后一次 Run 冻结该条目，Node 下载验摘要，DSH 的实际工具结果使合成正文标记进入后续模型请求，Hub 落同一 Run/条目的 `consumed` 回执 |
| 私有草稿 | 后一次 Run 通过 DSH 工具生成并上传候选，责任人可读取正确内容，另一位已加入团队的成员读取返回 404，候选仍未发布；后续覆盖复核看不到候选正文，也不因此起第三次 Run |

## 归因与取证

按 `workKey`、来源/收件箱条目 ID、`evaluationId`、两个 `runId` 和草稿 ID 对齐，不在证据中写入讨论或草稿正文。入口查 `hub.work_entry`，终态与续接查 `hub.dispatch`，下载和回执查 `node.work_input` / `hub.work_input`，草稿上传及双账号读取查 `artifact.store` / `hub.http`。缺任一环时应判失败，不能用其他场景的通过补齐。

首次生产装配在自动派工处命中 `executor_usage_unavailable`：Agent API 接受且摘要计入输入、输出单价，但 PostgreSQL 的 Revision 插入漏掉两列。通过初建 Agent、再建 Revision、最后回读的 API 回归复现；修复后两版分别保留各自单价。旧 Revision 已丢失的单价无法从摘要还原，受影响的 Agent 需要显式创建新 Revision，不填猜测值。

当前验收经 Agent API 提交单价。普通 Web Revision 表单还不提交单价字段；以该表单新建当前 Revision 后须核对是否仍有两项单价。未配置时自动派工会排除该 Agent，不能用这次持久化修复当作网页定价编辑已交付。

实际证据：`artifacts/evidence/m1r-a/result.json`、同目录 `events.jsonl` 与 `negative-controls.json`。两次 Run 都完成、拥有各自 DSH Session、同一 Task 的两条输入分别只消费一次。续跑候选正文的下载为 owner 200、团队成员 404；两轮 Router 复核分别为 `dispatch` 和 `wait`，观测窗口内没有第三次 Run。新版结果绑定当前生产包和事件文件的摘要，八条单点证据负控（含事件文件替换）全部被判定器拒绝；受影响的 Agent API 与派工集成回归 66 项通过。

## 边界

本场景验证订阅已命中的同一条补充在下一次 Run 被消费，未把进行中新增讨论的 `wait` 入箱分支记作订阅命中。私有指候选正文的读取权限；通用候选元数据的项目可见性不变。M1R-A 只覆盖已有 Task 的受控续接。模型回放通过不代表覆盖判断正确，也不代表真实飞书接入、新任务自主发现或团队使用收益已经验证。首个 Run 的已知覆盖需要团队有权读取的真实成果依据；草稿私有状态和消费回执不能当作已覆盖证据。

## 复跑

需要 Docker 和本机回环监听权限。所有数据库、Hub、Node 与 Runtime 属于本次验收环境，退出后回收。

```bash
pnpm --filter @whalepod/hub... --filter @whalepod/node... build
node --import tsx scripts/run-m1r-a-acceptance.ts
node --import tsx scripts/verify-m1r-a-acceptance.ts artifacts/evidence/m1r-a/result.json
node --import tsx scripts/check-m1r-a-evidence-negatives.ts artifacts/evidence/m1r-a/result.json
scripts/secret-scan.sh artifacts/evidence/m1r-a
```
