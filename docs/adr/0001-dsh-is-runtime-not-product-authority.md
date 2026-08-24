---
status: accepted
---

# DSH 是 Runtime，不是产品权威

TabTin 将 DSH 作为第一个深度集成的 Agent Runtime，并原生使用其插件、事件、工具和 Agent Loop；Team、Project、Task、角色、Approval 与 Artifact 仍由 TabTin Hub 权威保存。这样可以最大化 DSH 生态兼容，同时避免 DSH 的本地 Session、Workspace 与预览期协议演进决定团队数据模型。

## Considered Options

- Fork DSH Web 并把协作对象放进其插件树：短期快，但上游漂移和权限耦合不可接受。
- 把 DSH 当完全黑盒 SDK：边界稳定，但会丢失取消、审批和插件原生能力。
- 采用窄的 TabTin Runtime Bridge：实现成本较高，但保留两侧主权，故采用。

