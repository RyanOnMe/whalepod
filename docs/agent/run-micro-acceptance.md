# Task Room Micro 交互验收

- #402 红例（2026-10-19）：组合提交 `b2c67d5` 的完整 Q5 本机在 `composer-accepted.png` 失败：运行已 completed、Runtime 已释放，但 `.instruction-composer` 在截图等待字体/稳定期间被 keyed 子树替换，报 Element is not attached to the DOM。原状态/草稿判据已过，需修复取证宿主；失败位置保留在 `artifacts/q5/run-1.log`，不能删掉截图或重跑业务动作冒充修复。
- #402 修复：所有执行输入截图改取稳定 `execution-composer` 宿主，并在真实续跑完成后确认原表单已被替换、宿主仍连接。发送中/受理/拒绝、键盘、窄屏、减少动态和实时双人事实断言均保留。服务端拒绝路径先发出并暂缓真实请求，再经公开 API 撤销设备后放行传输，避免 UI 先行阻塞造成无 POST；不制造错误响应。清理失败不会覆盖原测试错误。
- #402 定向结果：两次独立冷启均 PASS（含最终提交前源码）；typecheck PASS，`artifacts/evidence/run-micro/` 证据已过敏感扫描。完整组合 Q5 待合并本次测试修复后重跑。

- 场景/门禁：G4 运行投影、G5-01/G5-03 审批观察与批准、执行区指令；Q0、Q5、许可与敏感扫描。
- Issue：P1-306；CallChip、StatusMark、ThoughtLine、RubberSegment，以及现有 InstructionComposer 的发送反馈。按用户后续要求在同一 Issue / PR 统一交付。
- 上次验证：2026-10-11 · `da0e5c75b687324c8775e50aec9dd917b3163579` · PASS。
- 实施方式：React Bits 固定版本的应用内源码适配，保留原始 MIT + Commons Clause；来源、逐文件原始哈希与使用范围见 [vendor README](../../apps/web/src/vendor/react-bits-micro/README.md)、manifest、LICENSE.md 和根 NOTICE。

## 用户路径与驱动

Alice 创建并接受 Task，启动 Builder Run。Bob 在另一个真实浏览器会话观察；审批期间双方看到暂停和“等待责任人审批”，只有 Alice 看到完整审批卡。Alice 通过键盘批准一次，工具结束后两端看到完成状态和“本次运行已完成”；Task 仍为 `in_progress`。

Alice 打开 Console，鼠标筛选工具事件，再用键盘切换与 Esc 关闭、回到原入口。浏览器减少动态模式下再次筛选，指示面即时切换。之后通过 Ctrl+Enter 发送新指令：传输被暂时拦住但不伪造响应，等待期间再次提交只能产生一个请求；释放后转发真实 Hub 请求，201 + `started_run` 才显示受理图形。等待该 Run 真实结束后，通过公开 DELETE 端点撤销这支一次性测试团队唯一的设备；再次发送得到真实 409 `DEVICE_OFFLINE`，保留正文和 requestId，不显示受理结果、不创建第三个 Run，Task 仍为进行中。

```bash
pnpm check
pnpm test:e2e:micro
pnpm test:licenses
scripts/secret-scan.sh artifacts/evidence/run-micro
```

Q5 独占冷启环境：一次性 PostgreSQL、包解析后已编译的 Hub 生产 server 入口、既有 Node 生产监督器、真实 Runtime bin 和 DSH approval/basic replay。Hub CLI 当前只支持 setup-token，因此服务启动走包内生产 server 产物；#281 起这是**全局唯一装配**（`--built-hub` 开关与源码路径分支已删除，装配前强制增量 build）。

所有 Run、审批、工具和指令状态来自真实 HTTP/WS。邀请、配对和故障前置走公开 HTTP；静态 Plugin Pack 沿用已登记的 seed。没有直接写运行、事件、审批或投影表。传输闸只控制请求到达时间，释放后 `route.continue()`，不修改正文、Header 或响应。截图供人复核，机器判定不依赖截图。

## 观测与判定

| 层 | 观测 | 必须通过的判据 |
|---|---|---|
| hub.run-projection | GET `/runs/:id/events` 的 `runId/seq/audience/type/callId/outcome/phase` | 两位观看者都有真实成功结束和公开阶段；本次 owner 21 条、member 10 条；不将完整 payload 入包 |
| hub.domain | 真实 Run / Task 查询、指令 HTTP outcome 与控制面白名单事实 | Run 完成不完成 Task；失败指令不创建 Run；开始、审批、完成各环节缺少数据必须失败 |
| node.supervisor / runtime.bridge | 真 Runtime 释放检查、outbox/审批/事件事实 | 等待真实 completed 与 Runtime 退出，不用本地动画推进终态 |
| web.micro / web.activity | DOM 状态/可访问名、布局、computed color、CSSOM/media | 九态准确；活动摘要只用 project 的已知阶段；审批/取消/终态/断线/后台停用 working；320–1280px 无新增横向溢出，成功 chip 对比度 ≥4.5:1 |
| web.console | group + aria-pressed 原生按钮、焦点与 computed transition | 不改成 radio/tab；鼠标 160ms、键盘/减少动态 0ms；筛选保留完整事件配对，关闭后回焦 |
| web.instruction | POST 数量、HTTP outcome、DOM feedback、正文与错误编号 | pending 禁重复；四种 outcome 如实呈现，rejected 不画成功；非 2xx 不吞正文、保留 requestId；执行目标与 full_access 确认不变 |

