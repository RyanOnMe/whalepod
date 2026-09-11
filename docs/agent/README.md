# docs/agent — Harness 文档索引

给在这个仓库里干活的人和 AI：验证怎么拆、证据去哪找、验过的步骤放哪。

| 文档 | 内容 |
|---|---|
| [ai-harness-principles.md](./ai-harness-principles.md) | 六原语：驱动、观测、判定、归因、取证、发现 |
| [issue-workflow.md](./issue-workflow.md) | 问题从发现到合入的完整走法 |
| [evidence-map.md](./evidence-map.md) | 出问题时去哪一层找哪份证据 |
| [acceptance-template.md](./acceptance-template.md) | 验收文档模板；新验收一律按它写 |
| [instruction-path-acceptance.md](./instruction-path-acceptance.md) | #186（ADR-0009 切片③b）：追问受理→命令入队→ack 结算 `instruction_state`（含拒绝理由落库、状态受理规则、幂等与授权不变量的 10 条用例） |
| [typecheck-coverage-acceptance.md](./typecheck-coverage-acceptance.md) | #178：`tests/` 纳入 typecheck 面（给**门**立档）——已接线 5 包 / 未覆盖 4 包及各自实测存量错误数、变异验证、接线护栏、`--if-present` 静默跳过风险 |
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

规矩只有一条：**验过就要留下**。验收步骤、探针跑法、上次结果、坑在哪，写进这里的 acceptance 文档；能直接复跑的脚本放 `scripts/`。只留在 `/tmp` 或对话里的验证，等于没验。

验收文档命名：`<链路或场景>-acceptance.md`，放在本目录，并在上表补一行索引。
