# 连续对话工作区验收（#393 / ADR-0019）

> 状态：实现、机器判据与独立判定随本批次合入；本页登记「验了什么、怎么复跑、边界在哪」。
> 关联：ADR-0019、ADR-0018（决定 2 被本 ADR 取代）、03 §「执行区与指令流」、
> docs/agent/evidence-map.md。

## 一句话

执行区不再是「先选一个运行，再看它的面板」，而是**一条按时间连续读的对话**：多次执行、
续聊、重跑与追问各自成段，段序跟服务端运行顺序，回复不需要先选运行就出现在主界面；
每段只留一个简短状态 + 一个「运行详情」入口（落点/时间/版本/血缘/输入/Console 都收进去）。
生产装配（真 Hub 生产入口 + 真 Node + 真 Runtime replay + 两个成员浏览器）把这六件事一次
走完：段内审批、被授权成员的排队追问在撤销后**当场被拒**、默认继续（结束→续聊最近一次
业务运行；活跃→追问；用户选过就不再被改写）、真实分页游标读到事件表末尾、设备离线时
默认继续被界面挡下且草稿保留。事实落盘后由**独立判定器**重判（缺证据/自相矛盾即 FAIL）。

## 机器判据（复跑入口）

| 判据 | 入口 | 覆盖 |
|---|---|---|
| 连续对话生产装配 | `tsx scripts/run-conversation-acceptance.mts`（project `p1-393`；已接入 `pnpm test:e2e`） | 一次真执行链：连续呈现 / 默认继续 / 段内审批 / 被拒指令 / 游标分页 / 离线拦截；事实写 `artifacts/evidence/conversation-flow/result.json` |
| 真实布局与阅读锚点 | 同上的第二支用例（**读面打桩**供 25 段，交互全真实） | 首屏 20 段窗口、载入更早的锚点漂移、上翻后新内容不拽人、单一滚动容器、1440/390/320 三档无横向溢出 |
| 独立判定器 | 同上 runner 链尾（`scripts/verify-conversation-evidence.mts`） | 交叉一致性判据（三段运行互不相同且血缘指回第 1 次；limit=1 的页数 == 事件表行数；成员读是同一表的真子集；锚点漂移 ≤4px；跟随关闭后 scrollTop 逐像素不变；被阻断的那次续跑**一条指令 POST 都没发出**）；退出码即 runner 退出码 |
| 判定器自证 | `pnpm test:unit`（`scripts/lib/conversation-evidence.spec.ts`） | 正控 + **16 组逐条负控**（缺证据 / 血缘自相矛盾 / 把桩当生产数据 / 锚点其实被拽走 都判 FAIL） |
| 阅读锚点的两条语义 | 同上的第二支用例（真实布局）+ `conversation-workspace.spec.tsx`（受控读数） | ①锚点是**第一个可见条目**（列表长时 DOM 第一条在视口之上，锚它等于锚一段看不见的内容）；②「都读完了」必须含**运行详情**读（段的形状在详情回来后才定稿）。两处都做了变异自证；真实布局读数：应用锚的条目漂移 **0.25px**（阈 4px），锚点下方邻段 **21.25px**（= 前一段变成非首段时多出的分隔 border-top 1px + padding-top 20px，阈 24px） |
| 页面与模型判据 | `pnpm test:unit`（`web` project：`conversation-workspace.spec.tsx` 21 例、`run-segment.spec.tsx` 31 例、`run-event-pages.spec.ts` / `run-event-text.spec.ts` / `run-buffer.spec.ts` / `conversation.spec.ts` / `execution-defaults.spec.ts` 纯模型、`task-room.spec.tsx` 时长自跳） | 六组判据的确定性面：>500 条事件分页、重复帧、受众空隙、**窗口滑动让出并发名额**（第 4 次之后新段仍被读到）、**失效重拉走续读游标**（只问游标之后的部分）、分页失败保留 + 重试、重连重拉、20 段窗口、加载更早的锚点（**受控读数**，段缺 `data-conversation-entry` 即红）、直播净剩（两条回复时不误报"未持久化"）、缓冲槽位有上限、活跃时长 30s 自跳、模板态（waiting/failed/cancelled/lost/incomplete） |
| 回归面 | `pnpm test:e2e` 全链（p1-07/p1-19/p1-140/p1-141/p1-142/p1-158/p1-312/create-to-recovery/p1-314/preparation-return/p1-381 + micro + workspace） | 结构重排后的既有走势：`full-chain` 的事件/血缘断言改按**段**定位、重开一段执行先显式改选「开始新执行」；`run-micro`/`secondary-surfaces` 的 Console 入口改走运行详情；`realtime-observation` 先切「团队讨论」频道；任务房间/聚焦工作区/交付复核的详情面板与文件卡按 runId 归属。三类**测试侧**踩坑已登记（见下「回归发现」） |

