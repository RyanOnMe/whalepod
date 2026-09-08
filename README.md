# TabTin 2.0 第一阶段执行方案

> 版本：2026-08-16 · 状态：可进入实施拆分 · 适用对象：产品负责人、架构负责人、开发 Agent、测试与首批 3–10 人试用团队

这套方案定义一个全新的开源项目，不迁移 TabTin 1.x 代码，也不兼容其 Django API、数据库或客户端。第一阶段只证明一个核心命题：**两名以上成员能围绕一个 Task，让不同 Agent 在各自受控的 Workspace 中运行，并安全地观察、审批、接管和交付结果。**

## 试用与安装

Alpha 试用者（3–10 人团队）请直接读 [docs/installation.md](./docs/installation.md)；以下阅读顺序面向开发与架构读者。

## 一句话定位

TabTin 2.0 是面向 3–10 人小团队的 DSH 多人协作发行版：TabTin 拥有团队事实和产品体验，DSH 提供 Agent Runtime 与插件生态。

## 阅读顺序

| 顺序 | 文档 | 用途 |
|---|---|---|
| 1 | [CONTEXT.md](./CONTEXT.md) | 统一 Team、Task、Run、Workspace 等领域语言 |
| 2 | [01-产品与架构设计.md](./01-产品与架构设计.md) | 理解产品闭环、架构、取舍和阶段边界 |
| 3 | [02-第一阶段实施计划.md](./02-第一阶段实施计划.md) | 开发 Agent 可逐项执行的代码级计划 |
| 4 | [03-领域模型与运行协议.md](./03-领域模型与运行协议.md) | 数据模型、状态机、权限和 Hub↔Node↔Runtime 协议 |
| 5 | [04-验收矩阵与测试策略.md](./04-验收矩阵与测试策略.md) | 两用户、多 Agent、审批、隔离、恢复的可证伪验收 |
| 6 | [05-里程碑与Issue拆分.md](./05-里程碑与Issue拆分.md) | 工作包、依赖、并行方式和交付门禁 |
| 7 | [06-风险与升级策略.md](./06-风险与升级策略.md) | DSH 预览版、插件安全、性能和开源治理风险 |
| 8 | [07-资料与版本基线.md](./07-资料与版本基线.md) | 官方资料、依赖版本和研究快照 |
| 9 | [docs/adr](./docs/adr/) | 难以逆转的架构决策 |

## 第一阶段交付定义

完成后，新用户可以：

1. 用 Docker Compose 启动一个单 Team 实例。
2. 创建 Owner，邀请第二名成员登录。
3. 创建 Project、Task 和两个团队 Agent（Builder、Reviewer）。
4. 在成员电脑上配对一个 Device Node，并登记一个私有 Workspace。
5. 由 Task 责任人启动 Builder Run；另一成员实时看到脱敏进度。
6. 在高风险工具执行前，由 Workspace 拥有人完成一次性批准或拒绝。
7. Agent 通过 TabTin 提供的 DSH 工具提交 Artifact，责任人发布给 Project。
8. Reviewer Agent 基于已发布 Artifact 发起第二个 Run 并给出复核结果。
9. 由 Task 责任人提交验收并显式标记完成，Agent 不自动关闭 Task。
10. 对运行执行取消、失败重跑，并保留 `rerunOfRunId` 血缘。
11. 在 Hub 重启、Node 短暂断线后依靠事件序号和幂等写入恢复一致状态。

## 明确边界

第一阶段采用以下已经拍板的范围：

- 一个部署实例只承载一个 Team；无多租户、计费和企业组织树。
- 所有 Team 成员可见所有 Project；第一阶段没有 Project 私有 ACL。
- Agent 是 Team 共享的长期角色；Workspace、Device、凭据属于成员个人。
- 原始 DSH Session 只留在 Run 责任人的 Node 本地，不上传 Hub；责任人在 Web 也只看到经脱敏的 owner-only 投影，其他成员不获得绝对路径或完整工具参数。
- Project 成员看到 Run 的状态、脱敏活动、审批等待和已发布 Artifact。
- DSH 插件兼容先覆盖 Host/Tool/Skill/MCP/模型插件；DSH 前端插件兼容不进第一阶段。
- 第三方插件不进入 Hub 进程；所有 DSH Runtime 都是独立子进程。
- Web-first；桌面壳、原生移动端、协作文档、表格、邮件、白板均不在第一阶段。
- 第一阶段只提供 `tabtin-hub` / `tabtin-node` 运维 CLI 和机器可驱动 HTTP/WS 契约；人类协作用的统一 `tabtin` CLI 在闭环证明后补上，本阶段不为了表面“CLI 对齐”扩大验收面。
- PostgreSQL 是唯一团队数据库；不引入 Redis、Celery、Kafka 或 Kubernetes。

## 参考排期

参考团队为三名实现者：一人负责 Hub/领域，一人负责 Node/DSH Runtime，一人负责 Web/E2E；产品负责人每日参与验收。参考排期为六个自然周：

| 周 | 阶段门 | 必须得到的证据 |
|---|---|---|
| 第 1 周 | 基础与领域门 | 仓库、数据库、认证、状态机测试全绿 |
| 第 2 周 | 团队产品门 | 两账号完成 Project→Task→接受任务 |
| 第 3 周 | Runtime 门 | Node 配对并用无密钥回放模型完成 DSH Run |
| 第 4 周 | 协作安全门 | 实时投影、审批、取消和隐私隔离全绿 |
| 第 5 周 | 交付门 | Artifact 发布、Reviewer Run、重跑血缘全绿 |
| 第 6 周 | 开源试用门 | Docker 安装、两用户 E2E、故障恢复和安全清单全绿 |

单人顺序实施可按相同依赖图执行，参考周期约为十二周；这只是容量换算，不改变每个阶段门。

## 使用规则

- 实施以 [02-第一阶段实施计划.md](./02-第一阶段实施计划.md) 的任务顺序和验收命令为准。
- 领域术语冲突时，以 [CONTEXT.md](./CONTEXT.md) 为准。
- 协议字段和状态迁移冲突时，以 [03-领域模型与运行协议.md](./03-领域模型与运行协议.md) 为准。
- 任一关键场景缺少机器证据时，不得用“界面看起来正常”判定完成。
- DSH 升级只能通过单独 Pull Request，必须先过契约探针和完整 E2E。
