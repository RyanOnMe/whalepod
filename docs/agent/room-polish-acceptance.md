# 信息真空与打磨（前端交互批次④）验收

- 对应场景/门禁：Q1（unit + web project）
- 对应 Issue：#231
- 上次验证：2026-09-30 · `feat/p1-231-activity-hint-polish` · 结果 PASS

## 验的是哪条用户路径

1. 只盯左栏「讨论」的用户，执行区来了新指令/新运行时要被温和地告知（ADR-0010
   决策 6 登记的信息真空债：分栏的代价，先按不加实施，发现真空再立项——
   切片⑥ 全量落地后该真空已实际存在）。
2. 打开任务房间/项目页时，加载态预告布局（骨架）而不是一行跳变的文本。
3. 空态指路文案不说方位（布局响应式变化后「上方」会说谎，#167 登记）。

## 交付内容

| # | 交付 | 落点 |
|---|---|---|
| 1 | 执行活动提示：活动数（指令+运行）超过已看值时讨论栏顶部出现「执行区有新活动——点开看看」；点击即消并把焦点送到执行栏标题（h2 tabIndex=-1）。首屏数据是基线不算新 | `TaskRoomPage.tsx`（`seenActivity` 基线 effect） |
| 2 | 加载骨架：任务房间（两栏各 4 条）与项目页（列表 3 条）的 pending 态渲染 `.skeleton-line`（容器 `aria-busy=true`）；`prefers-reduced-motion` 下动画关闭 | `TaskRoomPage` / `ProjectsPage` + `global.css` |
| 3 | 方位词清理：「用上方『启动 Run』」→「在执行区说一句指令（或用『启动 Run』）」；「先点上方『生成配对码』」→「先点『生成配对码』」 | `RunTimeline.tsx` / `DevicesPage.tsx` |

## 实现注意（下一个人会踩的）

- `seenActivity` 的 useState/useEffect 必须放在组件顶部：pending/error 的早退
  return 在前时 Hooks 数不一致，React 直接崩（第一版就这样，用例以「页面加载失败」
  抓获）。activityCount 因此从 `query.data?.…` 计算（pending 时为 0），基线只在
  `query.isSuccess` 时记录。

## 驱动（怎么触发）

```bash
pnpm exec vitest run --project web apps/web/tests/room-polish.spec.tsx
```

## 判定（可证伪断言）

- 指令 1→2（refetch 后）：提示出现、含「执行区有新活动」；点击后消失且
  `document.activeElement.id === 'instructions-heading'`；首屏不提示。
- 运行数 1→2 同样触发（指令未变）。
- pending：`room-skeleton` 存在、`aria-busy=true`、骨架行 ≥4；空态文案不出现
  （task-room.spec 的「加载态不伪装成空数据」判据同步迁移到骨架形态）。
- reduced-motion：CSS 源码断言 `.skeleton-line` 有动画且 media 查询内 `animation: none`。
- 全页文本不再含「上方」。

## 边界与未覆盖

- 「新活动」以数量为判据：同数替换（一条被拒、一条新增）不触发——可接受，
  提示的语义是「有动静」而不是 diff 明细。
- 提示条视觉的对比度沿用 warn 档混合底（与断线横幅同族），未单挂对比度门。
- 骨架的断点分布（两栏/单栏）未做响应式断言（jsdom 无布局）。

## 复跑

```bash
pnpm check   # Q0+Q1 全量（1297 用例，含本批 5 条新增 + 1 条判据迁移）
```