## 六原语对位

- **驱动**：浏览器走产品 UI（建任务/授权/开始执行/批准/继续会话/重跑/打开运行详情/切讨论/
  继续此会话）；配对码、评论与撤销授权走真人同款 HTTP；Node 生命周期与夹具切换走
  e2e-serve 控制面（只做进程与夹具，不做产品动作）。第二支用例的读面打桩只供**数据量**，
  交互（滚动、加载更早、跟随、布局）都在真浏览器里量。
- **观测**：Task Room 聚合（runs 的 `resumeFromRunId`/`rerunOfRunId`/`createdAt` 顺序、
  instructions 的 `instructionState`/`instructionErrorCode`）、`GET /runs/:id/events?after&limit`
  的真实响应、Node 侧事件表事实（`/control/db/run/:id` 的 `runEvents`）、DOM 里的段顺序与
  滚动读数、真实 WS 帧计数。
- **判定**：`result.json` 的离散事实 + 独立判定器的交叉一致判据（见上表）。
- **归因**：段与回复派生在 web 的 `features/task/conversation.ts`，分页读取在
  `shared/realtime/run-event-pages.ts`，默认继续在 `features/task/execution-defaults.ts`，
  指令命运在 hub.run.instruction/followup，事件写在 node.projection，页面在 web.task。
- **取证**：`artifacts/evidence/conversation-flow/`（result.json + 5 张截图，脱敏、无路径/
  Token）；失败时 Playwright trace 与 hub/node/vite 日志尾由既有 `collectEvidenceOnFailure`
  归档。出包后过 `scripts/secret-scan.sh`。
- **发现**：本页与 ADR-0019 已登记；索引见 `docs/agent/README.md`。

## 回归发现（结构重排后实测：四条测试侧 + 一条产品侧）

1. **`count()` 数得到"收起的入口"，点它会静默吃掉整条用例的超时**：运行详情面板开过一次
   就常驻 DOM（收起是 `hidden`），`run-micro` 的 `openRunConsole` 原用 `count() === 0` 判
   「详情开没开」，第二次调用时数到隐藏的按钮、接着点一个 hidden 元素——没有任何断言报错，
   180s 全耗在这一步（`failure.json` 只写着 test timeout）。判据已改为看**可见性**。
   同一坑在别处同样成立：探针问「在不在」时要想清楚"在"是"可见"还是"挂载"。
2. **「一个界面只有一个标题」要按最上层算**：ADR-0019 把 Console 入口挪进运行详情后，
   Console 是弹在开着的详情抽屉之上的模态，于是同一屏有两个可见标题（模态一个、被压住的
   详情一个）——`secondary-surface-audit` 原来的单选法把这种**正常叠放**判成红。现按
   最上层判（模态优先），并额外记录叠放层数：只允许"模态压在面板上"这一种 2 层形态，
   其余每档必须是 1 层；`scripts/verify-workspace-evidence.mts` 按名断言（console = 2）。
3. **默认继续会把"第二次启动"从页面上拿掉**：`full-chain` 的第二次执行原本假设启动器
   一直在，ADR-0019 起同一任务有历史时默认落在「继续会话」，启动器不渲染（`选择 Agent`
   找不到 → 30s 硬失败）。用例改为走真人同一条路——先把「执行方式」明确改选「开始新执行」
   （`helpers.chooseNewExecution`；显式改选会钉住 `modeOrigin='user'`，读取面慢一拍也不会
   翻回去）。`realtime-observation` 则是**修一条 main 上早已不成立的红灯**（#388 把留言搬进
   独立频道后，`textarea[name="body"]` 落在隐藏频道里；本批改动只是让观察前先切过去，
   不是本批引入的回归——`task-room` 早就切了，`realtime-observation` 漏了）。
