# docs/agent — Harness 文档索引

给在这个仓库里干活的人和 AI：验证怎么拆、证据去哪找、验过的步骤放哪。

| 文档 | 内容 |
|---|---|
| [ai-harness-principles.md](./ai-harness-principles.md) | 六原语：驱动、观测、判定、归因、取证、发现 |
| [issue-workflow.md](./issue-workflow.md) | 问题从发现到合入的完整走法 |
| [evidence-map.md](./evidence-map.md) | 出问题时去哪一层找哪份证据 |
| [acceptance-template.md](./acceptance-template.md) | 验收文档模板；新验收一律按它写 |
| [instruction-path-acceptance.md](./instruction-path-acceptance.md) | #186（ADR-0009 切片③b）：追问受理→命令入队→ack 结算 `instruction_state`（含拒绝理由落库、状态受理规则、幂等与授权不变量的 10 条用例） |
| [instruction-grant-acceptance.md](./instruction-grant-acceptance.md) | P1-198（切片④）：指令权授权——责任人 ∪ 被授权成员；审批权/Run 归属/讨论区三条红线不变 |
| [instruction-starts-run-acceptance.md](./instruction-starts-run-acceptance.md) | P1-196（切片③c-2b）：执行区指令起 Run——有活跃 Run 降级为追问、无则由设备/工作区三段式解析后建 Run，指令命运由 run.start ack 结算 |
| [discussion-separation-acceptance.md](./discussion-separation-acceptance.md) | P1-194（切片③c-2a，ADR-0010）：讨论流只含 `discussion`、执行流只含 instruction/followup（带状态与拒绝理由）——评论区纯人际，执行状态不外溢 |
| [instruction-queue-acceptance.md](./instruction-queue-acceptance.md) | P1-192（切片③c-1）：未 running 的追问只落 `pending`、进 `running` 时按 `(created_at, id)` 补发——含幂等、终态清扫、Node not-ready 守卫的复刻 |
| [ephemeral-volume-acceptance.md](./ephemeral-volume-acceptance.md) | #188：一次性 PostgreSQL 的卷回收与陈旧容器清扫——净增卷=0（真实 Docker 判据）、pid 感知清扫（同 worktree 并发不互杀；pid 复用有 6h 年龄兜底）、四处删除点的 `-v` |
| [typecheck-coverage-acceptance.md](./typecheck-coverage-acceptance.md) | #178：`tests/` 纳入 typecheck 面（给**门**立档）——已接线 5 包 / 未覆盖 4 包及各自实测存量错误数、变异验证、接线护栏、`--if-present` 静默跳过风险 |
| [module-resolution-acceptance.md](./module-resolution-acceptance.md) | #35：vitest 面解析到 src——包 exports 加 development 条件，测试永远打新鲜源码；tsx scripts 仍走 dist（先 typecheck）；自证 spec 与红绿证据 |
| [web-honest-states-acceptance.md](./web-honest-states-acceptance.md) | #225 前端交互批次①：任务房间诚实性修复——指令流运行号接线、目标条加载/错误态、取消/重跑失效缓存、错误口径统一、返回项目入口 |
| [connection-visibility-acceptance.md](./connection-visibility-acceptance.md) | #227 前端交互批次②：断线横幅 + 重连全量补拉 + session 过期自动跳转（含 loader-fetchQuery 死循环的抓获与修法、ConnectionIndicator 取舍） |
| [feedback-consistency-acceptance.md](./feedback-consistency-acceptance.md) | #229 前端交互批次③：ConfirmDialog 替代 window.confirm（焦点陷阱/还焦/Esc）、toast 通道（4s 消退/上限 3）、Cmd+Enter 发送、Esc 关窄屏导航；Plugin 页 notice 保留的取舍 |
| [room-polish-acceptance.md](./room-polish-acceptance.md) | #231 前端交互批次④：执行活动提示（ADR-0010 信息真空债核销）、加载骨架（reduced-motion 尊重）、「上方」方位词清理；Hooks 早退陷阱记录 |
| [testid-inventory-acceptance.md](./testid-inventory-acceptance.md) | #85：关键动作可测性盘点——选择器清单与 e2e 证据、键盘路径结论（无不可达项）、UI 驱动 vs HTTP 旁路分工表；RunActions 四处 testid 补齐（零行为变化） |
| [run-states-acceptance.md](./run-states-acceptance.md) | #234：运行状态集合三处收敛到 run-states.ts 单一真源；关系判据对协议 RunStatusSchema 防漂移（协议加状态必红） |
| [resume-runs-acceptance.md](./resume-runs-acceptance.md) | #237 ADR-0009 切片⑤：resume 续跑全链——协议互斥/成对守卫、Hub 四重守卫（同 Workspace 机器判据）、Node home 复用、Q3 wire 驱动探针、Web 接着聊与血缘句；边界（Q5/Q2 CI 兜底、摘要 fallback 未做） |
| [agent-assignable-acceptance.md](./agent-assignable-acceptance.md) | #239 ADR-0009 切片⑦：Agent 可被指派——assignee_user_id 恒真人（责任人=指派人）+ assignee_agent_id 多态、指派即指令自动驱动（sendInstruction 同链复用）、出生 accepted；边界（followup 分支不可达、crash window 手动恢复） |
| [approval-policy-acceptance.md](./approval-policy-acceptance.md) | #241 ADR-0009 切片⑧：审批档位（approval_required/full_access）——Revision 默认→Task 覆盖→Run 固化解析链、digest 七键口径、Q3 full_access 零审批帧契约、放权三显式面（设置确认/启动确认/运行卡标记）；ADR-0010 撤销自动降级的口径收口 |
| [composer-approval-pill-acceptance.md](./composer-approval-pill-acceptance.md) | #244 P1-UX-6：composer 审批档位胶囊——发送前知情（档位+来源三条解析：追问=Run 固化档/任务覆盖/服务端预解析 Revision 默认 `nextRunApprovalPolicy`）+ full_access 发送确认；与 orchestrator 解析同式两处成对；「发送前可见≠发送时可改」的取舍 |
| [tool-trace-chip-acceptance.md](./tool-trace-chip-acceptance.md) | #246 P1-UX-7：工具轨迹内联——指令条目 chip「已用工具：x」点开直达 Console（渐进展开，Console 仍是审计真源）；服务端 DISTINCT ON 取每 Run 最新 project 受众 tool.started；受众收缩判据（owner-only 高 seq 不进全员摘要） |
| [run-duration-acceptance.md](./run-duration-acceptance.md) | #248 P1-UX-8：运行时长（时间感）——运行卡时长行（终态固定总时长/活跃已耗时 30s 自跳/未开始不画）；formatDuration 四档纯函数；fake timers 只 fake Date 的测试教训 |
| [artifact-preview-acceptance.md](./artifact-preview-acceptance.md) | #250 P1-UX-9：交付物有脸——文本类工件页内预览（512KiB 资格/64KiB 截断/三态诚实）+「对这个工件继续说」注入 #216 引用 token 到讨论框；重预览器不做、candidate 不加入口的取舍 |
| [recent-tasks-acceptance.md](./recent-tasks-acceptance.md) | #252 P1-UX-10：侧栏最近任务——按活动排序（greatest(updated_at,最新消息,最新 Run)）的 ≤1 击回现场入口；窄投影含 projectName；小节标签不进标题层级（h2 判据教训）与「重试」撞名消歧 |
| [global-search-acceptance.md](./global-search-acceptance.md) | #254 P1-UX-11：⌘K 全局搜索——title ILIKE（转义通配符/参数化/空 q 400）+ 浮层（option 语义/键盘路径/还焦）；mock respond 拿不到 URL 等三条踩坑记录 |
| [density-audit-acceptance.md](./density-audit-acceptance.md) | #257 P1-UX-12：视觉密度审计+门禁——七页 cardDepth/hintCount 实测基线、删留逐条决定（审批/复核卡去 card-in-card）、density-gate 上限进 Q1（变异自证非恒真） |
| [run-completion-notifications-acceptance.md](./run-completion-notifications-acceptance.md) | #259 P1-UX-13：运行完成通知——tab 徽标 + 可选系统通知；已读水位落 localStorage（纯内存游标每次刷新重放 24h 窗口）、重放 vs 当场（occurredAt ±60s 容差）；「初版判据是盲的」变异自测教训 |
| [run-phase-badge-acceptance.md](./run-phase-badge-acceptance.md) | #261 P1-UX-14：运行卡阶段徽标——服务端投影 lastPhase（DISTINCT ON + project 受众 + 未知值当没有）、只对 running 画（终态「收尾中」=撒谎）、补 run.changed→task-room 的实时缺口；`!== null` 放过 undefined 致整页白屏（既有 spec 抓出）与 SQL 探针证据 |
| [global-search-entities-acceptance.md](./global-search-entities-acceptance.md) | #263 P1-UX-15：⌘K 三类实体——任务（服务端）+ 项目/Agent（本地过滤缓存，零新端点）、扁平跨段键盘、项目/Agent 落点 hash 锚点高亮（useHashFocus）；可访问名改口与「变异没生效的绿」教训 |
| [shortcut-help-acceptance.md](./shortcut-help-acceptance.md) | #265 P1-UX-16：`?` 快捷键速查——「只列已实现的键」（四条各有可按性判据的账本）、输入焦点不抢键、空转判据（还焦）被变异逼出关闭钮；与 #267 偶发红同族的负载敏感记录 |
| [motion-foundation-acceptance.md](./motion-foundation-acceptance.md) | #271 P1-UX-17：动效底座——全仓自有 CSS 原本 `transition` 为 0（唯一的动效是骨架脉冲）；token 化取值（强曲线，对齐 vendored 120/160ms 约定）+ 10 个具名交互面的过渡 + `:active` 按下反馈（token 化以便 reduced-motion 一处关位移）；控制族期望表登记与「变异没生效的绿」复踩记录 |
| [presence-acceptance.md](./presence-acceptance.md) | #273 P1-UX-18：在场与退场——`usePresence`（保留上一次值 + 可打断退场）；Console/toast/断线横幅两段式消失；退场时长 JS 与 CSS 两端一致的现场解析判据；「断言要打在真正生效的那一端」（只断言 data 属性时删类名变异存活） |
| [run-live-stream-acceptance.md](./run-live-stream-acceptance.md) | #275 P1-UX-19：直播产出区连续性——流式光标、跟随滚动可被用户接管（「回到最新」）、订阅下沉使每帧重渲染收窄；**度量注入**口径（jsdom 无布局，不注入就只有一条分支被真执行）与防空转断言 |
| [crossfade-acceptance.md](./crossfade-acceptance.md) | #277 P1-UX-20：内容形态切换——骨架→内容的交叉淡入（判据是"两者同时在 DOM"，硬切不可能满足）、空态/列表的挂载入场、状态徽标换色；「在场对象不是 value\|null」与「取规则体要按行首锚定」两处踩坑 |
| [dsh-ui-vendoring.md](./dsh-ui-vendoring.md) | vendored 第三方代码的出处台账：上游钉版 SHA、逐文件映射、同步纪律、许可/商标义务落点（ADR-0008 / #138） |
| [setup-auth-invite-acceptance.md](./setup-auth-invite-acceptance.md) | G1-01..06：Setup/登录/邀请/角色/Origin gate 验收（P1-05）；#55 迁移并发串行化与等锁超时判据 |
| [project-task-agent-acceptance.md](./project-task-agent-acceptance.md) | G2-01..06：Project/Task/Comment/Assignment + Task Room 聚合 + Agent Revision 验收（P1-06） |
| [run-orchestrator-acceptance.md](./run-orchestrator-acceptance.md) | G4-01..03、R7/R8：Run Orchestrator 与事务 Outbox 派发（P1-10） |
| [browser-realtime-acceptance.md](./browser-realtime-acceptance.md) | G2-06、R2/R3、§6.2：Browser Team Event 实时链路与断线补洞（P1-08） |
| [web-shell-acceptance.md](./web-shell-acceptance.md) | Issue #11/#23 验收：Web 壳与 Task Room 双上下文主链 e2e（P1-07 种子）+ P1-19 全链/恢复/行动 12 场景与 Q5 正式门（三通道映射与实测发现） |
| [control-family-acceptance.md](./control-family-acceptance.md) | #168：自研表单控件（`.field input` / `.field textarea` / `.button` 族）对齐 DSH 族的机器判据——度量从 vendored CSS 现场读、变异验证、Q5 接线与未覆盖清单 |
| [resume-probe-acceptance.md](./resume-probe-acceptance.md) | #176（ADR-0009 切片①）：会话 resume 可行性探针——同 id persisted load、`fromRequest` 上下文硬判据、日志线性增长与开销实测、未覆盖边界 |
| [dsw-official-theme-acceptance.md](./dsw-official-theme-acceptance.md) | #173：全站迁移真实 DSH Web 形态——浅色侧栏壳（互斥渲染）、胶囊按钮族、L1 白名单第三批、灰平台白卡；Q0/Q5 判据与两档截图自审 |
| [workspace-runtime-acceptance.md](./workspace-runtime-acceptance.md) | G3-04..06：Workspace Registry、Runtime 进程隔离与无孤儿恢复（P1-12） |
| [run-projection-acceptance.md](./run-projection-acceptance.md) | G4-04..06、R1/R6、§6.4：Run 投影、双受众流与全链路 replay 验收（P1-13） |
| [approval-acceptance.md](./approval-acceptance.md) | G5-01..07：一次性 Approval 闭环——owner 决策、first-wins、过期与取消联动（P1-14） |
| [plugin-pack-acceptance.md](./plugin-pack-acceptance.md) | G1-05、04 §6.5、Q3：Curated Plugin Pack、未修改插件端到端与攻击矩阵验收（P1-17） |
| [artifact-acceptance.md](./artifact-acceptance.md) | G6-01..08、04 §6.3：Artifact 候选/存储/发布/Reviewer 输入与路径攻击矩阵验收（P1-15） |
| [task-message-entity-acceptance.md](./task-message-entity-acceptance.md) | #185（ADR-0009 切片③a）：`task_message` 实体升级——讨论/指令/追问同表、数据层硬约束（讨论不驱动 Agent、受理即落账、追问挂既有 Run）、线程读取排序 |
| [run-lifecycle-acceptance.md](./run-lifecycle-acceptance.md) | G7-01..06、R4/R5/R9、Q6：Run 取消/强杀/丢失与显式重跑验收（P1-16）；#180 追加：执行中追问的受理语义（含 B1 假受理回归）|
| [harness-acceptance.md](./harness-acceptance.md) | P1-18：六原语 harness（phase1:drive/verify/evidence）、跨层 traceId/runId 索引、Evidence 包与四层断层自证；#73 取证面绝对路径归约与「证据目录无绝对路径」判定 |
| [agents-plugins-copy-acceptance.md](./agents-plugins-copy-acceptance.md) | #167：Agents 页与插件页的文案/排版（标签中文化、`curated` 换人话、长摘要截断+复制、去重复标题、page-grid 两栏）；Q5 内文案判据（裸 64 位摘要 / 内部词表 / 同义标题）与两档截图自审结论、未覆盖清单 |
| [select-menu-acceptance.md](./select-menu-acceptance.md) | #158：七处原生 `<select>` → vendored `Menu` 的落页验收（反面钉、L1 token 视觉判据、键盘与回焦、两档截图与 390 档菜单定位）；含「迁移让 #159 对比度门第一次扫到禁用态压暗」的实证与五条迁移注意 |
| [focus-ring-acceptance.md](./focus-ring-acceptance.md) | #164 焦点环对比度门：`--focus-ring` 双层环的逐层实测（浅色/深色两套 × 四个底色）、红→绿实测、非文字对比度 3:1 的边界与未验证清单 |
| [load-performance-acceptance.md](./load-performance-acceptance.md) | Q8 短档性能门：10 浏览器 WS 传播 p95 · 2 Run×20ev/s 合成流 ingest p95 · 空闲段 RSS 斜率（30min 空闲口径的缩短代理）· 环境不足 exit 3 无 SKIP；尺子账与覆盖边界（P1-20/#109） |
| [jargon-ids-acceptance.md](./jargon-ids-acceptance.md) | #152/#162 术语泄漏：内部 id 不冒充人名/标签——指人槽位判据（位置敏感、期望值取自真名册）、Run/交付物的人话句柄、红→绿变异复跑清单 |
| [2026-10-08-release-harden-validate-handoff-plan.md](./2026-10-08-release-harden-validate-handoff-plan.md) | 2026-10-08 下一阶段总纲：先发布收口、再外部验证、后强化 Handoff——A0 收口 8 项、3 队 Alpha、最小 Handoff、门禁重分级与范围控制 |
| [2026-10-08-q-gates-g0g1g2-tiers.md](./2026-10-08-q-gates-g0g1g2-tiers.md) | 2026-10-08 门禁分级：Q0–Q9 落到 G0/G1/G2——PR 触发规则、release 发布门、本地无 Docker 口径 |
| [poll-until-acceptance.md](./poll-until-acceptance.md) | #256 固定 sleep 改 poll-until：17 处转换（含 lastSeenAt 严格变大）、全仓 62 处普查与五类保留理由、waitForValue 约定 |
| [security-negative-acceptance.md](./security-negative-acceptance.md) | A0（2026-10-09）安全负向 8 项 → 11 条判据：审批归属/一次性时效/Device 撤销/失效授权/终态不复活/受众门/不谎称副作用已停/伪造身份；含两处变异自证 |
| [runtime-capability-contract.md](./runtime-capability-contract.md) | A0-6：DSH 熔断的单一登记处——六项能力 + 四条规则逐条给判据或挂 Issue（#288/#289/#290）、版本锁现状、CI 接线（Q3/Q6/Q7 从「文档说必跑」改成真跑）、未覆盖清单；表本身由 scripts/tests 的漂移哨兵机检 |
| [compose-standard-loop-acceptance.md](./compose-standard-loop-acceptance.md) | A0-5/#286 空卷安装的标准闭环：A 段机检（邀请/双设备/双 Workspace 隔离/Agent 装配/Task 指派/双 Run/凭证边界/跨成员拒绝）+ B 段边界（Agent 真执行需真密钥，归 Phase 2）+ 变异自证与 15 分钟预算账 |

规矩只有一条：**验过就要留下**。验收步骤、探针跑法、上次结果、坑在哪，写进这里的 acceptance 文档；能直接复跑的脚本放 `scripts/`。只留在 `/tmp` 或对话里的验证，等于没验。

验收文档命名：`<链路或场景>-acceptance.md`，放在本目录，并在上表补一行索引。
