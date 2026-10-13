# Task Room Micro 第二批验收（提示层 / 完成提醒开关 / 可关闭 toast）

- 场景/门禁：G4 运行投影、G5-01 审批观察与批准、执行区指令与交付物；Q0、Q5、许可与敏感扫描。
- Issue：P1-308；WarmTooltip、BellToggle、SwipeToast 三个组件的应用内适配，与第一批（#306：CallChip / StatusMark / ThoughtLine / RubberSegment）共用同一条 Q5 冷启链。
- 实施方式：固定 revision `d86fccbd477786f94ca7eb891fbe0ec039d3cd3b` 的应用内源码适配，保留上游 MIT + Commons Clause；逐文件原始哈希与本地改写见 [vendor README](../../apps/web/src/vendor/react-bits-micro/README.md) 与 manifest.json，根 NOTICE 登记同一例外。

## 用户路径与驱动

沿用第一批的真实双人冷启链（一次性 PostgreSQL、包解析后的 Hub 生产产物、既有 Node 生产监督器、真实 Runtime bin 与 DSH replay）。本批新增三段路径：

1. **完成提醒开关**：Alice 在**没有**通知权限时点一次铃铛——headless Chromium 拒绝授权，开关必须保持「已关」、不响铃、不写偏好，并给出只读说明；随后授予通知权限并重载，再点一次才是真的开（响铃计数 +1、偏好写入 localStorage）。
2. **提示层**：鼠标悬停在运行列表项上——提示要**先等**（冷启动），出现后内容是完整 Run id，`aria-describedby` 指向真实存在的 `role=tooltip`；指针移开后提示与描述都要撤掉。键盘路径：焦点到了立即显示（不等待），`Escape` 关闭并撤掉描述。
3. **可关闭 toast**：在 fetch 边界给交付物内容接口注入 500（页面走它自己的失败分支，触发条件与 #229 登记的「下载失败是短暂挫折」完全一致）——toast 出现后量三件事：fuse 时长等于卡片真实窗口、悬停时 fuse 的 `animation-play-state` 变成 `paused`、关闭按钮点掉之后不再回来。

```bash
pnpm check
pnpm test:e2e:micro
pnpm test:licenses
scripts/secret-scan.sh apps/web/src/vendor/react-bits-micro
```

## 观测与判定

| 层 | 观测 | 必须通过的判据 |
|---|---|---|
| web.hint | 提示层的存在性、文本、`aria-describedby`、等待时长 | 冷启动实测等待 ≥300ms（下界，不是上界）；鼠标移开即关；焦点即显；Escape 关闭；描述只在可见时挂，且指向真实 `role=tooltip` 元素 |
| web.bell | 开关的 `data-on` / `data-ring` / 只读说明、localStorage 偏好 | 未授权点击**不**进入已开、**不**响铃、**不**写偏好，改出只读说明；授权后点击才开且 `data-ring` 从 0 到 1；偏好值为 `on` |
| web.toast | `.toast-item` 的 fuse 变量与 `animation-play-state`、关闭按钮 | fuse 时长 = 3840ms（= 4s 全额 − 退场 160ms）；悬停时 fuse 与计时一起暂停；关闭后 4.2s 内不再出现 |
| web.bell / web.toast（减少动态） | 浏览器实际加载的 reduced-motion 规则 | `.bell-toggle__glyph` 与 `.toast-item__fuse` 的 `animation: none` 规则被浏览器真的加载（删规则即红） |
| 复用第一批 | hub.run-projection / web.activity / web.console / web.instruction | 不变（同一份场景与判据继续跑） |

单元面（`apps/web/tests/`，先红后绿）：

- `micro-hint.spec.tsx`：冷启动等待、warm 窗口内相邻目标即时、超窗回到冷启动、焦点即显、Escape、`aria-describedby` 指向真实元素、文案只来自静态标签、样式契约（含减少动态块）。
- `run-notifications.spec.tsx`（追加）：未授权不响铃、授权后响一次并写偏好、再点关闭不响、被拒不写偏好且只剩只读说明、徽标 = 真实未读数且进房归零、响铃动画挂在「已响过」条件上且减少动态关闭。
- `toast-dismiss.spec.tsx`：fuse 只显示真实剩余时长且不占用播报通道、悬停/聚焦暂停并按剩余时间继续、关闭按钮、Escape、下滑关闭与位移不足回位、样式契约。
- `micro-vendoring.spec.ts`：14 个 vendor 文件清单、原始哈希格式、上游路径、改写说明、NOTICE 条款。

