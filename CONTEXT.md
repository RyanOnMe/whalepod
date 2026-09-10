# WhalePod Team Collaboration

这个领域描述一个小团队如何把工作交给人和 Agent，并让执行发生在成员可控的本地现场，结果再安全地回到团队。

## 团队与协作

**Team**：
一个自托管实例中的唯一成员与资产归属根。
_Avoid_：Organization、Tenant、Workspace

**Member**：
通过邀请加入 Team 的真人参与者。
_Avoid_：User Agent、Account Role

**Project**：
成员围绕一个长期目标共享 Task、评论和 Artifact 的协作场景。
_Avoid_：Space、共享目录、运行容器

**Task**：
Project 中由一名真人责任人承诺推进的工作单元，也是多个 Run 和 Artifact 的业务归属点。
_Avoid_：Session、Prompt、Job

**Assignment**：
Task 与真人责任人之间需要接受或拒绝的责任关系。
_Avoid_：Agent assignment、Run owner

**Comment**：
成员围绕 Task 留下的团队可见协作消息。
_Avoid_：Chat Session、Runtime Event

## Agent 与执行

**Agent**：
Team 共享的长期 AI 角色，持有名称、persona 和当前 Profile Revision。
_Avoid_：模型、Session、Workspace、Subagent

**Profile Revision**：
某个 Agent 在一次 Run 中使用的不可变 persona、模型路由、Skill 与插件组合快照。
_Avoid_：可变设置、当前 UI 表单

**Device**：
由某个 Member 控制并能承载 Node 与 Runtime 的一台执行机器。
_Avoid_：Agent、Workspace、Team Server

**Workspace**：
某个 Member 在某台 Device 上登记的单一私有执行根；Project 只能引用其不透明身份，不能拥有或浏览该目录。
_Avoid_：Project、共享文件夹、仓库对象

**Run**：
Task 的一次可独立取消、失败、完成或重跑的执行尝试，固化 Agent、责任人、Workspace 与 Profile Revision。
_Avoid_：Task、DSH Session、进程

**Runtime**：
在某台 Device 上承载一个 Run 的隔离 DSH 进程。
_Avoid_：Hub、Agent、Device Node

**DSH Session**：
Runtime 内部的追加式执行日志与 Agent 上下文来源；它不承担团队权限或 Task 生命周期。
_Avoid_：Run、Task Room、团队活动流

**Run Projection**：
由 Runtime 事实生成、按受众脱敏后供团队协作使用的 Run 视图。
_Avoid_：原始 Session、完整日志副本

## 权限与交付

**Approval**：
Workspace 拥有人对某一次具体高风险动作作出的一次性允许或拒绝决定。
_Avoid_：永久授权、插件安装、Task 验收

**Artifact**：
某个 Run 提交并由责任人发布的可寻址交付物，保留来源 Run 和内容摘要。
_Avoid_：任意本地文件、聊天附件、原始工具输出

**Plugin Package**：
可被 DSH 组合加载的一个带版本代码包。
_Avoid_：App、Capability Grant、Plugin Installation

**Plugin Installation**：
Team 管理员对一个精确 Plugin Package 版本及其完整性摘要作出的供给决定。
_Avoid_：启用、数据连接、Agent 授权

**Plugin Pack**：
供 Profile Revision 引用的一组不可变 Plugin Installation 集合。
_Avoid_：市场分类、运行时随意安装目录

**Capability Grant**：
Member 对某个 Workspace、凭据或工具能力授予一次 Run 的明确可用范围。
第一阶段它由 Run 快照中的 Workspace、credential slot 和 tool policy 共同表达，不设独立持久表，也不形成跨 Run 永久授权。
_Avoid_：Plugin Installation、角色权限、一次性 Approval
