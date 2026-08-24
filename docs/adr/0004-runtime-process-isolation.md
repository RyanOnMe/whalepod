---
status: accepted
---

# 每个 Run 使用独立 Runtime 进程

DSH 插件是可执行宿主代码，工具审批不能约束插件初始化行为。因此 Hub 永不加载第三方 DSH 包；Device Node 为每个 Run 启动独立 Runtime 子进程，并限制 cwd、环境、文件写入和生命周期。进程隔离增加了启动成本，但把插件崩溃、内存泄漏和权限暴露限制在一个 Run 内，符合小团队自托管的安全底线。

