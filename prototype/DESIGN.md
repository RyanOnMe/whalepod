# WhalePod HTML 产品原型设计说明

> 状态：已批准进入原型实现 · 日期：2026-08-16 · 原型问题：WhalePod 应该长什么样，以及产品层是否应直接继承 DSH Web。

## 1. 设计结论

WhalePod 的主界面不是聊天框、Agent Session 列表或传统项目看板，而是 **Task Room（任务作战室）**：一个真人责任人与多个长期 Agent 围绕同一交付目标协作、审批、接管和验收的共享空间。

DSH 的正确继承方式是 **组合 Runtime，而不是 Fork 产品外壳**：

- 在运行层，WhalePod 通过自有 Profile / Bundle / Bridge 直接组合 DSH，继承 Agent Loop、Session Log、Tool、Skill、MCP、Subagent、审批 seam 和插件生态。
- 在产品层，WhalePod 自己拥有 Team、Project、Task、Assignment、Run、Approval、Artifact 和成员权限。
- 在界面层，DSH 的 Session/Turn/Step/Tool 语义进入 Task Room 内的 Run Console；DSH Web 不成为 WhalePod 的顶层导航和团队事实来源。

这与 DSH 官方架构一致：DSH 当前以 Cordis 插件树、Profile 和 Bundle 组合能力；UI 从 `session/event` 渲染，并通过 Agent 接口驱动输入。因此可以在不改 Agent Loop 的前提下增加 WhalePod Bridge 或自有界面，但上游仍处于会发生破坏性变化的 developer preview，必须锁版本并维持契约探针。

## 2. 产品层级

```text
Team
├── Projects
│   └── Tasks
│       └── Task Room
│           ├── 人类责任人、评论、验收
│           ├── Agent Runs
│           ├── Approval Inbox
│           ├── Artifact Shelf
│           └── Run Console（继承 DSH 运行语义）
├── Agents
├── Plugins
└── Members & Devices
```

用户第一眼看到“团队正在完成什么”，第二层看到“这个 Task 卡在哪里”，第三层才进入“某个 Agent Run 内部发生了什么”。

## 3. DSH 继承边界

| 层 | 直接继承 / 组合 DSH | WhalePod 自己拥有 | 桥接方式 |
|---|---|---|---|
| Runtime | Agent Loop、Session、Turn/Step、Tools、Skills、MCP、Subagent、模型适配器 | Run 调度、真人责任、取消与重跑血缘 | `runId ↔ sessionId`，Node 启动独立 Runtime |
| 插件 | Cordis Plugin、Profile、Bundle、能力 seam | curated catalog、团队安装、Agent Profile 授权 | WhalePod overlay + 锁版本 + capability digest |
| 安全 | DSH 工具审批入口、Sandbox seam | Workspace 所有权、谁能批准、脱敏与超时 | Bridge 将 `ask` 投影为 Team Approval |
| 事件 | `session/event`、Agent 状态、工具生命周期 | Team Event Log、Task 活动流、可见性 | owner-only / project 两级事件投影 |
| UI | Run Console 的对话、步骤、工具、插件状态语义 | Team、Project、Task Room、Artifact 发布、成员协作 | WhalePod UI 读取产品投影；按需展开 Run Console |

### 不直接 Fork DSH Web 的原因

> **2026-09-10 更新（ADR-0008）**：本节结论已被推翻——改为**分层 Fork DSH client UI 源码**
> （L1 主题 token → L2 原语 → L3 运行视图；壳与 RPC 永久不取）。本节四条理由仍是对
> 「全壳 Fork」的有效否决（对应 ADR-0008 的 L4 禁止项），而**继承边界（§1/§2）不变**：
> DSH 仍是 Runtime，不成为顶层导航与团队事实来源。详见 `docs/adr/0008-fork-dsh-client-ui.md`。


1. DSH Web 的首要对象是本地 Workspace 与 Session；WhalePod 的首要对象是团队交付 Task。
2. DSH 当前指南是“配置模型 → 选择 Workspace → 启动 Session”；WhalePod 必须先表达责任、公开进展、审批边界和 Artifact 发布。
3. 把团队身份和权限塞进 Runtime UI 会让上游升级、隐私边界与团队事实同时耦合。
4. DSH 官方明确仍在 developer preview；组合公开 seam 的升级成本低于长期维护产品级 Fork。

## 4. 原型要回答的产品问题

1. Task Room 是否比聊天首页或看板首页更能表达“人和多个 Agent 一起交付”。
2. 成员能否在十秒内判断：谁负责、谁在运行、卡在哪里、需要谁批准、交付物在哪里。
3. DSH Run Console 作为第二层面板时，是否仍保留足够强的 Agent Runtime 控制感。
4. 三种结构中哪些局部值得合并成正式方向。

