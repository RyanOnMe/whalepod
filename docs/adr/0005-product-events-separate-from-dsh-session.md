---
status: accepted
---

# 产品事件与 DSH Session 分开保存

DSH Session Log 继续作为模型上下文、Runtime 恢复与本地取证的完整事实源；Hub 只保存脱敏、低频、具备团队产品语义的 Team Event。Token delta 只实时转发、不进入 PostgreSQL。该选择牺牲了 Hub 端的完整逐 token 回放，换取清晰的权限边界、可控存储和不受 DSH Session schema 变化影响的协作模型。