4. **"打开详情"会把窄屏的对话整栏藏起来**：`≤1199px` 且详情开着时
   `.workspace-body[data-inspecting] > .workspace-conversation` 是 `display:none`（既有规则，
   正确行为）。`run-micro` 为打开 Console 把详情留在了画面上，切到 320px 后再去截输入框——
   元素不可见，`locator.screenshot` 一直等到整条用例超时（同样没有任何断言报错）。修法是把
   详情关掉再量窄屏（真人顺序也是先关详情）。诊断手段记在这里：`DEBUG=pw:api` 能把"卡在
   哪个 API 调用"指出来，比在日志里猜快得多。
5. **行动面在每个段里重复了一遍（产品侧修复）**：取消 / 继续此会话 / 重跑此 Run 原先是
   `RunSegment` 直接渲染的，于是 11 个终态段就有 11 个「重跑此 Run」（全链用例的全局 role
   查询撞出 strict mode 违规），而且与 ADR-0019 决定 2「每段只留一个简短状态 + 一个运行详情
   入口、低频操作收进详情」不符。行动面搬进 `RunDetailPanel`（与段共享 `['run', id]` 读面，
   不额外打接口）；「继续此会话」点完自动收起详情、焦点回到底部输入框。段上的判据随之改成
   "段里没有任何行动入口、段头按钮打开详情"（`run-segment.spec.tsx`），并按真人路径把
   `run-actions` / `conversation-workspace` 的入口改到详情里。

## 复核实测修复（第二轮独立审查：并发 / 读取 / 披露，编号接上）

6. **窗口滑动会永久漏掉并发名额**：`admitRuns` 原来把"曾经准入过"的运行都算在途，而读取
   顺序是**滑动窗口**（首屏 20 段）——段被挤出窗口后它的读取查询已经撤下，却仍占着名额；
   窗口每滑动一次漏一个，第 4 次之后 `free` 恒为 0，新来的段再也读不到（静默停在
   「正在读取活动信息…」，回复永不出现）。修：在途 = `admitted ∩ 当前这一屏 \ 已读完`；
   判据两层——纯函数（窗口外的不占名额）+ 页面级（20 段排满后来 4 段，每段都要自己读出回复）。
7. **失效重拉是"续读"而不是"从头重读"**：活跃运行每来一条持久事件都会失效这条读取，原来
   每次都把整条流按 500 一页重新拉一遍（长运行下是 O(事件数/500) 的重复请求）。修：以缓存里
   已读到的 max seq 作为起点续读（缓存永远是本人可见流的前缀，所以既不会跳帧也不会重复读），
   合并时**同一身份以最后一份为准**（服务端版本优先于缓存旧副本）。桩也相应改成按 `after`
   给页——按调用次数给页的桩在续读语义下会喂回已读过的页，把判据变成假的。
8. **终态运行读不到事件时，主阅读面什么都不说**：披露原来只在默认收起的「工具与运行记录」
   里，于是一个读不到事件的已完成运行看起来像"没有产出"——正是 ADR-0019 决定 5 点名不许的
   误报（旧面板在回复区直接给过这句话）。修：披露移到**段体**（`run-events-incomplete` 带
   重试入口，仍在同一 testid 上）。
9. **同一件事在两处重复显示的直播净剩**：终态段的"未持久化直播输出"原来拿直播原文与回复
   拼接做等值比较，两条以上 `assistant.message` 时必然不等 → 同一内容既作回复、又作"未持久化"
   再显示一次。修：逐条扣减，只显示净剩（`liveResidue`，纯函数带判据）；另外给直播缓冲加了
   槽位上限（会话里看过的 Run 不再每个留 64KB 到页面结束）。

## 边界（不得当成已完成）

1. **真人试用一律 not_run**：本页只证机器判据；「对话式执行区是否真的减少来回」属于
   `operation-flow-usability-trial.md` 的决策目标。
