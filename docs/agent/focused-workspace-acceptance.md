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
| web.workspace | 视图按钮、独立输入、真实讨论投影 | 默认执行，来回切换留稿；成员讨论不被送往 Agent |
| web.approval | 双会话 DOM 与真实 Run 终态 | 只有责任人可审批；讨论中有待审批入口；他人看不到候选 |
| web.artifact | 受控内容请求、发布、Task 查询 | 预览失败可重试；发布前私有，发布后共享；Run 完成不完成 Task |
| web.layout | 1440/1024/736/390/320 的布局读数和焦点 | 无横向溢出；详情关闭还焦；任务约定入口可达 |
| runtime.bridge | Run completed 与 Runtime 释放 | 等待真实结束，不靠前端计时或动画推进状态 |

## 取证、归因与限制

证据在 `artifacts/evidence/focused-workspace/<随机目录>/facts.json`，只记录白名单事实、Run id
与布局读数，截图作为人工复核材料。独立判定器要求全部四类事实、五档宽度、截图及空错误列表，
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

- Q0：`pnpm check` 通过，158 个文件、1793 项通过、7 项预期失败。
- 聚焦工作区 Q5：四类场景通过；五档宽度无横向溢出；机器事实独立重判通过。
- 原双成员任务主链（p1-07）：通过，含键盘留言与对比度门。
- 统一执行与准备往返（p1-315）、跨成员交接（p1-381）、Micro 双成员交互（p1-306）：通过。
- Web 生产构建通过；格式、lint、Web 类型检查通过。
- 本次成功证据：`artifacts/evidence/focused-workspace/9afcbb01/`。失败/中断尝试无 facts.json，不能作为成功证据。
- GitHub：两项账号凭据均失效，未登记 Issue、推送或创建 PR；本地分支为 `feat/focused-workspace`。
