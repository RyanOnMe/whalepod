# ReactBits 工作台组件验收（P1-423）

## 路径与范围

用户从项目首页进入任务，搜索另一项工作，打开任务约定/运行/交付抽屉，阅读 Agent 活动及工具结果。
本轮扩展 #421 的同一编译包，新增六个已授权网页来源的受控展示组件，合计九个导出。
不引入新的业务模型、演示任务、虚假进度、配置依赖或 DSH 版本变更。

| 来源 | 展示组件 | 真实接入 |
| --- | --- | --- |
| App Sidebar 4 | SidebarProfile | 桌面会话身份与原退出按钮 |
| Command Menu 1 | CommandFrame | 全局搜索分组、图标、输入行及键位栏；手机顶栏新增真实入口 |
| App Dialog 6 | SheetHeading | 任务约定、运行、交付抽屉的唯一标题与关闭按钮 |
| Empty State 1 | EmptyPanel | 项目、Agent、任务、搜索空态；首项目引导只展开已有表单 |
| Agent Activity 3 | ActivityFrame | 仅 public phase、连接和页面可见性控制活动弧；终态停止 |
| Tool Calls 2 | ToolCallFrame | 对话记录及 Console 的真实工具名、状态、结果图标；无参数或假重试 |

来源链接、保留摘录摘要、私有适配输入与分发资产摘要见
`apps/web/src/vendor/collectui/manifest.json`。同名示例的本地私有摘录及可编辑适配仅在
`artifacts/private-ui/collectui/`。这是 minify 后的应用展示包，不宣称加密或不可逆保护。
延续维护者已确认的分发授权；许可独立于 WhalePod Apache-2.0。

## 设计复核

| Before | After | Why |
| --- | --- | --- |
| 搜索仅一条带框输入，提示文字较长 | 单一搜索行、分组图标、选择反馈、底部键位栏 | 让结果成为重点，操作可发现 |
| 手机缺少可见搜索入口 | 顶栏图标入口，仍复用同一搜索逻辑 | 窄屏和宽屏都能直接搜索 |
| 关闭和无结果恢复主要依赖按键/手工删除 | 显式关闭、清空，键盘 Enter 不误触发导航 | 鼠标、触摸、键盘路径完整 |
| 空态只有说明文字 | 克制的叠层图形、短标题、实际可用的创建入口 | 提供识别与下一步，不制造假数据 |
| 抽屉标题与内容缺少识别线索 | 统一图标、唯一标题与关闭槽 | 跨三类详情保持空间一致 |
| 运行行和工具 chip 缺少层次 | 活动弧、终态勾选、工具名/结果双栏 | 快速区分正在执行与已有结果 |
| 侧栏姓名与角色平铺 | 姓名首字符头像、两行身份与独立退出 | 更紧凑的身份分组 |

高频搜索无进出动画；活动动画只表达已知执行事实，减少动态效果时停用。
不修改服务端权限、审批参数、运行关联、对话草稿、主滚动跟随或交付发布行为。

## 驱动、观测与判定

```bash
pnpm check
pnpm test:e2e:workspace
node --import tsx scripts/verify-workspace-evidence.mts artifacts/evidence/focused-workspace/<本次目录>
node --import tsx scripts/verify-workbench-evidence.mts artifacts/evidence/focused-workspace/<本次目录>/facts.json
pnpm test:e2e:micro
node --import tsx scripts/run-conversation-acceptance.mts
```

生产装配沿用 focused-workspace：一次性 PostgreSQL、真包解析 Hub/Node/Runtime、DSH replay。
新增驱动 `apps/web/tests/e2e/workbench-bits-audit.ts` 走页面和实际 HTTP；不直写运行状态或投影。
`web.workbench` 记录 start/room/run 各三档（1440/390/320）：

- start：空态和搜索几何、唯一搜索入口、桌面侧栏互斥、真实 Tab/Enter 清空、Esc 回焦、无业务 POST。
- room：同一真实任务结果键盘直达、约定抽屉唯一标题、关闭回焦、欢迎面/抽屉几何、无额外 POST。
- run：真实完成后的工具卡与活动行几何、completed 且非 working、已加载 CSS 的 reduced-motion 停转规则。

判定器 `scripts/lib/workbench-evidence.ts` 可独立运行，不调用浏览器驱动。缺事实/档位/几何、溢出、意外 POST、焦点错误、终态假活动或缺少减少动效规则均失败。
其 spec 以变异自证反向判据。工作区总判定器同时核对八组场景和十八张本轮截图；原 App UI、二级页、权限与审批判据继续执行。
组件级测试另外验证三条真实操作无意外 POST；原运行与工具状态族覆盖连接中断、取消、未知阶段、事件配对及受众过滤。

## 证据与归因

`artifacts/evidence/focused-workspace/<本次目录>/facts.json` 含 `web.workbench`，截图为
`workbench-{empty,search,search-empty,results,drawer,run}-{1440,390,320}.png`。截图只做视觉复核，不能替代事实判定。
出包扫描 `scripts/secret-scan.sh <证据目录>`；不保存登录口令、凭据、Cookie、原始源码或 trace。

导航/几何/焦点先看 web.workbench；搜索返回先看 hub.http 与现有搜索接口；运行状态先看
web.activity/tool-call-state 对应的 public phase / outcome；投影异常再对 hub.domain、node.gateway。
分发异常先核对 vendor/collectui 清单；授权维护者用 `node --import tsx apps/web/tools/build-collectui.mts` 重建，公开 clone 直接使用已提交资产。

## 本轮结果

2026-10-23，本轮 Q0 通过：177 files、1,939 passed、7 expected fail。工作区生产 Q5 1/1 通过，最终事实与实拍在 `artifacts/evidence/focused-workspace/fb172131/`。独立工作区判定 8 场景，新增工作台判定 201 项 / 9 档布局通过。

视觉复核发现底层 Modal 固定宽度会裁切内部搜索内容，已在宿主设置专用尺寸并增加内外框和全部键位栏的边界判据。三档复验通过。626 个依赖许可门、分发包与本次证据敏感扫描通过。

固定实现提交：`df756f7ae70a4337847e79bc4251c8760d25294b`。独立审批 agent 明确批准，独立验证 68 项前端测试、3 项负控、资产与私有输入摘要；其提出的 P3 窄屏用户名残字已改为 ≤360px 有意隐藏，390px 保留，并通过复审。首页截图等骨架退出后再取证。

生产回归：P1-19 完整执行/拒绝/交付/复核/恢复链路 15/15；Micro 1/1；连续对话 2/2，独立判定 123 项通过。P1-19 运行后仅有上述 10 行顶栏 CSS 与验收观测精修；最终 Q0、工作区、Micro、连续对话都在精修后通过。最终 CI `check` / `integration` 必须在合入前通过最终分支提交；不绕过保护。浏览器范围为 Chrome；没有声称已测所有辅助技术。
