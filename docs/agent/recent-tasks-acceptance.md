# 最近任务（侧栏）验收（P1-UX-10 / #252，父账 #243 第 5 条刀一）

## 这条切片改变什么

回到昨天的工作现场此前要 项目→项目卡→任务 三跳。本切片给侧栏（宽屏）加「最近任务」
直达区（≤6 条：标题 + 状态中文 + 项目名 + 相对时间），登录后 ≤1 击回到最近活跃任务。
对照 ChatGPT 侧栏的「最近」（#243 取证已确认）。刀二（⌘K 全局搜索）另行立项。

## 「最近」的口径：按活动，不按建单

`GET /tasks/recent`（Member，≤8 条），活动 = **greatest(task.updated_at, 该任务最新
task_message.created_at, 该任务最新 run.created_at)**。集成 spec 的核心判据：昨天建、
今天有人发言的旧任务必须排在刚建的新任务前面；Run 活动同样算数。实现是两个活动聚合
子查询 + LEFT JOIN + greatest 一条 SQL（无活动的任务回落自身 updated_at），不 N+1。

投影是**窄视图** `RecentTaskView { id, projectId, projectName, title, status, lastActiveAt }`
——只带侧栏要画的字段，不把 TaskView 的形状扩散到侧栏。projectName 帮助区分同名任务。

## 驱动与判定

- **Q2 集成**（`apps/hub/tests/recent-tasks.integration.spec.ts`，CI 验）：排序三段判据
  （建单序 → 消息翻转 → Run 再翻转）；投影含 projectName/ISO 时间；上限 8（第 9 个
  不出现、最新者最前）。
- **Q1 web**（`apps/web/tests/recent-tasks.spec.tsx`，3 例）：条目渲染 + 点击直达任务房；
  空态「最近还没有任务」；错误态「读取失败+重试」且不遮挡主导航、重试是真实 refetch。
- **Q0**：`pnpm check` 全绿（108 文件 1355 过 / 7 预期失败为既有深色 it.fails 债）。

## 设计取舍记录

- **小节标签不是标题元素**（`<p>`）：侧栏「最近任务」若是 `<h2>`，各页「只有一个 h2」
  的标题层级判据全红——小节标签不进文档大纲（ChatGPT 侧栏同款处理），可达名由 nav 的
  aria-label 提供。
- **「重试」撞名的消歧**：侧栏错误态与任务房错误态各有一个「重试」，既有任务房判据
  scope 到 main 区（本就指主区那个，不是削弱）。
- 加载中不占视觉重量（首帧主导航先出，最近任务迟到半拍没关系）。
- 「最近」是**全团队视角**（单 Team 部署、任务全员可见，与任务列表同口径），不是
  「我参与过的」——个人化过滤与 ⌘K 搜索一起在刀二考虑。
- 缓存 staleTime 60s；任务房内变更对最近列表的失效接线在刀二统一处理。

## CI 三轮 500 的三条 drizzle 教训（都是本切片抓的，写下来别再踩）

1. **子查询里 `sql.as()` 字段的外层引用会丢限定名**：`lastMessage.last` 渲染成裸 `"last"`
   而不是 `"last_message"."last"`，两个子查询还同名撞列 → column not exists。**定位手法：
   `toSQL()` 探针本地复现（临时脚本 + lazy postgres 工厂，不连库）**——SQL 类问题不必烧
   CI 轮次。规避：活动聚合改内联相关子查询（每行两扫，团队规模下可接受）。
2. **裸 sql 字段的时间值是字符串**：drizzle postgres-js 驱动把 timestamptz（1184 等）
   解析器换成透传，普通列靠**列映射器**转 Date，raw sql 表达式绕过映射器——视图层
   `.toISOString()` 收到字符串直接 TypeError。**定位手法：TEMP-DEBUG 直调仓储**（仓储
   不炸、路由炸 ⇒ 错误在映射层不在 SQL 层）。归一化收敛在仓储（承诺 Date），调用点
   不各自 new Date。#246 的 `latestToolStartsByRun` 没踩是因为取的是真实列。
3. **教训的教训**：本地面无 Docker 时，SQL/映射类失败不要只靠 CI 轮次试错——toSQL 探针
   （第 1 条）与 TEMP-DEBUG 直调（第 2 条）各定位一轮，比盲改快一倍以上。

## 边界与债

- 窄屏顶栏不渲染最近区（空间受限）；折叠菜单里加最近入口属 Q5 面的后续。
- 置顶（pin）未做——另一个数据面。
- Q5 e2e 挂 #243 总账既有债。
