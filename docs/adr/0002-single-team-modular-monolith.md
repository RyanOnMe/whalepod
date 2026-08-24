---
status: accepted
---

# 一个实例一个 Team，Hub 采用模块化单体

第一阶段每个自托管实例只承载一个 Team，Hub 用一个 Node.js 进程承担认证、Project、Task、Run、实时协作和 Outbox，PostgreSQL 是唯一共享数据库。3–10 人规模没有理由引入 Redis、消息总线或微服务；若未来需要拆分，Run Orchestrator 与 Device Gateway 的接口已经提供 seam。

