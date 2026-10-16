# 创建到恢复（#345）：五条路径的生产验收

- 对应场景/门禁：Q0（静态+单测）、Q2（Hub 侧幂等回执与受理不变量的集成面，本轮复跑记录见下）、Q5（真浏览器；新增 p1-345 冷启成套）
- 对应 Issue：#345（本验收）、#312（驱动结果如实表达）、#344（责任人与执行拆分）、#239/#337/#338（复用的既有面）
- 上次验证：2026-10-16 · `feat/p1-345-create-recovery` @ `4298922`（含评审修复）· 结果 PASS（7 passed；verdict PASS，33 条判据）

## 验的是哪条用户路径

「创建任务」这一端到端走法，五条：

1. **只创建任务，不产生执行**：分给真人 → 待接受、零 Run、不弹执行 toast；连点也只有一个创建请求。
2. **分给别人，对方接受后再执行**：对方登录 → 接受 → 在**自己的**设备与工作目录发起（Run owner 与设备都归对方）。
3. **自己明确选择 Agent，创建并执行**：责任人恒为创建者、任务出生 accepted、自动起 Run；Run 归创建者、用创建者自己的现场。
4. **创建成功但启动失败 → 进入原任务准备环境后继续**：设备离线时任务已创建、零 Run、toast 带 `DEVICE_OFFLINE` 与恢复入口；配对真 Node 后**在同一个任务**的执行区手动发起（任务数不变）。
5. **连点 / 超时重试 / 成员状态变化**：不重复创建（同义幂等键 + Hub 回放）；不静默改投（请求里仍是用户选的人、Hub 4xx 拒绝、重选后成功）。

## 驱动（怎么触发）

```bash
pnpm install --frozen-lockfile && pnpm build      # 生产入口要 dist 包解析（harness 不绕包解析）
# 一条命令走完：先删旧 result（上一次的 PASS 不作数）→ 跑 e2e → 失败即作废 → 独立判定器
pnpm exec tsx scripts/run-create-to-recovery.mts
# 它已接进 Q5 门：`pnpm test:e2e` 链里的这一环就是它——绿门绕不开独立判定。
```

环境是正式装配：真 Hub（`server.ts` 生产入口）＋ 真 Node ＋ 真 Runtime（DSH replay，`basic`
夹具让 Run 干净跑完）。账号开通/配对码走 HTTP 旁路（配对 UI 真人路径由 p1-142 覆盖），
Node 生命周期走 e2e-serve 控制面（只做进程，不做产品动作）。**环境里同一时刻只有一台 Node**
（控制面只带一个 node 子进程）——所以用例按序换设备：先无设备，再换到 Alice，最后换到 Bob。

## 观测（看什么）

产出侧只写**离散事实**到 `artifacts/evidence/create-recovery/result.json`：任务事实取自
`GET /projects/:id/tasks` 与 `GET /tasks/:id`（聚合里的 Run），Run 的归属与现场取自
`GET /runs/:id`（owner 视角的 `ownerUserId/deviceId`）与双方各自的 `GET /devices`；
幂等键与请求体由 Playwright 在网络层截取，响应状态由 `page.on('response')` 观测。

判定侧在 `scripts/lib/create-recovery-evidence.ts`（CLI：`scripts/verify-create-recovery-evidence.mts`），
**只重判那份事实**：33 条判据，缺一段、类型不对、自相矛盾都 FAIL。

诚实的边界：判定器是「对**自报事实**的独立重判」，不是独立观测——它不自己连 Hub 重查。
它挡得住写错、写漏、自相矛盾（本页两次实测都是它抓的），挡不住「产出侧把该断言的地方整段删掉
还照样写出自洽 JSON」。因此关键事实都尽量**从观测推导**而非字面量：drive 的结果取自响应体里的
兄弟字段、幂等重放比对两次响应的任务 id、恢复是否落在原任务由两份任务列表比对得出。

## 判定（成功长什么样）

先红（TDD，改动随实现一起提交，红的样子留在证据里）：

| 面 | 红的样子 | 证据 |
|---|---|---|
| 幂等键（jsdom） | 「重试同意图复用同一把键」在改前是红（每个请求各拿一把随机键） | `artifacts/evidence/p1-345/red-idempotency.txt` |
| 端到端（真浏览器） | 首轮跑出 3 处自报/实现问题：fixture 设置时机、拒绝对照读成恢复那次的 201、错误码不在 DOM 里 | `e2e-run1.txt` / `e2e-run2.txt`（当前绿：`e2e-run4.txt`） |
| 判定器自身 | 10+1 条正负控（含「5xx 也 FAIL」），缺证据/说假话/静默改投逐类 FAIL | `pnpm exec vitest run --project unit scripts/lib/create-recovery-evidence.spec.ts` |

