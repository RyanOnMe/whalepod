# 连接与会话可视性（前端交互批次②）验收

- 对应场景/门禁：Q1（unit + web project）
- 对应 Issue：#227
- 上次验证：2026-09-30 · `feat/p1-227-connection-visibility` · 结果 PASS

## 验的是哪条用户路径

两段「系统状态变化时用户被蒙在鼓里」的路径：

1. 使用中网络/Hub WS 断开——页面继续显示静默旧数据，用户拿旧数据做决定；
   恢复后漏掉的持久事件（control 帧之外的常规事件流）无人补拉。
2. 会话中途过期——页面内每个按钮持续报「请重新登录」，但用户只能手动
   点 ErrorBanner 里的链接，停在原页反复撞墙。

## 修复内容

| # | 修复 | 落点 |
|---|---|---|
| 1 | TeamEventSocket 上报连接状态（connecting/open/reconnecting；手动 close 不报） | `socket.ts` 的 `onStatusChange`，上报点在 `scheduleReconnect` 守卫内 |
| 2 | 断线横幅：仅 reconnecting 时出现「连接已断开，正在重连…显示的可能不是最新数据」（role=status，amber 警示档） | `ConnectionBanner` + 模块级 `connection-store`（useSyncExternalStore） |
| 3 | 重连成功 → `invalidateQueries()` 全量补拉（断线窗口漏事件兜底） | `RealtimeBridge` 的 onStatusChange（reconnecting→open 转换时） |
| 4 | 会话过期自动跳转：QueryCache/MutationCache onError 发事件 → AppShell 跳 `/login?from=` + flash「登录已过期」+ 清 session 缓存 | `session-expiry.ts` 事件 + `query-client.ts` + `session.tsx` |
| 5 | 登录成功回跳原路径；from 只认站内路径（`//`、`https://` 拒收回落 `/`） | `LoginPage` 的 `safeRedirectFrom`；登录页挂 FlashBanner |

### 实现中抓住的死循环（重要）

第一版「订阅 → navigate」实现会**无限循环**（测试即 OOM 抓获）：login loader 的
`fetchQuery(session)` 失败同样走 QueryCache.onError → 再发事件 → 订阅者再
navigate/removeQueries → loader 再 fetch……loader revalidation 期间旧 UI 仍挂载，
订阅一直活着。修法：**订阅回调先退订自身再 navigate**（一次性跳转）。这条是
生产级隐患，由 spec 的 OOM 现象暴露——不是测试假阳性。

### 取舍说明

Issue 原文提到接 vendored `ConnectionIndicator`：实测其 API 是「带手动重连按钮
的恢复控件」（8 个 label + 两个 action），本批只需要被动状态呈现——不为了
「用上 vendored」而硬接，横幅自写（token/对比度走既有档）。将来做「手动重连」
入口时再评估。

## 驱动（怎么触发）

```bash
pnpm exec vitest run --project unit apps/web/tests/socket.spec.ts --project web apps/web/tests/connection-banner.spec.tsx apps/web/tests/session-expiry.spec.tsx
```

## 判定（可证伪断言）

- 状态序列（FakeWebSocket）：connecting → open →（断线）reconnecting →（退避后）open；
  手动 close 序列止于 open。
- 横幅：reconnecting 出现且含「不是最新」；open/connecting 均 null。
- 补拉：open→reconnecting→open 后 task-room GET 计数递增；无断线的 open 不触发。
- 过期跳转：query 401 → 登录按钮出现 + 「登录已过期」可见；登录后回原任务页
  （不是首页）。
- 防开放重定向：`safeRedirectFrom('//evil.com'|'https://…'|null) === '/'`。

## 归因

- 跳转不发生 → cache onError 是否触发（events 层）、AppShell 订阅是否先退订。
- 跳转后弹回首页 → session 缓存未清（login loader 误判已登录）。
- 测试 OOM → 订阅/导航循环（见上）。

## 边界与未覆盖

- 真实浏览器断网/恢复的 e2e（Q5）未跑（本地 Docker 不可用），横幅视觉与
  WS 真重连路径待 Q5 全量补。
- 断线期间 fetch 也失败的场景（全断网）：fetch 层已有「无法连接服务器」
  ErrorBanner，横幅与其并存不冲突（未做视觉叠加验证）。
- ConnectionIndicator（vendored）仍未接线（见取舍）。

## 复跑

```bash
pnpm check   # Q0+Q1 全量（1284 用例，含本批 8 条新增）
```
