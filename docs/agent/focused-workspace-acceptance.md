# 聚焦任务工作区验收

关联 ADR-0018。用户路径：进入任务 → 独立团队留言 → 选择 Agent 执行 → 责任人批准一次
→ 检查私有候选 → 发布给团队 → Task 保持进行中。约定、运行输入与交接、复核仍可达。

## 驱动与判定

```bash
pnpm check
pnpm exec playwright test --config=playwright.workspace.config.ts
pnpm exec tsx scripts/verify-workspace-evidence.mts artifacts/evidence/focused-workspace/<本次目录>
scripts/secret-scan.sh artifacts/evidence/focused-workspace/<本次目录>
```

Q5 用仓库统一生产装配：一次性 PostgreSQL、包解析后的 Hub server、真实 Node / Runtime
和 DSH replay。Setup、邀请、项目、任务、接受、指令、审批与发布均走现有 HTTP / UI 路径。
静态 Plugin Pack 使用已登记种子；不直写运行状态或团队投影。内容接口故障仅暂时返回 500，
恢复后读取真实产物。原始网络 trace 关闭，不归档口令、Cookie、Token 或成员本地路径。

组件判据在 `apps/web/tests/focused-workspace.spec.tsx`；既有讨论、审批、约定、交接、
复核与候选判据改用显式视图入口驱动，继续检查原接口载荷、并发与权限。

| component | 观测 | 必须通过 |
|---|---|---|
| web.micro | PromptBar 原生输入、Glide 菜单几何和键盘状态 | 1440/390/320 三档菜单不溢出；Escape 还焦；键盘选择；减少动态无位移过渡 |
| web.workspace | 视图按钮、独立输入、真实讨论投影 | 默认执行，来回切换留稿；成员讨论不被送往 Agent |
| web.approval | 双会话 DOM 与真实 Run 终态 | 只有责任人可审批；讨论中有待审批入口；他人看不到候选 |
| web.artifact | 受控内容请求、发布、Task 查询 | 预览失败可重试；发布前私有，发布后共享；Run 完成不完成 Task |
| web.layout | 1440/1024/736/390/320 的布局读数和焦点 | 无横向溢出；详情关闭还焦；任务约定入口可达 |
| runtime.bridge | Run completed 与 Runtime 释放 | 等待真实结束，不靠前端计时或动画推进状态 |

## 取证、归因与限制

证据在 `artifacts/evidence/focused-workspace/<随机目录>/facts.json`，只记录白名单事实、Run id
与布局读数，截图作为人工复核材料。独立判定器要求全部五类事实、五档宽度、截图及空错误列表，
缺文件、缺环节、重复事实或错误状态一律失败；失败运行不生成 facts.json。

切换丢稿先看 web.workspace 的挂载边界；还焦/锚点失败先看 web.route 与可见视图；
审批或候选错误先看 hub 的受众投影，再看 web 对入口和数量的过滤；执行失败沿
hub.run → node.supervisor → runtime.bridge 归因。

本轮不改服务端协议、状态机、许可或候选权限。真实团队使用感受仍需真人试用，不能用自动化通过替代。
GitHub 认证当前失效，Issue 登记和 PR 关联待恢复认证后完成。

## 展示取舍

| Before | After | Why |
|---|---|---|
| 讨论、执行、属性与交付同时铺开 | 单个主对话，明确切换讨论与执行 | 聚焦当前工作，输入对象始终明确 |
| 已接受后仍显示快照占位卡 | 简短责任提示；真实运行按需查看 | 不以占位说明挤占主内容 |
| 发布检查在页面长列底部 | 文件入口打开详情；窄屏占用主内容区域 | 检查、发布与返回路径连续 |
| 工具事件与助手输出同权重 | 助手输出为主，工具与运行记录可展开 | 保留证据，降低日常阅读负担 |

## 本次结果（2026-10-18）

实现提交：`119e393`（基线 `44e46c3`）。

- Q0：`pnpm check` 通过，158 个文件、1793 项通过、7 项预期失败。
- 聚焦工作区 Q5：四类场景通过；五档宽度无横向溢出；机器事实独立重判通过。
- 原双成员任务主链（p1-07）：通过，含键盘留言与对比度门。
- 统一执行与准备往返（p1-315）、跨成员交接（p1-381）、Micro 双成员交互（p1-306）：通过。
- 完整产出链（p1-19）：15 项全部通过，含审批拒绝、输入快照、故障恢复、修订发布、真人完成和个人行动入口。
- Web 生产构建通过；格式、lint、Web 类型检查通过。
- 本次成功证据：`artifacts/evidence/focused-workspace/d5bd8365/`。失败/中断尝试无 facts.json，不能作为成功证据。
- GitHub：两项账号凭据均失效，未登记 Issue、推送或创建 PR；本地分支为 `feat/focused-workspace`。