后绿（本轮实测）：

| 编号 | 判据 | 结果 |
|---|---|---|
| C1 | 路径 1：分给真人的任务 `pending`、零 Run、无执行 toast；连点只发 1 个创建 POST | PASS |
| C2 | 路径 5a：两次尝试同一把幂等键、只建出 1 个任务 | PASS |
| C3 | 路径 5b：责任人失效后**提交前**即被阻塞（可见提示 + 按钮禁用），失效期间零请求、零任务；重选后成功且带回的是重选的那个责任人 | PASS（评审修复：原先只靠 Hub 400 兜底，页面上是一句英文分类消息——已改为客户端先拦，见 #348） |
| C4 | 路径 4：`DEVICE_OFFLINE` 时零 Run；恢复在**原任务**上（任务数不变）、Run 归责任人、用责任人的设备 | PASS |
| C5 | 路径 3：驱动 `started_run`、任务 `accepted`、Run 归创建者且用其设备、只建 1 个任务 | PASS |
| C6 | 路径 2：对方接受后 `accepted`、Run 归对方、设备属于对方且不在创建者名下、不新建任务 | PASS |
| C7 | 独立判定（经 runner，已接进 Q5 门）：`{"verdict":"PASS","checks":33}` | PASS |
| C8 | 判定器有牙：负控 12 条随 `pnpm check` 跑（缺段/说假话/重放没验到/工作目录用错人逐类 FAIL）；另对**真实证据**做过一次变异（`executionToastCount→1`、`runsAfterFailure→1` → 各 FAIL 且指名，命令见下） | PASS |
| Q2 | Hub 侧创建幂等回执的集成面复跑（`apps/hub/tests/agent-assign.integration.spec.ts`） | PASS（`artifacts/evidence/p1-345/q2-agent-assign.txt`） |
| G0 | `pnpm check` 全绿（首轮红在两处 typecheck/排版） | PASS |

真实证据变异的复跑命令（把判定器当黑盒用）：

```bash
python3 -c "import json;d=json.load(open('artifacts/evidence/create-recovery/result.json'));d['paths']['createOnly']['executionToastCount']=1;json.dump(d,open('artifacts/evidence/create-recovery/mut.json','w'))"
pnpm exec tsx scripts/verify-create-recovery-evidence.mts artifacts/evidence/create-recovery/mut.json  # 期望 FAIL + 指名
```

**判定器抓到过的真问题（不粉饰，两次同类）**：第一次跑判 FAIL——`hubStatus` 记成了恢复那次提交
的 201；评审修复后又判 FAIL——`requestsWhileStale` 记成了恢复提交之后的计数。两次都是
「取证时点写晚一格」。这正是「产出侧自报 + 判定侧独立重判」要抓的东西，已按实测修正。

## 归因（失败先看哪层）

- 任务没建出来 / 建出两个 → `web.api` 的幂等键与 `hub.task` 的 `task.create:<key>` 回放。
- 建了但执行没起 → `hub.run` 的 `instruction-target` 三段式解析（`DEVICE_OFFLINE` 的四种成因）
  → `node.ws` → `runtime.bridge`。
- 执行起了但归错人/错设备 → `hub.run` 的 owner 与 target 固化，对照 `GET /runs/:id` 与
  `GET /devices`（双方各看一次）。
- 恢复重开了任务 → `web.route` 的落点与执行区的 task 身份。
- 分层的完整索引见 [evidence-map.md](./evidence-map.md)。

## 取证

```bash
pnpm exec tsx scripts/redact-evidence.mts artifacts/evidence/create-recovery artifacts/evidence/p1-345
scripts/secret-scan.sh artifacts/evidence/create-recovery   # 期望：OK 未命中
ls artifacts/evidence/create-recovery/ artifacts/evidence/p1-345/
#   result.json  mutation-*.json  mutation-verdicts.txt   /   e2e-run{1..4}.txt  red-idempotency.txt
```

证据里不记账号口令、Cookie、配对码、设备绝对路径与草稿正文；原始 Playwright trace 不入包
（只留失败文本与判定结果，`test-results/` 每轮清掉）。

## 独立评审驱动的修复（第一轮两条意见的处置）

堆叠的三支 PR 由两名独立评审读过一遍，按意见改完并各自留判据：

