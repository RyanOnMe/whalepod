# WhalePod HTML 产品原型 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 制作一个离线可打开、包含三种结构性界面方向的 WhalePod 可交互 HTML 原型，用于判断 Task Room 与 DSH Run Console 的正确产品关系。

**Architecture:** 原型是桌面方案目录中的独立静态站点，不依赖主仓工作树或任何后端（原型早于 #133 定名，见 prototype/README）。`index.html` 提供语义化入口，`styles.css` 定义三套互相独立的布局语言，`prototype.js` 保存统一演示数据、渲染三个变体并管理本地交互；URL 查询参数是变体状态的唯一持久来源。

**Tech Stack:** HTML5、CSS Custom Properties、原生 JavaScript、原生 `<dialog>`、本地静态 HTTP 服务器与浏览器点验。

## Global Constraints

- 原型固定为三个变体：`A` Task Room、`B` Mission Control、`C` Harness First。
- 默认变体必须是 `A`；变体通过 `?variant=A|B|C` 切换并刷新稳定。
- 不加载网络字体、CDN、远程图片、第三方 JavaScript 或生产数据。
- 所有产品状态使用同一组 fixture；任何审批、发布和评论都是明确标记的本地演示状态。
- WCAG 2.1 AA 为基线：语义化元素、键盘可达、可见焦点、Dialog 焦点归还、减少动态效果。
- 本目录是 Git 仓库之外的评审产物，不创建分支或提交；用校验命令和截图代替提交门。
- 不读取或修改 `/Users/rysir/PycharmProjects/WhalePod` 中的现有业务文件。

---

## File Map

| 文件 | 单一职责 |
|---|---|
| `DESIGN.md` | 已批准的产品模型、DSH 继承边界、三变体设计依据 |
| `IMPLEMENTATION-PLAN.md` | 可逐项执行与验收的实现计划 |
| `README.md` | 打开方式、变体 URL、交互说明和评审问题 |
| `index.html` | 静态入口、可访问性跳转链接、应用挂载点、Dialog 容器 |
| `styles.css` | 设计 Token、三套独立布局、响应式和无障碍样式 |
| `prototype.js` | fixture、三个渲染函数、URL 切换器、Dialog 与本地演示状态 |

### Task 1: 建立可离线打开的原型外壳

**Files:**
- Create: `index.html`
- Create: `README.md`

**Interfaces:**
- Consumes: 浏览器原生 DOM。
- Produces: `#prototype-root` 渲染挂载点、`#prototype-dialog` 模态容器、`styles.css` 与 `prototype.js` 引用。

- [x] **Step 1: 写入语义化 HTML 外壳**

入口至少包含以下稳定接口：

```html
<a class="skip-link" href="#prototype-root">跳到主要内容</a>
<main id="prototype-root" tabindex="-1" aria-live="polite"></main>
<dialog id="prototype-dialog" aria-labelledby="dialog-title"></dialog>
<script src="prototype.js" defer></script>
```

- [x] **Step 2: 写入 README 打开方式**

README 必须说明双击 `index.html`，或在目录运行：

```bash
python3 -m http.server 4173
```

并列出 `?variant=A`、`?variant=B`、`?variant=C`。

- [x] **Step 3: 验证静态引用存在**

Run:

```bash
rg -n 'prototype-root|prototype-dialog|styles.css|prototype.js' index.html
```

Expected: 四个接口全部命中。

### Task 2: 定义统一数据和变体路由

**Files:**
- Create: `prototype.js`

**Interfaces:**
- Consumes: `#prototype-root`、`#prototype-dialog`、`window.location.search`。
- Produces: `renderVariant(key)`、`setVariant(key)`、`openRunConsole(runId, trigger)`、`openArtifact(artifactId, trigger)`。

- [x] **Step 1: 定义唯一 fixture 与本地 UI 状态**

fixture 必须包含 Team、Project、Task、成员、Builder/Reviewer、Run #18、一个待审批项、一个未发布 Artifact 和活动事件；三个变体只读取这一份数据。

- [x] **Step 2: 实现 URL 驱动的变体状态**

`getVariant()` 只接受 `A | B | C`，无效值回退到 `A`；`setVariant()` 使用 `history.replaceState()` 更新查询参数并重新渲染。

- [x] **Step 3: 实现共享本地交互**

实现审批决定、Artifact 发布、评论追加、Run Console 与 Artifact Dialog。关闭 Dialog 时必须调用此前保存的触发按钮 `.focus()`。

- [x] **Step 4: 实现键盘切换**

左右方向键循环切换变体；焦点位于 `input`、`textarea`、`select` 或 `[contenteditable]` 时不拦截。

- [x] **Step 5: 做 JavaScript 语法检查**

Run:

```bash
node --check prototype.js
```

Expected: exit code 0。

### Task 3: 实现 A — Task Room

**Files:**
- Create: `styles.css`
- Modify: `prototype.js`

**Interfaces:**
- Consumes: 统一 fixture 与共享交互函数。
- Produces: `renderTaskRoom()` 返回完整的三栏 Task Room DOM 字符串。

- [x] **Step 1: 实现产品外壳和左侧 Project/Task 导航**

左侧必须让用户看见 Team、Project、Task 状态和未读/阻塞数量，但不得展示绝对 Workspace 路径。

- [x] **Step 2: 实现中央任务叙事**

顶部显示目标、责任人、截止时间和参与 Agent；正文按时间组织真人评论、Agent Run、Approval 与 Artifact，而不是聊天气泡堆叠。

- [x] **Step 3: 实现右侧“现在需要关注”**

待 Bob 处理的 Approval 必须是视觉第一优先级；Artifact 和 Reviewer 后续动作紧随其后。

- [x] **Step 4: 实现响应式折叠**

