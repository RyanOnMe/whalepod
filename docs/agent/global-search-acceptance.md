# ⌘K 全局搜索验收（P1-UX-11 / #254，父账 #243 第 5 条刀二）

## 这条切片改变什么

找旧任务此前只能靠项目树翻找，「那个叫什么来着」没有解法。本切片：任意已登录页
⌘K/Ctrl+K 呼出搜索浮层（侧栏「搜索」钮是鼠标路径——快捷键不是唯一入口），输入即查
任务标题（300ms 防抖），↑↓ 选中、Enter/点击直达任务房。对照 ChatGPT 的 ⌘K（一处输入、
纯键盘可走，#243 取证确认）。**至此 #243 第 5 条两刀齐**：最近任务（刀一）+ 搜索（刀二）。

## 数据面

`GET /tasks/search?q=`（Member）：title ILIKE 不区分大小写；**%/_/\\ 先转义再 `escape '\'`**
（用户输入不当通配符，集成用例专门验了 `100%` 按字面匹配、`100%完成` 不命中）；关键词走
drizzle 参数绑定（`O'Brien'` 不炸）。≤8 条，形状复用刀一的 `RecentTaskView`（含 projectName
与 lastActiveAt），按最近活动排序——搜索与最近是同一张卡片的两种取数。空 q/全空白 → 400
（`VALIDATION_FAILED`）：搜索必须有关键词，静默全量等于把「搜索」降级成「列表」。

## UI 契约

- 浮层走 vendored Modal headless（ConfirmDialog 同款）：aria-modal、Tab 留框内、Esc 关闭
  **并还焦触发元素**（按钮触发还按钮，⌘K 触发还打开前的焦点）。
- 结果项 `role="option"` + aria-selected（listbox 语义）；↑↓ 循环移动，Enter 直达当前选中。
- 状态五分支诚实呈现：空关键词（提示，**不发请求**）/ 搜索中 / 失败（role=alert）/ 无结果 /
  结果列表。空关键词不查是判据（fetch 计数）。
- ⌘K preventDefault 接管浏览器地址栏搜索（ChatGPT/Linear 同款行为）。

## 驱动与判定

- **Q2 集成**（`apps/hub/tests/task-search.integration.spec.ts`，CI 验）：大小写不敏感、
  不匹配不回、projectName 在；上限 8；空 q/全空白 400；特殊字符（单引号/百分号）参数化
  与字面匹配。
- **Q1 web**（`apps/web/tests/global-search.spec.tsx`，5 例）：⌘K 呼出+输入出结果+点击直达；
  侧栏钮同开；Esc 关闭还焦；无结果如实+空关键词不发请求；键盘路径（↓+Enter 直达第二项）。
- **Q0**：`pnpm check` 全绿（109 文件 1360 过 / 7 预期失败为既有深色 it.fails 债）。

## 踩坑记录（写下来省下一次半小时）

1. **mock 的 `respond` 只拿得到 `RequestInit`（拿不到 URL）**——想在 respond 里按 q 过滤
   结果是拿不到 q 的，`new URL((init as Request).url)` 是 undefined 直接炸成「无法连接服务
   器」。web 面的 handler 无条件返回结果集（按 q 过滤是 Hub 的事，Q2 验）。
2. **结果项挂 `role="option"` 后不再是 button**——测试查询要用 `role: 'option'`。
3. 文案带句号（「没有匹配的任务。」）时 text matcher 用正则，别精确匹配。

## 边界与债

- 只搜任务标题，不搜消息正文/交付物内容——正文检索要考虑索引与受众，属新数据面；
  项目名不搜（项目少，侧栏+最近区覆盖）。
- 搜索结果与最近任务的缓存互不失效（搜索是短时查询，staleTime 由 react-query 默认）。
- 窄屏浮层可用（min(520px, 90vw)），侧栏搜索钮只在宽屏侧栏（窄屏走 ⌘K；折叠菜单加搜索
  钮属 Q5 面后续）。
- Q5 e2e 挂 #243 总账既有债。
