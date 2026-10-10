# Run 状态与工具调用 Micro 验收

- 场景/门禁：G4 运行投影、G5-01/G5-03 审批观察与批准；Q0、Q5、许可与敏感扫描。
- Issue：P1-306；设计第一批 Call Chip + Status Mark。当前活动提示、分段筛选与发送反馈保留为后续切片。
- 上次验证：2026-10-10 · `a699ca47a078121c70b7edc7e5c315233321e063` · PASS。
- 实施方式：React Bits 固定版本的应用内源码适配，保留原始 MIT + Commons Clause；非纯 MIT、非 Apache-2.0 第三方源码。来源与使用范围见 [vendor README](../../apps/web/src/vendor/react-bits-micro/README.md)、manifest、LICENSE.md 和根 NOTICE。

## 用户路径与驱动

Alice 创建并接受 Task，启动 Builder Run。Bob 在另一个真实浏览器会话观察；审批期间双方看到暂停状态，只有 Alice 看到完整审批卡。Alice 通过键盘批准一次，工具结束后两端看到完成状态；Task 仍为 `in_progress`。Alice 打开 Console、筛选工具事件，再用 Esc 关闭并回到原入口。

```bash
pnpm check
pnpm test:e2e:micro
pnpm test:licenses
scripts/secret-scan.sh artifacts/evidence/run-micro
```

Q5 独占冷启环境：一次性 PostgreSQL、包解析后已编译的 Hub 生产 server 入口、既有 Node 生产监督器驱动、真实 Runtime bin 和 DSH approval replay。Hub CLI 当前只支持 setup-token，因此服务启动走包内生产 server 产物；不使用源码替代它。新配置启用 `--built-hub`；旧 Q5 默认启动方式仍归 #281 迁移。

所有 Run、审批及工具状态由真实 HTTP/WS 路径产生。邀请和配对前置走公开 HTTP；静态 Plugin Pack 沿用已在边界白名单登记的 seed。没有直接写运行、事件、审批或投影表。截图供人复核，机器判定不依赖截图。

## 观测与判定

| 层 | 观测 | 必须通过的判据 |
|---|---|---|
| hub.run-projection | GET `/runs/:id/events` 的 `runId/seq/audience/type/callId/outcome` | 两位观看者都有真实成功结束事件；owner 21 条、member 10 条；不将完整 payload 入包 |
| hub.domain | 真实 Run / Task 查询及控制面白名单事实 | Run 完成后 Task 仍为进行中；开始、审批、完成各环节缺少数据必须失败 |
| node.supervisor / runtime.bridge | 真 Runtime 释放检查、outbox/审批/事件事实 | 等待真实 completed 与 Runtime 退出，不用本地动画推进终态 |
| web.micro | DOM 状态/可访问名、焦点、像素宽度、computed color、CSSOM/media | 暂停无活动标记、完成图形来自真实结果；两种宽度零横向溢出，chip 对比度 ≥4.5:1；筛选与回焦成立 |

Web 判据在 `apps/web/tests/run-micro.spec.tsx` 覆盖全部九态、同名不同调用、跨 Run/受众拒配、乱序/重复、早于开始的结束、未知/缺失结果、审批/取消暂停、断线、事件读取失败和后台暂停。完成标签不划线、不重复朗读英文；chip 不传 preview，不提供工具重试入口。结果已确认时断线不撤销事实；未完成调用只能显示未知/连接状态，不能猜成功。

`micro-vendoring.spec.ts` 核对完整许可的固定 SHA-256、四个来源条目和 NOTICE；删除额外条款、改标许可或漏来源会红。`pnpm test:licenses` 另查 pnpm 依赖，不能把该检查的绿解释为 vendor 是纯 MIT。

## 验证结果与取证

- TDD：`b1c830c` 上 11 条检查预期失败；`b1c4a78` 补后台判据，未实现暂停时也预期失败。实现后新增 12 条 web 检查及 1 条来源/许可检查全部通过。
- Q0：124 个测试文件通过；1444 条通过，7 条既有 expected-fail。格式、lint、类型、边界、协议生成与插件 fixture 检查通过；lint 存量警告未扩张本切片范围。
- Q5：专用真实浏览器场景 1/1 PASS，owner/member 零页面错误。
- 1280px / 390px：页面宽度分别为 1280 / 390；两档在浅色和强制深色 token 条件下无溢出。成功 chip 的实际文字/底色对比度约 10.98:1。
- 减少动态：Chrome media 匹配成功，加载的活动环覆盖规则为 `animation-name: none`，终态实际动画为 none。后台停止由 visibilitychange 驱动的 web 判据覆盖；没有新增计时器。
- pnpm 依赖许可检查：626 包通过；本次没有新增依赖或修改 catalog/lockfile。
- 来源目录、新增源码和证据经过敏感扫描。

本次证据目录：`artifacts/evidence/run-micro/7f64a014/`。`result.json` 包含按 component 分层的允许字段、Run 事实、布局和减少动态结果；`checks.json` 记录命令退出码与测试计数。四张 chip 截图和 `run-panel.png` 是实际项目预览。证据不入 git，复跑会产生新的 attempt 目录，不覆盖旧 PASS；失败写 `failure.json`。

原始网络 trace 会含 Setup/Cookie，本配置关闭 trace，只归档白名单事实。参数、preview、Token、密码、设备路径和未发布产物正文不进入证据包。

## 归因与边界

- UI 图形与事实不符：先对比 `hub.run-projection` 的 Run/受众/调用编号/序号，再看 `web.micro`；不以工具名或时间配对。
- 状态未到终态：看 Hub 状态/outbox → Node 监督器 → Runtime；不改动动效来掩盖失败。
- 窄屏测量：先等待 matchMedia 驱动的侧栏真正卸载，再量像素；不能把旧的 264px 侧栏瞬间当成目标布局。运行头部换行、工具行允许收缩，防止新增组件撑宽。
- 整站深色模式尚未启用，已有 #236 对比度欠账；本次深色只核验新增成功 chip，浅色额外扫全页，**没有宣称整站深色通过**。
- 查询故障、断线、工具失败/取消与畸形事件由 web 检查覆盖；本次 Q5 正向链为批准一次后成功。没有跑发布级全套 Q5 连续 20 轮、Q8/Q9，也不代表安装或真机触摸验收。

发现入口已登记在 [README](./README.md) 与 [取证地图](./evidence-map.md)。最短复跑使用上述命令；Q5 的前置是 Docker 与系统 Chrome。新增场景已接入 `pnpm test:e2e`，会随现有发布级 Q5 loop 执行。
