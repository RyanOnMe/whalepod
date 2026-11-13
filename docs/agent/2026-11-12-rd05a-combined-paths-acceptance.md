# WhalePod RD-05a：快慢路径组合生产验收

- 对应 Issue：#546；前置为 RD-02b、RD-03d3、RD-04b/c1/c2；#545 工具错误补验已合入 `f31ca0f`。
- 对应门禁：required `integration` 中的生产装配验收、独立判定与证据负控；不替代 Q2/Q6/Q7。
- 更新日期：2026-11-13。
- 上次验证：`not_run / 待本轮结果`；本轮 commit、attempt、结果与总耗时待主协调提供机器证据后登记。不把前置通过、构建成功或旧报告写成本轮通过。

## 验的是哪条用户路径

两名成员围绕同一 Project 正常讨论。既有场地工作通过有效订阅收到补充，初始执行结束后在终态边界自动续接；快路径稳定后，再冻结发现目录，由另一成员的普通筹备评论发现未覆盖的新工作。系统按预授权立项，责任人显式确认精确来源和 Executor 后才执行，得到责任人私有草稿。

整轮只启动一套真实 PostgreSQL、Hub、Node 和独立 DSH Runtime 生产包装配；业务动作走生产 HTTP/WS，查询数据库仅采集事实，禁止直写运行时状态。只替换模型 HTTP 响应为本机回环回放，不套跑旧验收或拼接旧报告。

正向严格三条 Run，角色分别为 `bootstrap`、`continuation`、`discovery`。正向收口后，在同装配、同 Project 下另建来源、Task、Work 和执行授权，运行隔离的第四条负向 Run；它不混入三条正向计数。

## 驱动（怎么触发）

三个 CLI 都必须显式传入同一个 result 路径，不允许省略参数、回落默认报告或查找 latest。driver 要求路径严格为 `artifacts/evidence/rd05a/<当前完整 HEAD>/<UUID>/result.json`，目录 UUID 即 `campaignId`；attempt 必须不存在，由 driver 独占创建，已有目录拒绝覆盖。先提交本轮 harness 并构建生产包，提交只由主协调按本轮授权执行。

```bash
pnpm -r --if-present build
head=$(git rev-parse HEAD)
attempt=$(node -e 'process.stdout.write(require("node:crypto").randomUUID())')
result="artifacts/evidence/rd05a/$head/$attempt/result.json"
pnpm exec tsx scripts/run-rd05a-acceptance.ts "$result" &&
  pnpm exec tsx scripts/verify-rd05a-acceptance.ts "$result" &&
  pnpm exec tsx scripts/check-rd05a-evidence-negatives.ts "$result"
# 上传或分享前，只扫描这个 attempt；命中即拒绝出包。
scripts/secret-scan.sh "$(dirname "$result")"
```

driver 内部自检不替代独立 checker；CI 必须另起 CLI 重判，之后运行 negatives。driver 失败时不得拿旧 result 补位。

## 观测（看什么）

- `attempt.json`：本轮 `campaignId`、commit、harness/assembly 指纹与启动时间。
- `result.json`：两成员/Project 身份、三条正向 Run、隔离负向、阶段检查点、来源精确版本/摘要/授权代次、清单、交付/读取回执、消费记录、候选下载状态与人工动作分类。
- `events.jsonl`：`acceptance.campaign` 阶段、`hub.work_input` 实际回执、`acceptance.replay` 实际模型工具消息、`hub.run` 生命周期和 `acceptance.snapshot` 运行状态。按 `campaignId/runId/receiptSeq/callId/executionId` 关联，不靠控制台 PASS 文本。
- provenance 同时绑定当前 commit、harness、生产 assembly 与事件原字节摘要。独立判定不能只相信 driver 写出的计数或结论；缺字段、缺事件、错身份或指纹漂移均失败。
- 两条 fast Run 的 ready/completed 必须分别具备 owner/project 两种生产投影，共八行，按 Run/type/audience 精确配对；实际执行授权独立核对固定回环 Executor 与规范摘要；每组 reserved/settled 的原预留 token/金额必须一致。

## 判定（成功长什么样）

### 既有工作的快入口与终态边界

1. 初始设置经生产 PATCH 显式启用已确认约定绑定，并计入 setup；只确认但不启用的 Task 不会自动绑定 `specRevisionId`，不得从期望值补造。有效订阅将补充评论直达唯一收件箱条目；同幂等键评论重放不增加来源或条目。入口准入为 `deliver/subscription_match`，`routerInvoked=false`，入口 Router 调用/评估与新增 Run 均为零。
2. bootstrap 固定清单不被补充改写；补充保持 pending，只有下一条 continuation 固定新清单并真实读取。交付不等于消费，Hub 回执、持久消费和实际模型工具结果摘要必须逐件对上。
3. **快入口零 Router 不等于终态边界零 Router**。两次终态边界分别有 Router 评估：第一次 `dispatch` 自动产生唯一 continuation，第二次 `wait` 收口，不再多建 Run。不能把两次边界评估误记为入口慢路径。
4. 首次候选由人发布，作为第二成员可读的公开对照及后续发现佐证；continuation 候选保持未发布，责任人下载 200、第二成员 404。

