# ReactBits 页面与动效验收（P1-425）

## 用户路径与设计

项目首页浏览项目与任务，展开创建任务；在团队讨论中编辑、发送留言和引用运行；配置 Agent 与新 Revision；从个人待办筛选并进入原任务。
本轮把 Card 1、List 7、Comments 1、Settings Form 1、Notifications 4、Animated List、Modal Cards 七项网页来源加入现有私有编译工作流。合计十六项来源、十八个展示导出。

| Before | After | Why |
| --- | --- | --- |
| 项目名称、说明、多个操作及任务元信息平铺 | 单一项目面、图标身份、紧凑操作、独立任务行与状态 | 标题先读，动作与内容分组 |
| 讨论作者、时间和正文缺少视觉组织，输入框有重复提示 | 首字头像、作者/时间行、正文；独立输入面和引用/发送槽 | 让留言内容成为重点 |
| Agent 参数连续堆放 | 基本信息、角色、模型、工具与权限四区；高级选项默认收起 | 常用选择先呈现；审批效果始终可见 |
| 待办大卡内混排链接与说明 | 紧凑事项行、真实数量、全部/审批/交付/指派筛选 | 直接识别可处理的工作 |
| 列表出现和项目展开硬切 | 6px/160ms 列表入场、30ms 封顶四级错峰；160ms 可打断展开 | 解释新增与空间变化，避免装饰性循环 |

原始摘录和可编辑适配仅保存在忽略的 `artifacts/private-ui/collectui/`。公开分发仍为 minify 的 JS/CSS、宿主声明、许可及来源摘要；不宣称加密或不可逆。来源及资产摘要见 vendor/collectui/manifest.json，不引入新依赖。
Modal Cards 取淡入/滑动展开思路改为内联 grid disclosure，移除图片演示、全屏 portal、滚动锁。Animated List 改为首次显示过渡，移除自动加项、演示计时器与 Motion。业务网络、权限、幂等、草稿、运行引用仍由宿主负责。

## 驱动、观测、判定

```bash
pnpm check
pnpm test:e2e:workspace
node --import tsx scripts/verify-workspace-evidence.mts artifacts/evidence/focused-workspace/<本轮目录>
node --import tsx scripts/verify-pages-evidence.mts artifacts/evidence/focused-workspace/<本轮目录>/facts.json
pnpm exec playwright test --project=p1-19
pnpm test:e2e:micro
node --import tsx scripts/run-conversation-acceptance.mts
```

`pages-bits-audit.ts` 复用真实 Hub/Node/Runtime 和一次性 PostgreSQL 的 focused-workspace 装配。待办前置任务经页面创建，留言经页面发送，绝不直接插业务表或投影。
`web.pages` 三档 1440/390/320 各记录项目、待办、设置、讨论几何与页面宽度：

- 鼠标展开/收起，关闭后即时 inert + aria-hidden，快速重新展开可中断卸载。
- 键盘 Enter 保持焦点、展开时长为零；实际 reduced-motion 媒体设置下展开与入场时长为零。
- 现有待办筛选保留服务端原深链；刷新同一节点且无新动画；整个只读检查段零 POST。
- Agent 四个字段分组，高级参数编辑后收起/展开保留；必填高级字段无效时原生验证先展开再聚焦；审批效果提示可见。
- 讨论切换执行/讨论频道后保留草稿；唯一讨论输入框与原执行输入框互不冲突；最后真实发送并由另一成员读取。
- Member 无新建 Agent 入口。

独立判定器 `scripts/lib/pages-evidence.ts` 不调用驱动。缺场景、缺档位、缺几何、溢出、延迟、刷新重播、错误焦点/草稿/权限/深链或意外 POST 均失败。负控 spec 逐项破坏观测验证能红。
工作区总判定器核对九组场景与新增十二张页面截图；旧审批、工件、抽屉及搜索门继续执行。组件族继续验证失败保留、运行引用、请求体、重复提交守卫、待办隐私及成员禁写。

## 证据与归因

证据目录 `artifacts/evidence/focused-workspace/<本轮目录>/`，事实 `facts.json`，图片 `pages-{projects,inbox,settings,discussion}-{1440,390,320}.png`。图片用于视觉复核，不替代事实判定。证据出包运行敏感扫描；不保存 Cookie、口令、原始组件源码或 trace。
页面交互/几何/动效先看 `web.pages`；事项投影与留言问题再看 hub.http / hub.domain；原运行链按现有 evidence-map 检查 node.gateway / runtime.bridge / dsh.agent。资产缺失或摘要不符先看 collectui manifest，授权维护者从私有输入重建。

## 本轮结果

2026-10-23：红测提交 `865dd5c`、有效协议负例修正提交 `9a83b91`。Q0 179 files / 1,944 passed / 7 expected fail；工作区生产 Q5 1/1，最终证据 `artifacts/evidence/focused-workspace/65129273/`，九组场景及新增 138 项 / 12 档布局独立判定通过。截图在入场/展开完成后保存；626 个依赖许可门、分发包与证据敏感扫描通过。

完整执行链路、Micro、连续对话、独立审批与最终 CI 结果在合入前补齐。本轮未改变服务端状态机、权限、审批执行或依赖版本。浏览器验证范围为 Chrome。