`run-micro.spec.tsx` 覆盖全部九态、跨 Run/受众拒配、乱序/重复、早于开始的结束、未知/缺失结果、审批/取消暂停、断线、查询错误、后台和加载中。活动摘要只读取本 Run 最新 project `run.phase` 的 thinking/tool/finalizing，未知最新阶段不复用旧阶段，owner-only 或其他 Run 不参与。assistant.message、preview 和原始思维不会传入 ThoughtLine；只生成枚举中文标签。连接与可见性订阅留在小组件，直播 token 订阅仍只在 RunLiveStream。

`instruction-composer.spec.tsx` 验证四种真实响应 outcome、失败保留正文和 requestId、重复快捷键，以及既有权限确认/目标路径。新草稿使按钮回到默认图形，原有上一条受理提示仍保留；图形从不表示 Run 或 Task 已成功。按钮图标固定 16px，减少文本切换跳动；无新增计时器、进度猜测、重试副作用或循环动画。

`micro-vendoring.spec.ts` 核对完整许可固定 SHA-256、八个来源条目和 NOTICE；漏来源、删除额外条款或改标许可会红。`pnpm test:licenses` 另查 pnpm 依赖，不能把该检查的绿解释为 vendor 是纯 MIT。

## 交互取舍复核

| Before | After | Why |
|---|---|---|
| 上游 ThoughtLine 含 trace、timer、auto-settle、shimmer 与 blur | 公开阶段的受控标签，邻近 StatusMark 保留唯一活动环 | 不猜进度、不外带思维，正文保持清晰 |
| 上游 RubberSegment 使用 radio、拖拽、弹簧与惯性 | Console 原生筛选按钮；鼠标短过渡，键盘/减少动态即时 | 保留现有筛选和 Tab 顺序，快速排障不等待动画 |
| 指令按钮只切换“发送中”文字 | 固定图标槽 + aria-busy + 响应图形，保持原提交路径和反馈文本 | 接口受理、排队、拒绝和传输错误有区别，且不冒充执行成功 |

## 验证结果与取证

- TDD：第一批 `b1c830c` / `b1c4a78` 先红；后续 `71b8133` 上 23 条相关判据失败、26 条通过。完整实现新增 34 条 web 检查及 1 条来源检查均通过。
- Q0：124 文件通过；1466 条通过、7 条既有 expected-fail。格式、lint、类型、边界、生成与插件 fixture 检查通过；另对最后新增 Q5 判据运行 web 测试 typecheck，PASS。
- Q5：完整真实浏览器场景 1/1 PASS（21.8s，场景 7.0s）；owner/member 零页面错误。
- 1280 / 390 / 320px：浅色与强制深色 token 条件下页面宽度均与视口一致、无溢出；成功 chip 实测文字/底色约 10.98:1。Console 390px 与指令 390/320px 单独复核无溢出；关闭按钮不再折行。
- 筛选：实际浏览器读到鼠标 `0.16s`、键盘与减少动态 `0s`。活动环减少动态规则被浏览器实际加载，终态无动画；后台行为由 visibilitychange web 判据覆盖。
- 真实慢请求重复 Ctrl+Enter 只有一次 POST；201 响应后正文清空；真实 409 保留草稿和 requestId，失败不创建新 Run。
- pnpm 许可检查 626 包通过；没有新增依赖或修改 catalog/lockfile。完整源代码差异、vendor、新增源码及证据经过敏感扫描。

本次证据目录：`artifacts/evidence/run-micro/3ea2f382/`。`result.json` 含按 component 分层的允许字段、运行事实、活动、发送、筛选、布局及减少动态结果；`checks.json` 记录命令退出码、测试计数与源码 commit。`run-panel.png`、Console 桌面/窄屏、composer pending/accepted/failed/窄屏与六张 chip 截图是实际项目预览。证据不入 git，复跑产生新 attempt，失败写 `failure.json`，不覆盖旧 PASS。

原始网络 trace 会含 Setup/Cookie，本配置关闭 trace，只归档白名单事实。参数、preview、Token、密码、设备路径和未发布产物正文不进入证据包。requestId 在 UI 中保留，归档仅记录其存在性。

## 归因与边界

- 图形或阶段与事实不符：先对比 hub.run-projection 的 Run/受众/序号/调用编号，再看 web.micro / web.activity；不用工具名、时间或 raw thinking 配对。
- 指令图形错误：先查 HTTP status/outcome 与 Hub 指令记录，再看 web.instruction；不能只用 201 判断受理。
- 状态未到终态：Hub 状态/outbox → Node → Runtime；不改动效掩盖失败。
- 测量先等待 matchMedia 驱动的侧栏真正卸载，再量像素；运行头部、指令动作区允许换行，工具文本可收缩。
- 整站深色尚未启用且有 #236 对比度欠账；本次深色仅查成功 chip 和页面宽度，浅色额外扫全页。没有宣称整站深色通过。
- 查询故障、断线、未知事件与其余指令 outcome 由 web 检查覆盖；Q5 真实链覆盖审批暂停/完成、201 起新 Run 和 409 非受理。没有跑发布级 Q5 连续 20 轮、Q8/Q9 或真机触摸。

发现入口已登记在 [README](./README.md) 与 [取证地图](./evidence-map.md)。Q5 前置为 Docker 与系统 Chrome；新增场景已接入 `pnpm test:e2e`，随既有发布级 Q5 loop 执行。