## 交互取舍复核

| Before | After | Why |
|---|---|---|
| 运行列表项只显示序号，完整 Run id 只在原生 `title` 里 | 提示层显示完整 Run id，键盘焦点也能读 | 原生 `title` 只有鼠标一条路；排障时要拿 id 对日志，键盘用户此前拿不到 |
| 泛化「复制」按钮只有 `aria-label` 说得清复制什么 | 同一句说法出现在可见提示里 | 鼠标用户此前看不到区别；提示只在「可见文案够不着真目标」的可聚焦控件上用 |
| 「完成提醒」是 `aria-pressed` 文本按钮 | 铃铛开关：图形槽 + 交叉淡入文案 + 真实未读徽标 | 开关的形状要说清它是开关；未读数与开关此前不在同一处 |
| 开启完成提醒没有任何确认反馈 | 只有真实授权且启用后才响一次铃 | 图形是授权结果的事件回执，不是装饰；拒绝路径保持只读 |
| toast 4 秒自动消退、无法关闭、不显示剩余时间 | fuse 显示真实剩余，悬停/聚焦/页面隐藏暂停，滑动/Escape/关闭按钮三条真实关闭路径 | 读的时候不会被摘掉；「会自己消失」与「常驻错误」此前无法区分 |

## 本轮明确不取的组件与理由

上游 Micro 目录共 34 个组件（固定 revision 下的 `src/ts-default/Micro`）。逐项核对后本批排除：

| 组件 | 不取的理由 |
|---|---|
| Prompt Bar | 自带模型 / effort / 语音 / 附件选择，会承诺 WhalePod 没有实现的能力（第一批已定案） |
| Slide Commit / Hold Button | 审批与提交必须精确，不用手势确认（第一批已定案） |
| Sling Button | 发送路径已按事实改编（固定图标槽 + 四种 outcome），换成「拉弓发射」既不增加信息，又会暗示成功 |
| Squish Switch | 应用里唯一的真开关就是完成提醒，已由 Bell Toggle 承载；其余「开关感」控件其实是按钮（导航/选中） |
| Lattice Loader | 会变成同屏第二套活动词汇：运行中的活动已由 StatusMark 状态环与 ThoughtLine 表达，仓库明确避免重复活动动效 |
| Spring Check | 唯一 checkbox 在插件组合页，且上游带划线删除——划线在第一批已被否决（完成不等于划掉标题） |
| Glide Select | 下拉菜单是 vendored `dsh-ui` 的 Menu，菜单高亮动效在它内部；改它属于 dsh-ui 的范围，不属于本目录的适配 |
| Fuse Button | 「带撤销的燃烧引信」需要一个真实存在的撤销窗口，应用里没有时间窗撤销（唯一的撤销是权限授予的 DELETE） |
| Swipe Row | 列表行没有行内动作（运行项整行是按钮、Console 明确只读），加上滑动删除会引入破坏性手势 |
| Code Slots | 需要一次性验证码**输入**；设备配对码在本应用里只展示不输入 |
| Refine Frame | 需要按阶段推进的媒体帧；交付物没有「生成中」的中间态 |
| Comet Dial / Slosh Gauge / Wake Slider / Scrub Field | 没有对应的真实量值（表盘/液位/滑块），做成装饰即为假信息 |
| Shredder / Paper Crumple / Tear Ticket / Flip Card / Folder Float / Branched Menu / Voice Pill / Pulse Heart / Peek Rating / Jelly Radio / Dodge Field | 装饰性或与协作工作流无关；Matter 式拟物破坏动效不进入状态呈现 |

## 验证结果与取证