### 新工作的发现与精确执行授权

1. 快路径两条 Run 与第二次边界 wait 收口后才冻结 catalog 并核实未覆盖槽位，不能在快链仍写入目录时提前冻结。普通筹备评论触发发现、幂等立项为新 Task/派生约定/Work，不能由 driver 手建目标工作替代。最终负控收口后另观测 2.5 秒稳定窗，同 Project 全部 Task/Run/evaluation 身份集合前后必须相同；这是最终防自激判据，不冒充 catalog 冻结前的额外稳定窗。
2. 新工作授权前为零 Run。责任人显式确认固定来源包的精确身份、版本、摘要、授权代次及 Executor 路由；非责任人 404、错误账户 409。同键并发及重复确认复用一条执行授权，自动派工且只建一条 discovery Run。
3. 该显式 exact 执行授权是实际人工动作成本，不得写成全程零人动。setup、bootstrap、发布、catalog 核实、执行授权、撤回/更正与负向动作分别记账；模型请求和自动派工不冒充人工效率测量。
4. Runtime 实际读到两份冻结来源，模型下一请求含同一来源的真实工具结果；工具头中的 inbox/source/version/type/byteSize 与真实 assistant/tool call 历史一并校验。下载成功、摘要碰巧相同或来源换版均不能替代读取证据。回环场景的 `liveOnlyGrantCount=0`，不声称重新验证了真实出站时每个来源作者/拥有者的 live-only grant。
5. 第四条负控开始前，责任人经正常约定草稿/确认接口给正向新 Work 补充可读范围，并在新发现配置中纳入此约定；两次维护操作记入负控 setup，不伪称自动派生约定等于真人已确认。WS 公开哨兵放在这个已有 Work、无订阅的 Task，而非发现入口；责任人的 permit 本身已含来源同意，不能假定其评论不会触发发现。

### 私有候选、工具错误与撤权

1. 普通候选正文沿既有 owner-only 内容策略判定，**不等于**发现执行的标题、终态回复及工具错误已满足更强隔离。后者单独使用成员 HTTP、实时 WS、历史重放三面非空观测和公开对照；成员仍可见允许的状态，但私有标题/最终答复/错误标记不得泄漏。
2. 工具错误复用 c2 真实 Runtime 的未知 ID `read_work_input` 路径；不是回放伪造错误文本。下一模型请求必须收到精确 `callId`、tool role 和完整错误结果摘要，之后才继续产出候选。缺失、错配、重复或仅删事件再重算摘要均必须被 checker/negatives 拒绝。
3. discovery 草稿责任人下载 200、另一成员 404，缓存为 `private, no-store`，正式发布拒绝。撤回执行授权后责任人下载也变为 404，任务读面不留被撤回私有标题。子进程退出后两个私有目录清理，登记 Workspace 不留草稿。
4. 隔离第四 Run 在两份来源送达、首次工具读之前，由来源作者调用**生产 HTTP correct** 更正评论；允许初始模型请求已发出，但要求零成功读取、零后续模型请求、零草稿，Run 失败或取消、授权收口，私有目录清理。不能用未送达、无 Run 或只改模拟状态充当负控。

## 归因（失败先看哪层）

| 现象 | 先看 |
|---|---|
| 补充未直达、重复投递或入口误调 Router | `hub.work_entry` 准入与 `hub.work_subscription` → inbox 身份；对照 `fast.supplement` 的入口零调用事实 |
| 终态不续接或多建 Run | `hub.dispatch` 的 boundary/intent → `hub.router` 两次评估及应用 → `hub.run` 三角色与阶段检查点 |
| 发现目录漂移、立项后不能执行 | `hub.discovery` 的 catalog、application、execution 与来源精确版本；对照快稳定/发现创建阶段 |
| 已送达却无正文读取 | `node.work_input` → `hub.work_input` 回执与消费 → `acceptance.replay` 的实际工具消息摘要 |
| 标题、终态、错误泄漏或撤回仍可下载 | `artifact.store` 与成员 HTTP/WS 三面事实；先确认公开对照/非空观测，再对私有标记与撤回状态 |
| 首读前更正仍读/发请求/写稿 | `hub.discovery` 的 correct/授权收口 → Node/Runtime 撤权 → `revokeBeforeRead` 和对应回执/事件 |
| 取到旧报告或当前 checker 拒绝旧证据 | 本次 HEAD/UUID 路径、`attempt.json` 与 provenance；不得改写旧包来适配新 harness |

## 取证与 required CI

