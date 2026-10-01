# 运行时长（时间感）验收（P1-UX-8 / #248，父账 #243 第 4 条）

## 这条切片改变什么

运行卡此前只有状态没有时长：长 Run（分钟到小时级）跑着，快了还是卡了全靠猜。本切片给运行卡
meta 加「时长」行——终态显固定总时长，活跃显已耗时（30s 自跳），对照 ChatGPT Work 台每轮
「用时 21分9秒」的预期管理口径（#243 取证）。纯前端，协议零改动（startedAt/finishedAt 已在
Run 投影）。

## 三种事实三种话（诚实性优先）

- **终态**：固定总时长 = `finishedAt − startedAt`，与 now 无关；
- **活跃且已开始**：已耗时 = `now − startedAt`，`useDurationTick` 每 30s 重算（只有存在
  活跃已开始的 Run 才挂 interval，空闲房间零定时器，卸载即清）；
- **未开始 / 数据不完整**（无 startedAt，或终态缺 finishedAt）：`runDurationText` 返回
  null，**不画时长行**——没有时间事实就不假装。

格式四档（`formatDuration` 纯函数，独立单测）：秒 / 分秒（21分9秒）/ 小时分 / 天小时。

## 驱动与判定

- **Q1 unit**（`run-duration.spec.ts`，8 例）：四档格式、零与负值钳 0秒、终态固定值、
  活跃随 now、未开始 null、终态缺 finishedAt null。
- **Q1 web 页面级**（`task-room.spec.tsx`）：三种 Run 同屏——活跃 2小时59分、终态
  21分9秒、未开始不画行。挂钟用 `vi.useFakeTimers({ toFake: ['Date'] })` 钉死：
  **只 fake Date**，waitFor 的轮询定时器保持真实（fake 全套会把 testing-library 的
  异步查询一起冻死，5s 超时——踩过才写进这里）。
- **Q0**：`pnpm check` 全绿（106 文件 1343 过 / 7 预期失败为既有深色 it.fails 债）。

## 设计取舍记录

- 30s 粒度与「分钟级预期管理」的用途匹配，不做秒级跳动（视觉噪声）。
- `useDurationTick` 放在 RunTimeline 空态早退**之前**——Hooks 数不能随 runs 0→N 变
  （TaskRoomPage 同款纪律，注释互指）。
- 不做平均/历史统计（那是另一个问题）；RunLivePanel/Console 不动。

## 边界与债

- 已耗时的「now」是浏览器挂钟，与服务端时钟可能有偏差——用途是预期管理不是计费，
  分钟级误差可接受（RelativeTime 同口径）。
- Q5 e2e 挂 #243 总账既有债。