| 意见 | 处置 | 判据 |
|---|---|---|
| 路径 5a 的「重试不重复创建」在旧写法下**验不到 Hub 回放**（第一次请求根本没到 Hub，`tasksCreated=1` 空真） | 第一次请求改为 `route.fetch()` **真的落库**、响应换成 504 交给页面；重试断言两次响应是**同一个任务 id** | 证据新增 `firstAttemptReachedHub` / `replayedSameTask`，判定器要求两者为真（负控：改成 false 即 FAIL） |
| 所选责任人/Agent 离开名册时：触发器显示成「未选择」而提交仍带旧值，页面只给英文分类消息（Hub 400） | 提交前**显式阻塞**（`selection-unavailable-hint` + 按钮禁用，零请求），开关禁用原因改为**可见提示**（不只 `title`），并修掉「加载中就说没有 Agent」 | jsdom 一条（经真实 `member.changed` 帧触发重拉，零 POST）+ 真浏览器路径 5b（零请求、重选后成功） |
| 开关禁用原因挂在 `title` 上（键盘/读屏够不着）；点标签文本的命中区只有 jsdom 近似 | 原因进可见提示；真浏览器补一条「点文本开开关且只翻一次」 | p1-312 断言 `aria-checked` 翻转；jsdom 断言不双触发 |
| `driveCode`/`driveOutcome` 等是产出侧写死的字面量，判定器等于自证 | 关键事实改从**观测推导**：drive 取响应体兄弟字段、`executionToastCount` 取实测条数、`recoveredInSameTask` 由两份任务列表比对 | 判定器把 `firstAttemptReachedHub`/`replayedSameTask` 设为必填；产出侧无字面量可写 |
| 判定器没接进任何门：`pnpm test:e2e` 绿仍可能 verdict FAIL | 新增 `scripts/run-create-to-recovery.mts`（先删旧结果 → 跑 e2e → 失败作废 → 判定器定退出码），`test:e2e` 改走它 | runner 自证：绿时 verdict PASS；e2e 失败时结果文件被删（后续判定无从背书） |
| `client.ts` 头部注释仍说「Hub 对重复 key 返回 IDEMPOTENCY_CONFLICT」（与重放语义相反） | 注释改为「重放首次结果；IDEMPOTENCY_CONFLICT 今天不可达」 | 与 03 文档「幂等」节一致；C 的新代码注释依赖重放语义 |
| 文档层：PR 号写错（#346/#347 → #349/#350）、试用包基线标签写反、A 页的 UI 路径已死、`unified-execution` 的「后续可独立设计」已落地 | 逐条改正/加指针；证据重新归约 | 本页与 A 页、试用包、计划文档的改动都在本 PR 里可逐条核对 |

## 边界与未覆盖

- **同一时刻只有一台 Node**（控制面约束）：路径 2 的「对方的环境」是先停掉创建者的 Node 再用
  对方的配对码起一台新 Node 得到的（同一台机器、两个设备身份）。副作用：路径 3/4 的
  「用了责任人的设备」在单设备下接近于恒真（环境里只有那一台）——它挡得住「用错人的设备」，
  但挡不住「设备解析退化成只用唯一在线设备」。跨机部署下的解析判据不在本轮。
- **Agent 归档**没有 HTTP 端点（只能靠既有 UI 过滤），因此「Agent 状态变化」只验了**成员停用**
  这条真实可驱动的路径；Agent 侧由 `selectableAgents` 过滤 + Hub 400 兜底（未端到端验）。
- 真浏览器判据都基于 **replay** 夹具（无真实模型）：执行质量、耗时与费用不在本轮。
- Run 的**终态收尾**只覆盖路径 3 与路径 4 后半（等 `completed` 再换设备）；路径 2 的 Run 只判到
  「起来、归对方」就结束（不等到终态），路径 1 按定义零 Run。真实模型下的长跑与审批交互由 p1-19 覆盖。
- 真人可用性（是否理解「创建 ≠ 执行」）**仍未观测**：见 `operation-flow-usability-trial.md`（not_run）。

## 复跑

```bash
git checkout feat/p1-345-create-recovery
pnpm install --frozen-lockfile && pnpm build
pnpm check
pnpm exec playwright test --project=p1-345
pnpm exec tsx scripts/verify-create-recovery-evidence.mts artifacts/evidence/create-recovery/result.json
# 期望：7 passed；verdict=PASS（checks=31）；若任一事实缺失或自相矛盾则 exit 2
```
