---
status: accepted
---

# Workspace 私有，团队只消费 Run Projection

Project 不拥有成员目录，Workspace 的绝对路径只存于其 Device Node。Hub 保存不透明 Workspace 身份，并从 DSH Session 生成 owner-only 与 project 两种 Run Projection；这允许团队理解进度和接收成果，同时不把本地文件、完整工具参数和原始执行 Session 变成组织共享资产。