本次独占目录为 `artifacts/evidence/rd05a/<commit>/<attempt>/`，同目录保存 `attempt.json`、`events.jsonl`、`result.json`；失败时保留脱敏 `failure.log`，不得把失败包改称 PASS。证据只留不透明身份、摘要、状态和计数，不留私有正文、凭据、绝对路径或完整 DSH Session。

`.github/workflows/check.yml` 的 required `integration` 保留既有 Router/c2 链路，追加顺序为：预生成当前 checkout HEAD/新 UUID 路径 → driver → 只定位该路径并核对 marker/result 绑定 → 独立 checker → negatives → 该 attempt 的 secret-scan → upload。没有结果、身份不符、checker 或 negatives 失败均使 job 失败，不使用 `continue-on-error`。扫描及上传用 `always()` 保留失败诊断，但只在本 attempt 存在且扫描成功后上传，中性 artifact 名不代表通过；不得扫描/上传整个 rd05a 根目录替代本轮。

历史 c2/c3 封存证据（包括原真实批次及 #545 补验）保持原字节；不重签、不重算旧指纹、不搬入本次路径。#545 已合入不代表供应商对账已完成，更不代表 RD-05a 已通过。

## 边界与未覆盖

| 项目 | 本轮状态/口径 |
|---|---|
| 组合生产回放、独立 checker、negatives、敏感扫描 | `not_run / 待本轮结果` |
| Ubuntu required integration（含取证上传） | `not_run / 待本轮结果` |
| 费用 | 仅回环模拟账本；两条 fast Run 各有普通 Executor reserved/settled，Router 两次、正向 discovery 一次、负向 discovery 一次各有 coordination reserved/settled。正向私有执行六次/负向私有执行一次请求为 `loopback_unmetered`，不进普通 ledger 或 live 专用 dispatch/attempt；这些是源码判据，实际本轮数值待验。无 paid 供应商请求（目标 `paidRequests=0`）不等于零模型请求或零费用，不能当成真实 token/扣费对账 |
| 供应商账单/扣款对账 | `not_run`；公开价格、旧 c3 token 或 #545 合入均不能代替账单证据 |
| 真实出站逐来源 live-only grant 重验 | `not_run`；本轮不出网，不扩张为 RD-04c3 live 覆盖 |
| 正式阅稿、飞书接入 | `not_run` |
| 真实模型判断/产稿质量、真人效率 | `not_run`；确定性回放和人工动作计数不构成质量或效率结论 |

## 复跑结果与耗时预算

从上方命令重新生成独占 attempt；只用这一份 result 复跑独立判定和负控，不能覆盖既有 attempt。主协调提供机器结果前，commit/attempt、四阶段计数、各 CLI、扫描、CI 及耗时均保持 `not_run / 待本轮结果`。

2026-11-12 主协调已通知的前置验证单列如下，不外推为组合 campaign 通过。

| 验证 | 已通知结果 |
|---|---|
| 生产包 `pnpm build` | PASS |
| 定向 integration 五文件 | 124/124 PASS，34.90 秒 |
| c2 57 项 + replay 32 项 | 合计 89 项 PASS |
| discovery helpers/live-fences | 9 项 PASS；不等于本轮启用 live 策略或真实出站 |
| 稳定窗/来源 digest 定向 spec | 265 项 PASS；accounting 最后补丁仍在进行，最终定向回归待本轮结果 |
| 旧封存证据 | 十份 hash 保持不变，不改写旧原件 |
| 全仓 `pnpm check` | `25dc9a0` 实现提交前的完整门已 PASS；评审修复后仍需重跑，不能转签为最终 head 通过 |
| RD-05a driver / checker / negatives 与完整 CI | `not_run / 待本轮结果` |

首个组合 attempt（`25dc9a0`，`2aa22c93-6138-48ea-b0b0-ac86aa5963ac`）失败，未保留成功 result：公开哨兵错误放入发现入口触发额外发现，后续新目录又缺正向新 Work 的可读约定。诊断封存在该 attempt 的 `failure.log`；不覆盖失败包，不以旧 c2 报告补位。后续修复同时补 actual admission 外键、实际工具头身份、负控精确来源与 harness 源码依赖封闭性，须另建新 attempt。

本地 `purpose=inference` 协调求值是生产自动生成的无模型推断，单独披露身份、终态与 `modelStarted=false`，不与四次 Router/discovery 模型评估混算；稳定窗覆盖两类全部身份，不忽略额外模型调用。

当前 integration timeout 为 **25 分钟**，既有总耗时 **17 分 22 秒**，可用余量 **7 分 38 秒**。该数字是既有链路基线，不是 RD-05a 新增耗时。先保留 25 分钟；待完整 CI 测得 driver、checker、negatives、扫描和上传及全 job 总耗时后，按实际总耗时与合理波动余量调整。不得只看本机 driver、无证据缩短 timeout，或以超时为由把组合验收挪出 required integration。
