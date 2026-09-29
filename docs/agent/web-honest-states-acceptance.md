# 任务房间交互批次①（诚实性修复）验收

- 对应场景/门禁：Q1（`--project web` 组件面）；前端交互优化迭代批次①
- 对应 Issue：#225
- 上次验证：2026-09-30 · `fix/p1-225-web-honest-states` · 结果 PASS

## 验的是哪条用户路径

任务房间执行区的五条日常路径：看指令流里「我那句话起了哪个运行」（点运行号）、
选执行目标时等设备列表加载/遇到读取失败、取消或重跑一个 Run、用旧启动器起 Run 失败、
从任务房间回项目页。

## 修复内容

| # | 缺陷 | 修复 |
|---|---|---|
| 1 | 指令流「运行 R-xxxx」按钮死链（组件支持 `onOpenRun`，页面未接线） | `TaskRoomPage` 传入 `onOpenRun={setConsoleRunId}` |
| 2 | TargetPicker 加载中谎报「没有在线设备」；失败静默 | pending →「正在读取设备…」；isError → ErrorBanner + 重试（`.target-error`） |
| 3 | RunActions 绕开 react-query：成功不失效缓存（运行卡列表滞留）、错误无 requestId | 改 `useMutation`；成功失效 `['run', id]` + `['task-room', taskId]`；错误走 ErrorBanner |
| 4 | RunLauncher 自写 `.mutation-error`（无 requestId） | 统一 ErrorBanner |
| 5 | TaskRoom 无返回项目入口 | TaskHeader 顶部「← 回到项目列表」（复用权限页 `.mutation-hint` 形态） |

修复 2 的**正确副作用**：此前 TargetPicker 静默吞掉设备/工作区读取失败，现在如实
报错——三个只喂了部分夹具的既有用例（comment/approval/assignment 的失败路径）因此
多出一个 alert 而红，已补 `devicesHandler([])`/`workspacesHandler([])`（fixtures 新增
后者）夹具归因。

## 驱动（怎么触发）

```bash
pnpm exec vitest run --project web apps/web/tests/task-room.spec.tsx apps/web/tests/target-picker.spec.tsx apps/web/tests/run-actions.spec.tsx apps/web/tests/run-launcher.spec.tsx
```

## 判定（可证伪断言）

- 死链：点 `instruction-run` → `findByRole('dialog')` 出现（红→绿实测：修复前点击无任何反应）。
- 加载/错误：pending 断言「正在读取设备…」出现**且**「没有在线设备」不出现；500 断言 alert 含 message+requestId、重试后再发 devices 请求。
- 缓存失效：取消成功后 task-room GET 计数递增（invalidate 的机器判据；夹具里 `makeRunView.taskId` 必须与真实 task.id 一致，否则失效键打不中——这条判据正是抓它的）。
- 错误口径：取消失败/启动失败的 alert 含 requestId；RunLauncher 失败保留输入。
- 返回入口：`link /回到项目列表/` 的 href 为 `/`。

## 归因

- invalidate 判据红 → RunActions 的 `run.taskId` 与页面 task query 键不一致。
- 用例「Found multiple alerts」→ 某个新如实报错的组件没喂夹具（先补 handler 再归因组件）。

## 边界与未覆盖

- 纯组件层验证（jsdom 键盘/焦点/role）；e2e（Q5）本地 Docker 不可用未跑，由 CI check+integration 兜底模块面，浏览器渲染面待 Q5 全量。
- RunActions 的 invalidate 是**本地补齐**：event-router 的 `run.changed` 契约（只失效 `['run', runId]`）未动——协议面留待后续批次评估。
- RunLauncher 与 InstructionComposer 的功能重叠（遗留组件收敛）属批次⑤。

## 复跑

```bash
pnpm check   # Q0+Q1 全量（1269 用例，含本批 7 条新增）
```
