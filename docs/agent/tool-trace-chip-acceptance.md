# 工具轨迹内联 chip 验收（P1-UX-7 / #246，父账 #243 第 2 条）

## 这条切片改变什么

回答「刚才它干嘛了」此前要跨三层：指令流（说了什么）→ 运行卡（跑没跑完）→ Console 覆盖层
（具体工具输出）。本切片在指令条目上内联**该 Run 最近一次工具调用**的 chip（「已用工具：bash」），
点击直达该 Run 的 Console——「说了什么」与「做了什么」同一条流渐进展开。架构不动：Console 仍是
审计真源，chip 只是一层内联摘要（对照 ChatGPT Work 台对话流里的「已运行命令」chip，#243 取证）。

## 数据链与受众安全（本切片的承重点）

- **形状**：房间视图 Run 投影新增 `lastToolCall: { tool, at } | null`。服务端一条
  `DISTINCT ON (run_id)`（seq DESC）取每个 Run 最新一条 `tool.started` 的 `toolName`
  （`packages/db/src/repositories/event.ts` 的 `latestToolStartsByRun`）。
- **受众收缩是安全判据**：房间视图全员可见，摘要**只从 project 受众行取**。projector 对
  `tool.started` 双受众投影：两行 `toolName` 相同，project 行的 preview 已收缩到只剩类别
  （§9 二层收缩）——owner 行的命令正文/文件名绝不能进房间视图。集成用例专门构造了
  「owner-only 高 seq、不同工具名」的越权场景：摘要必须仍是 project 行的值，红了就是泄漏。
- **chip 只显工具名不显参数**：参数在 owner preview 里，属 owner 受众面。

## 驱动与判定

- **Q1 web**（`instruction-list.spec.tsx` #246 组 3 例）：chip 存在+文案+点击回调 runId；
  无工具调用/未绑定 Run 不画；chip 与运行号入口并存互不替代。页面级接线
  （`task-room.spec.tsx`）：runs→map→prop 的线 + 点击开 Console 覆盖层。
- **Q2 集成**（`apps/hub/tests/room-tool-preview.integration.spec.ts`，CI 验）：无事件→null；
  双受众成对时取最新 toolName；**owner-only 高 seq 不进摘要**；多 Run 各取各的最新（不串档）。
- **Q0**：`pnpm check` 全绿。

## 设计取舍记录

- `DbHandle` 的 Pick 面扩了 `selectDistinctOn`（同族 PG 方法，与 `select` 一个家族）——
  没有为绕开它写裸 SQL 或 JS 端全量拉取。
- 读模型不信任写路径：payload 里 `toolName` 不是合法非空串就当「没有工具调用」，不抛不画。
- 不做工具历史列表（那是 Console 的「工具」筛选口径）；chip 只回答「最近在用什么」。
- 房间视图两条派生查询（#244 预解析 + 本切片摘要）都依赖 runs，统一放 Promise.all 之后并行。

## 边界与债

- 摘要是**取数时刻**的快照，运行中 Run 的 chip 随房间视图失效刷新（实时链既有口径）。
- `tool.finished` 的 outcome（失败标记）不进 chip——「最近在用什么」与「失败了吗」是两个问题，
  后者由运行卡状态与 Console 回答；要带上时另立判据。
- Q5 e2e 挂 #243 总账既有债。
