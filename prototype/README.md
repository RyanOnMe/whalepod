# WhalePod HTML 产品原型

这个原型用同一组 Team、Task、Agent、Run、Approval 和 Artifact 数据，对比三种完全不同的产品结构。默认方向是 **A — Task Room**：WhalePod 拥有团队协作外壳，DSH Run Console 作为任务中的第二层运行界面。

## 打开

最简单的方式是双击 [index.html](./index.html)。原型没有外部依赖，离线也能使用。

如果浏览器限制本地文件交互，可在本目录运行：

```bash
python3 -m http.server 4173 --bind 127.0.0.1
```

然后打开：

- `http://127.0.0.1:4173/?variant=A` — Task Room，推荐方向
- `http://127.0.0.1:4173/?variant=B` — Mission Control，跨任务分诊方向
- `http://127.0.0.1:4173/?variant=C` — Harness First，最接近直接继承 DSH Web

页面底部切换器和键盘 `←` / `→` 可以循环切换，URL 会同步更新。

## 建议体验路径

1. 从 A 开始，先判断是否能快速看出谁负责、卡在哪里、当前交付物是什么。
2. 点击 `打开 Run Console`，查看 DSH 的 Turn、Tool 和 Plugin Pack 如何进入 Task Room。
3. 允许或拒绝待处理审批；预览并发布 `security-review.md`。
4. 在底部切换到 B，比较跨 Task 扫描效率。
5. 切换到 C，体会直接把 DSH Session 作为首页时获得和失去的东西。

所有按钮都只修改内存中的演示状态；刷新页面即可恢复初始数据。

## 评审问题

- A 是否应该成为正式产品主结构？
- B 的任务表、运行摘要或泳道是否值得合入 A？
- C 的 Run Canvas、Plugin Inspector 哪些部分应该进入 A 的 Run Console？
- 审批与 Artifact 是否足够突出，又没有压过团队讨论？
- 3–10 人团队是否能在十秒内理解当前责任链？

## 产品结论

WhalePod 可以直接组合 DSH Runtime 和插件生态，但不应直接 Fork 整个 DSH Web：

```text
WhalePod Team / Project / Task Room
               ↓
       WhalePod Run Console
               ↓
DSH Agent / Session / Tool / Plugin Runtime
```

详细依据见 [DESIGN.md](./DESIGN.md)，逐步实现计划见 [IMPLEMENTATION-PLAN.md](./IMPLEMENTATION-PLAN.md)。

## 原型边界

- 没有后端、认证、实时连接或真实 DSH Runtime。
- 没有写入磁盘或调用系统命令。
- 不代表正式组件库或生产代码；选定方向后应重写获胜方案。
- 演示中的 Workspace 路径、凭据和工具参数都经过虚构与脱敏。

## 验证记录

验证日期：2026-08-16。使用本地静态服务器和真实浏览器完成以下检查：

- 静态检查：`node --check prototype.js` 通过；A、B、C 三个 URL 均返回 HTTP 200。
- 1440×900：三个变体均无页面级横向滚动；A 展示 Task Room，B 展示 4 行任务和 3 条泳道，C 展示 5 个 Session 与 5 个 Runtime 插件。
- 1024×768：三个变体均无页面级横向滚动；每页恰有一个 `h1`，没有无名称按钮、无标签文本框或重复 ID。
- 390×844：三个变体均无页面级横向滚动；A 折叠 Project 导航，B 将任务表和泳道转为单列，C 隐藏 Inspector 并保留 Run 与 Composer。
- 原型切换：底部按钮与键盘左右键均更新 `?variant=`；文本框获得焦点时不会误切换。
- Run Console：可打开、切换“活动 / 工具 / 插件”页签；`Escape` 与关闭按钮都能关闭，焦点返回原触发按钮。
- 协作闭环：审批允许、Artifact 预览与发布、Task Room 评论均能在本地演示状态中完成；浏览器控制台无错误。

截图：

- [A — Task Room](./screenshots/variant-a.jpg)
- [B — Mission Control](./screenshots/variant-b.jpg)
- [C — Harness First](./screenshots/variant-c.jpg)
- [A — 390px 窄屏](./screenshots/variant-a-mobile.jpg)
- [Run Console](./screenshots/run-console.jpg)

这是产品方向原型，不是正式无障碍认证；尚未运行 axe 或 Lighthouse，也没有接入后端、真实 DSH Runtime 和多人实时状态。