2. **25 段的布局面是读面打桩**：真跑 25 个 Run 代价过高（一次真执行 = 一个 Runtime），
   第二支用例把任务聚合 / 运行详情 / 运行事件替换为可预期的响应，交互与布局仍在真浏览器
   里量；哪一部分是桩由 `facts.window.stubbed` 显式声明，判定器要求它非空。**分页游标的
   真实语义**在真端点上验（limit=1 逐页走到表尾）+ 组件面验 >500 条的体量。
3. **成员看不到助手回复是既有受众语义**：`assistant.message` 属 owner 受众，成员视角只有
   段结构与状态（本批未改协议）；「历史回复不消失」判的是 owner 视角。
4. **设备离线只能客户端挡（本批的实测发现）**：Hub 的 `DEVICE_OFFLINE` 判据读设备事实列
   `devices.dsh_distribution_version`（`node.hello` 回填、**断连不清**），而续聊/重跑固定
   来源的设备与工作区，于是「停掉 Node 之后续聊」在服务端**照建 Run**（本用例首轮实测
   201，长出一次注定失败的运行）。本批据此在执行区加了客户端闸（来源设备读面显示离线即
   阻断 + 说清原因 + 保留草稿，不自动改投），并把它判进生产验收；服务端那条「注定失败的
   Run」是既有语义缺口，**本批不改协议/服务端**，登记为后续候选（见下）。闸门只拦
   `status === 'offline'`：设备**已撤销**是永久失效，服务端会带 `DEVICE_REVOKED` 与
   requestId 明确回绝、页面另有就地说明与恢复入口（`run-micro` 判着这条），客户端抢答会把
   那条更准的话术吞掉。
5. **`new/review` 档位的设备阻断**由既有 p1-315 判据覆盖（目标选择器只列在线设备）。
6. **被拒指令的两条路**：本批生产验收走的是「排队的追问 + 撤销授权 → FORBIDDEN」这条
   可复现的路径；「无归属运行的拒绝指令按时间保留」由模型/页面判据覆盖（协议没有
   逐条回复关联，因此不伪造对应关系）。
7. **`cancel_requested` 窗口内的当场拒绝**：需要与取消 ack 抢跑，属竞态；由 hub 单测与
   p1-315 的既有判据覆盖，本页不重复。

8. **段内增长不触发"贴底跟随"**（复审核对后的取舍）：跟随判定看的是底部**条目身份**
   （`conversationBottomKey`），所以段内部长高（详情读回后出现的行动面、审批卡、文件卡）
   不会把跟随态的人拽到新内容——流式增长由 `onStreamGrowth` 单独兜住，而"详情读回后的
   增长"对已经在底部的人没有影响（他在底部，看到的还是底部）。真要看的是"上翻的人不许被
   拽走"，那条由锚点与「回到最新」判据覆盖。这一条**不是**缺陷，登记以免下次当成缺陷。
9. **频道切换时（对话被 `display:none`）跟随写入是空操作**（复审核对的假设，非缺陷）：
   切到团队讨论时执行区整栏隐藏，`scrollTop/scrollHeight` 都是 0，写入 0 不改变任何状态；
   切回来时跟随态照常贴底。无判据、无可动作项。

## 后续候选（本批登记，不夹带）

- **[#394](https://github.com/RyanOnMe/whalepod/issues/394)**：服务端的 `DEVICE_OFFLINE` 判据
  只看版本列（断连不清），因此「来源设备已下线」这类续跑会先建出一次注定失败的 Run。
  要么在续跑解析目标时按设备在线状态（`lastSeenAt` 窗口或 `node.hello` 连接事实）再判一次，
  要么在 Run 分发失败时给出可读归因——需要单独的取舍记录（标 `needs-decision`），
  故不在本批改动。

## 复跑

```bash
pnpm --filter @whalepod/hub... build && pnpm --filter @whalepod/runtime... build   # 生产装配前置
node --import tsx scripts/run-conversation-acceptance.mts                          # 真装配 + 独立判定
pnpm test:unit                                                                      # 模型/页面判据 + 判定器负控
pnpm test:e2e                                                                       # 全链（含本条）
```