- TDD：先写会红的判据（`micro-hint.spec.tsx` 模块不存在、`data-testid="toast-item"` 未挂、铃铛没有 `data-ring`），实现后转绿；`micro-vendoring` 门在补 manifest 前红（文件清单 14 条），补后绿——期间它真抓到一次抄错的原始哈希（62 位）。
- Q0：`pnpm check` PASS——126 文件、1484 条通过、7 条既有 expected-fail（第一批 1466 条 → 本批 +18）。含格式、lint、类型、边界、生成与插件 fixture。
- Q5：`pnpm test:e2e:micro` PASS（场景 15.2s / 含构建冷启 33.0s，1 worker）。本批新增实测：提示层鼠标等待 846ms（冷启动下界 ≥300ms 通过）且移开即关、键盘焦点即显、Escape 关闭并撤掉描述；铃铛未授权点击后保持关闭且只剩只读说明、授权后 `data-on` 真且 `data-ring` 0→1、偏好落 `whalepod.notifications.system=on`；toast fuse 实测 `3840ms`、悬停时 `animation-play-state: paused`、关闭按钮点掉后 4.2s 内不再出现。`pageErrors` 为空。
- 减少动态：浏览器实际加载的规则里 `.bell-toggle__glyph` 与 `.toast-item__fuse` 都是 `animation: none`（`bellRingSuppressed` / `fuseSuppressed` 均 true，删规则即红）。
- 布局与主题：1280 / 390 / 320px 在浅色与强制深色 token 下 `documentWidth` 等于视口、无横向溢出（复用第一批判据，成功 chip 对比度 10.98:1）。本批新增一条**锚点盒子**证据：设备页「复制配对码」按钮与它外面的提示锚点尺寸逐项相等（62×40，左边界 317 一致，`batch2.hintAnchor.boxUnchanged`）——提示层包在按钮外面，必须证明它没有改变按钮自己的盒子；运行列表项的 block 锚点由既有的 320/390 溢出判据覆盖。
- `pnpm test:licenses` 626 包通过（**无新增依赖、未改 catalog/lockfile**）；`scripts/secret-scan.sh` 对 vendor 目录、`shared/micro` 与 web 测试面均未命中。

本次证据目录：`artifacts/evidence/run-micro/b446d729/`。`result.json` 新增 `batch2` 段（按 web.hint / web.bell / web.toast 分层）与 `reducedMotion.bellRingSuppressed`、`reducedMotion.fuseSuppressed`；toast 的触发方式记在 `batch2.toast.trigger = artifact-download-500`（在 fetch 边界注入 500，页面走自己的失败分支）。证据不入 git，复跑产生新 attempt，失败写 `failure.json`，不覆盖旧 PASS。

供人复核的截图（与第一批同口径：**机器判定不依赖截图**）：`hint-run-id.png`（提示层显示完整 Run id，**整页裁剪「运行项 ∪ 提示」的并集**——提示 portal 到 body，元素截图拍不到它在按钮上方那一块）、`bell-off.png` / `bell-on.png`（授权前后的开关本体）、`toast-fuse.png`（悬停暂停时的卡与已烧一段的 fuse）、`toast-context.png`（toast 在页面右下角的实际位置）。铃铛徽标显示真实未读数由 web 判据钉住（有未读才渲染、进任务房归零），本链没有「离开任务房时正好跑完」的时刻，故不留徽标截图。

## 归因与边界

- 提示层内容不符：先看传入的 `label`（提示层不读任何 Run/事件数据），再看是否复用了错误的触发元素。
- 开关状态不符：先查浏览器权限（`Notification.permission`）与 localStorage 偏好，再看 `data-on` / `data-ring`；拒绝路径只剩只读说明是正确行为。
- toast 不消失/不暂停：先看 `--toast-fuse-ms` 与卡片计时器是否同一取值，再看 `data-paused` 的来源（悬停、聚焦、页面隐藏、拖拽）。
- 本批不覆盖：真机触摸的下滑手势（桌面指针路径已覆盖）、整站深色（#236 欠账，仅抖查命中的新组件在浅色与强制深色 token 下的对比度）、Safari/Firefox 的 `@starting-style` 差异。
- 提示层只服务可聚焦控件；纯展示文案上的原生 `title` 不做替换——那需要给只读元素加 tab 停靠点，是另一件事（登记为后续）。

## 发现登记

新增判据与证据入口见 [README](./README.md) 与 [取证地图](./evidence-map.md)。复跑命令：`pnpm test:e2e:micro`（Docker + 系统 Chrome）。