## 5. 三个结构性变体

### A — Task Room（推荐）

- 信息架构：Project/Task 左侧导航 + Task Room 中央协作时间线 + 右侧“现在需要关注”面板。
- 首要动作：处理阻塞、查看交付、进入某个 Run。
- 气质：温暖、可信、像一间长期工作的团队工作室，而不是运维后台。
- 优势：人的责任、Agent 的运行和交付结果同时可见。
- 风险：任务很多时需要再补更强的跨 Task 总览。

### B — Mission Control

- 信息架构：顶层 Team 导航 + 高密度工作队列表 + 阻塞/运行/交付三条横向泳道。
- 首要动作：跨 Task 分诊、批量发现风险、进入异常项。
- 气质：冷静、数据密集、类似小团队的运行控制台。
- 优势：同时管理多个 Task 时扫描效率最高。
- 风险：容易把成员和 Agent 变成状态小方块，协作关系较弱。

### C — Harness First

- 信息架构：Session 导航 + DSH 风格 Run Canvas + 插件与执行环境检查器，Task 只作为上方上下文。
- 首要动作：向 Agent 继续输入、观察工具调用和运行状态。
- 气质：深色、开发者工具感、最接近直接继承 DSH Web 的路线。
- 优势：高级用户控制感最强，也最容易承接 DSH 插件 UI。
- 风险：真人责任、Task 交付与多人协作退居次位，用来证明“为什么不能直接继承整个 DSH Web”。

## 6. 统一演示数据与核心场景

三个变体必须使用同一组数据，避免因文案和数据密度不同造成误判：

- Team：Northstar Studio，5 名成员，3 台在线 Device。
- Project：Launch Kit。
- Task：`TT-24 发布前安全检查`，责任人 Bob，优先级 P0，今天 18:00 截止。
- Agent：Builder 正在运行；Reviewer 等待已发布 Artifact。
- Run：Builder Run #18，处于 `waiting_approval`。
- Approval：执行 `pnpm audit --fix`，只能由 Bob 允许或拒绝，剩余 08:42。
- Artifact Candidate：`security-review.md`，尚未发布给 Project。
- 最新团队消息：Alice 请求保留依赖升级的影响说明。

核心点击路径：

1. 进入 `TT-24`。
2. 找到等待 Bob 的审批。
3. 展开 Run Console，查看 DSH 的 Turn、Tool 与 Plugin Pack。
4. 返回 Task Room，预览候选 Artifact。
5. 发布后启动 Reviewer Run。
6. 真人责任人最终完成验收；Agent 不能直接关闭 Task。

## 7. 交互范围

原型只做浏览器本地状态，不请求服务器、不写真实数据：

- `?variant=A|B|C` 可分享、刷新稳定；底部浮动切换器和键盘左右键切换。
- 点击 Run 打开 Run Console；`Escape` 关闭并把焦点归还给触发按钮。
- 审批允许/拒绝、发布 Artifact、发送评论均为可恢复的本地演示状态，并明确标记“仅原型”。
- Artifact 预览使用语义化 Dialog。
- 窄屏下导航与检查器折叠，关键阻塞仍排在正文最前。

## 8. 视觉语言

- 品牌不是蓝紫渐变式 AI 产品；以墨色、纸张暖白、信号橙和运行绿建立“可信工作现场”。
- A 使用编辑式排版、细线分区和少量实体表面；B 使用紧凑表格与泳道；C 使用高对比暗色控制台。
- 不依赖外部字体、图标 CDN 或图片，保证离线双击可打开。
- 状态同时使用文字、图标和颜色；不能只靠颜色传达。
- 所有可点击对象使用原生 `button` / `a` / `dialog`，提供可见焦点和不少于 40px 的主要触控区域。

## 9. 成功判定

- 三个变体在结构、信息优先级和主要动作上明显不同。
- A 中无需进入 Run Console 即可判断责任人、阻塞和交付状态。
- C 能让人感到“这就是 DSH 的强运行内核”，同时直观看到它不适合作为团队首页的原因。
- 桌面 1440×900、平板 1024×768、手机 390×844 均无页面级横向滚动。
- 键盘可完成变体切换、打开/关闭面板、审批和 Artifact 预览。

## 10. 官方依据

- [DeepSeek Harness README](https://github.com/deepseek-ai/deepseek-harness)：Everything is a Plugin、Web 启动方式和 developer preview 状态。
- [DeepSeek Harness Architecture](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)：Cordis 插件树、Profile/Bundle、Session Event 和 UI 接入 seam。
- [Use the Web UI](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/index.md)：当前 DSH Web 的模型、Workspace、Session 和审批主流程。
- [Extension Cookbook](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cookbook/extension-cookbook.md)：UI 插件从 `session/event` 渲染并通过 Agent 接口驱动输入。
