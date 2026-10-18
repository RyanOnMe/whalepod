# 抽屉与二级页面统一验收

- 对应门禁：Q0、Q5；Issue [#391](https://github.com/RyanOnMe/whalepod/issues/391)。
- 上次验证：2026-10-18；实现 `319cca6`，评审整改 `5d6880e`；基线 `844d004`。

## 用户路径与展示取舍

进入任务，查看约定、交付与复核、运行详情和 Run Console；关闭后回到原入口。
进入项目、任务权限、设备、Agents、成员与插件页，查看内容或显式展开创建、配置和说明。
帮助说明可以收起；真实失败、审批风险、候选私有状态与阻断仍直接呈现。

| Before | After | Why |
|---|---|---|
| 抽屉内重复标题、说明与文件元数据密集排列 | 单一标题；文件信息、复核说明与低频规则可展开 | 让任务与交付内容成为阅读主线 |
| 各二级页标题、按钮与卡片间距不一致 | 共用 PageHeader、图标关闭与说明折叠样式 | 保持相同操作位置与层级 |
| Agent 创建表单常驻，技术配置先于角色内容 | 页头显式新建；模型版本与角色优先，参数收进配置详情 | 区分阅读、创建和高级配置；折叠保留草稿 |
| 包标识与摘要常驻占据插件卡片 | 审核、能力与许可可见；组合信息按需展开 | 重要能力与可信来源仍可直接判断 |
| 确认内容最小宽度超过模态容器 | 自适应容器并允许按钮换行 | 三档宽度下完整展示风险正文与确认操作 |

本批次不新增依赖，不改 vendor、服务端协议或权限策略。

## 驱动

```bash
pnpm check
pnpm test:e2e:workspace
pnpm exec tsx scripts/verify-workspace-evidence.mts artifacts/evidence/focused-workspace/<本次目录>
scripts/secret-scan.sh artifacts/evidence/focused-workspace/<本次目录>
```

驱动是 `focused-workspace.spec.ts` 与 `secondary-surface-audit.ts`：真实 Chrome、一次性
PostgreSQL、包解析后的 Hub、真实 Node/Runtime 和 DSH replay。Setup、任务、指令、
约定草稿与确认、发布和审批均走生产 HTTP/UI；静态 Plugin Pack 沿用已登记种子。
不直写运行状态、投影或任务权限。原始 trace 关闭，证据不归档口令、Cookie 或本机路径。

## 观测、判定与归因

原五类工作区事实继续保留：`web.micro`、`web.workspace`、`web.approval`、
`web.artifact`、`web.layout`，见[聚焦任务工作区验收](./focused-workspace-acceptance.md)。
新增 `web.surfaces`，由独立判定器检查：

- 三个任务抽屉、Console 与六个二级页面，在 1440、390、320px 共 30 条布局读数中，主标题各一个，页面无横向溢出，截图齐全。
- 约定抽屉无重复标题；文件元数据默认收起；Agent 创建草稿收起、重新展开仍保留。
- 发布确认中 Escape 先关闭内层确认，保留抽屉并还焦，候选仍对另一成员不可见；真正确认后才共享。
- 完全权限确认在三档宽度中，正文、标题、按钮矩形均处于模态范围内且内容无横向滚动。
- 取消完全权限确认后，页面仍是未覆盖，真实任务 GET 的 approvalPolicy 仍为空；普通成员没有应用权限入口。
- Console 数据就绪且 opacity=1、transform=none，页面内容与 crossfade 结束后才采图；截图辅助人工视觉审评，业务成功由事实与真实请求判定。

缺事实、重复事实、缺截图、空读数、越界或浏览器错误均失败。当前 schema 要求六类事实；
历史五类证据包保留为历史记录，须复跑才能符合本批判据。

标题、元数据、样式或焦点问题先看 `web.surfaces`；草稿看 `web.execution` 与挂载边界；
审批、候选或持久化不一致先查 Hub 受众投影与任务 GET；执行异常按
hub.run → node.supervisor → runtime.bridge 归因。

## 取证与结果

成功证据：`artifacts/evidence/focused-workspace/7233e47d/`，含六类 facts、30 张页面/抽屉图、
三档确认框、创建与设备指南预览及独立 validation。失败尝试不生成 facts.json。
质量门日志经 redactText 归约后入包，最后结果以同包 `quality-gates.json` 和关联 PR 的必检为准。

先红提交：`594ccd3` 覆盖六页与抽屉层级，`7b740aa` 复现嵌套确认的 Escape 冒泡，
`a9f535a` 在真实 Chrome 复现确认框裁切。实现与整改均保留原请求载荷、权限、pending 与错误断言。

独立审批 agent 审查固定实现 `5d6880e` 与最终图片，独立复跑六类判定通过，批准代码和视觉；
曾指出的确认框裁切与动画中途采图均已修复。合入条件仍为受影响 Q5 和 GitHub 必检通过。

## 扩展回归与边界

```bash
pnpm --filter @whalepod/web build
pnpm exec playwright test --project=p1-07
pnpm exec tsx scripts/run-preparation-return.mts
pnpm exec tsx scripts/verify-preparation-return-evidence.mts artifacts/evidence/preparation-return/result.json
pnpm exec tsx scripts/run-handoff-loop.mts
pnpm exec playwright test --project=p1-19
pnpm test:e2e:micro
pnpm exec playwright test --project=p1-158
pnpm exec playwright test --project=p1-141
pnpm exec playwright test --project=p1-142
```

浏览器组串行冷启，避免端口与单团队 Setup 互相污染。创建 Agent 改为显式打开入口，
配置说明与复制摘要改为先展开对应区域；原正向、拒绝、故障恢复和复制全值判据保留。
本批验证的是 replay 驱动下的生产装配与 UI，不声称验证了外部模型服务或替代真人长期试用。