## 工作区 Micro 精修批次

组件来源仍固定为 `react-bits@d86fccbd477786f94ca7eb891fbe0ec039d3cd3b`；新增四组
PromptBar、GlideSelect、SpringCheck、SquishSwitch 的原始哈希与本地改编见 vendor manifest。
保留上游完整许可、版权和根 NOTICE；没有新增 Motion、图标包或 catalog/lockfile 变更。

| Before | After | Why |
|---|---|---|
| 指令、Agent、发送分散排列 | PromptBar 内输入正文在上、工具与发送在下 | 形成一个清晰输入对象，保留原提交、快捷键和放权确认 |
| 工作区下拉沿用表单外观 | 紧凑 GlideSelect，从触发位置展开、滑动高亮 | 菜单 portal 避免被滚动区裁切，键盘即时反馈 |
| 材料复选框和约定按钮缺少状态细节 | SpringCheck 原生复选框与受控 SquishSwitch | 选中材料不表示任务完成，约定开关只反映服务端确认值 |
| 视图切换与文件卡片样式不统一 | RubberSegment 与轻量文件图标、标题/状态层次 | 强化当前视图与文件入口，保留候选权限和检查发布路径 |

新增 `workspace-polish.spec.tsx`、`micro-workspace-controls.spec.tsx` 和约定失败用例。
检查指令只有一个、讨论草稿保留、菜单 portal、空列表 Escape、方向键跳过禁用、首字母、
重复选择、材料原生键盘与 fieldset 禁用，以及开关 pending 拦重复/失败不乐观切换。
真实浏览器曾发现菜单测量前 `visibility:hidden` 导致初始焦点失败，现将聚焦放在定位提交后，
由 Q5 原生焦点断言覆盖，不能以 jsdom 通过替代。

精修证据新增 `web.micro` 与 `micro-menu-{1440,390,320}.png`，判定器升级为五类事实。
旧四类证据保留为历史记录，不符合当前五类 schema，须按新命令复跑。
菜单/键盘问题先看 web.micro 的定位和焦点；开关假成功先看 web.agreement 读模型与 PATCH，
材料选择问题先看 web.execution 输入快照，不以勾选动效推断业务完成。


## 精修批次最终结果（2026-10-18）

最终代码 `39987ef`（精修实现 `e6e9cad`、导航修复 `9a45c22`，基线 `44e46c3`）。

- Q0：`pnpm check` 通过；160 个文件、1806 项通过、7 项预期失败。最终 harness 补充后格式、lint、Web 含测试类型检查再通过。
- Q5：工作区、统一执行 p1-315、跨成员交接 p1-381、Micro 双用户及完整产出链 p1-19 共 19 项通过；完整链包含 15 项正向、拒绝、故障恢复、修订与真人确认。
- 生产 Web 构建与许可门通过，626 个依赖包均在允许面或有据白名单内；第三方适配无新增依赖。
- 独立审批 agent 在实现完成后创建，先拒绝并指出详情面板遮挡视图/锚点；先红测试复现后修复，独立复跑 29 项通过，最终批准 `39987ef`。
- 最新证据：`artifacts/evidence/focused-workspace/e19411a7/`，含五类 facts、独立 validation、quality-gates、脱敏质量门日志和稳定截图。菜单展开时判定 portal，等待入场结束再量边界与截屏；另检查高级设置标签可见。
- 展开详情后点击团队讨论会收起详情；同任务讨论、执行、指派与审批锚点恢复到可见目标并聚焦。三个 hash、可见视图按钮和审批 hash 共五条回归先红后绿。
- 最后一次并发检查出现旧文案选择器与模块加载 5 秒超时：选择器同步到精简文案，原业务断言保留；结束浏览器运行后串行重跑完整 Q0 已通过，没有放宽超时或跳过检查。
- GitHub 登录由用户选择稍后处理；未创建 Issue/PR、未触发服务端 CI、未合入。恢复认证后须同步远端、登记 Issue/分支、走 PR 必检 CI 与 squash 合入。