在宽度小于 1100px 时右栏进入正文；小于 760px 时左侧导航变成顶部紧凑栏，正文保持单列。

### Task 4: 实现 B — Mission Control

**Files:**
- Modify: `styles.css`
- Modify: `prototype.js`

**Interfaces:**
- Consumes: 统一 fixture 与共享交互函数。
- Produces: `renderMissionControl()` 返回顶部导航、任务队列、泳道和选中 Task 明细。

- [x] **Step 1: 实现横向 Team 导航与运行摘要**

首屏用数字和状态词回答运行中、待审批、今日截止、Device 在线数。

- [x] **Step 2: 实现紧凑任务表而非卡片墙**

表格列至少包含 Task、责任人、Agent、阶段、阻塞和更新时间；`TT-24` 为当前行。

- [x] **Step 3: 实现三条工作泳道**

“需要人”“Agent 运行中”“等待交付”必须形成横向操作队列，并能打开对应 Run 或 Artifact。

- [x] **Step 4: 实现窄屏顺序**

小于 800px 时摘要横向滚动但页面不溢出，任务表切为带字段标签的列表，泳道纵向排列。

### Task 5: 实现 C — Harness First

**Files:**
- Modify: `styles.css`
- Modify: `prototype.js`

**Interfaces:**
- Consumes: 统一 fixture 与共享交互函数。
- Produces: `renderHarnessFirst()` 返回 Session 栏、Run Canvas 和 Runtime Inspector。

- [x] **Step 1: 实现 DSH 风格 Session 导航**

左侧以 Run/Session 为主对象，并在次要位置标记所属 Task，故意体现 DSH-first 的产品取舍。

- [x] **Step 2: 实现 Turn/Step/Tool 运行画布**

中央按 Turn → Step → Tool 展示 Agent 执行；输入框提供“继续指令”本地演示，不产生网络请求。

- [x] **Step 3: 实现插件与执行环境检查器**

右侧显示 Profile、Plugin Pack、Tool、Skill、MCP、Token、Workspace 所有者和脱敏路径；不得出现真实凭据或绝对路径。

- [x] **Step 4: 明示协作退居次位的风险**

顶部 Task context 只占一条窄横幅，并提供“返回 Task Room”按钮，让评审者直接比较 C 与 A。

### Task 6: 实现切换器、Dialog 与产品级细节

**Files:**
- Modify: `styles.css`
- Modify: `prototype.js`

**Interfaces:**
- Consumes: 三个渲染函数。
- Produces: `PrototypeSwitcher`、Run Console Dialog、Artifact Dialog、toast live region。

- [x] **Step 1: 实现底部浮动切换器**

包含上一项、当前键与名称、下一项；按钮均有 `aria-label`，当前变体按钮使用 `aria-current="true"`。

- [x] **Step 2: 实现 Run Console**

Dialog 中分“活动 / 工具 / 插件”三个页签，展示 DSH Session 投影与隐私说明；页签使用原生按钮和 `aria-selected`。

- [x] **Step 3: 实现 Artifact 预览和本地反馈**

预览包含文件名、SHA-256 摘要、Builder 来源和 Markdown 正文；发布或审批后在 `role="status"` 区域播报结果。

- [x] **Step 4: 实现动效降级与焦点样式**

`prefers-reduced-motion: reduce` 时禁用非必要动画；所有按钮、链接、输入框使用清晰的 `:focus-visible` 轮廓。

### Task 7: 机器检查与真实浏览器验收

**Files:**
- Modify: `README.md`（记录最终验证结果）

**Interfaces:**
- Consumes: 完整静态原型。
- Produces: 可复现的校验命令、桌面/窄屏截图和验收记录。

- [x] **Step 1: 运行静态检查**

Run:

```bash
node --check prototype.js
rg -n 'variant=A|variant=B|variant=C|prefers-reduced-motion|focus-visible|<dialog' README.md styles.css index.html
```

Expected: JavaScript exit code 0；每项约束至少命中一次。

- [x] **Step 2: 启动本地静态服务器**

Run:

```bash
python3 -m http.server 4173 --bind 127.0.0.1
```

Expected: `http://127.0.0.1:4173/?variant=A` 返回 200。

- [x] **Step 3: 浏览器验收三个变体**

分别打开 A、B、C，确认 URL、标题、结构和主动作不同；使用按钮与左右方向键切换，刷新后保持当前变体。

- [x] **Step 4: 验收关键交互**

在 A 中打开 Run Console、切换页签、关闭；处理审批；打开 Artifact、发布；发送评论。确认 Dialog 关闭后焦点返回触发按钮。

- [x] **Step 5: 验收窄屏和横向溢出**

在 390×844 下检查 A/B/C；执行 `document.documentElement.scrollWidth <= window.innerWidth`，三者都必须为 `true`。

- [x] **Step 6: 记录完成证据**

README 记录校验日期、测试视口、通过项和原型局限；截图按浏览器实际返回的 JPEG 编码保存为 `screenshots/variant-a.jpg`、`variant-b.jpg`、`variant-c.jpg` 与 `variant-a-mobile.jpg`。

## Self-Review

- Spec coverage：Task Room、Mission Control、Harness First、DSH 继承边界、统一 fixture、URL 切换、Dialog、审批、Artifact、响应式与键盘验收均有对应任务。
- Placeholder scan：计划不包含未完成占位词、“照前一步处理”或未定义接口。
- Interface consistency：三个渲染函数均由 `renderVariant(key)` 调用；共享交互函数只依赖统一 fixture 和本地 UI state；HTML ID 与 JavaScript 输入一致。
- Scope check：这是一个独立静态原型，不拆成后端、正式组件库或 DSH 插件实现；这些属于原型评审后的下一阶段。
