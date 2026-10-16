# 创建任务表单拆分（#344）：责任人与「创建后执行」 验收

- 对应场景/门禁：Q0（单测/typecheck/排版/边界）、Q5（真浏览器；p1-312 与邻域五项目回归）
- 对应 Issue：#344（本验收）、#312（同一表单的驱动结果面）、#239（指派即执行）
- 上次验证：2026-10-16 · `feat/p1-345-create-recovery` @ `4298922`（含评审修复）· 结果 PASS
- 落地位置：B 的行为随 PR #349 合入；**评审修复**（失效责任人的提交前阻塞、开关禁用原因的可见提示、
  真浏览器命中区判据）随验收批次 PR #350 落地——本页同时记录两段，判据逐条注明落在哪一边。

## 验的是哪条用户路径

真人在项目页「创建任务」：

1. 默认只创建任务：责任人只列真人、默认自己；「创建后立即执行」关着，按钮是「创建任务」，
   请求只带 `assigneeUserId`；
2. 要立即执行：打开开关 → 出现「执行 Agent」栏、按钮变「创建并开始执行」，请求只带
   `assigneeAgentId`（责任人恒为创建者、出生 accepted、Hub 自动驱动——#239 的语义一条没动）；
3. 分给别人：开关禁用并说明「对方需要接受任务并安排执行（用他本人的环境）」；
   开着执行改选别人 → 开关自动关闭并清掉已选 Agent（**不静默改投**）；
4. 命中区：整行是 label，点文本也能开关，且只翻一次（鼠标与键盘都走同一条 onChange）。

## 驱动（怎么触发）

```bash
pnpm install --frozen-lockfile && pnpm build
pnpm check                                            # 含 agent-assign.spec（jsdom 16 条）
pnpm exec playwright test --project=p1-312            # 真浏览器：开关路径 + 两态截图
pnpm exec playwright test --project=p1-07             # 邻域回归：创建任务表单（键盘路径）
pnpm exec playwright test --project=p1-19             # 全链（表单 + 双人）
pnpm exec playwright test --project=p1-158            # 下拉落页审计（责任人触发器）
pnpm exec playwright test --project=p1-314            # 拒绝后重指派（同一表单）
pnpm exec tsx scripts/run-preparation-return.mts      # 准备往返（隔离端口，p1-315）
```

## 观测（看什么）

- jsdom：`screen.getByRole('switch', { name: '创建后立即执行' })` 的 `aria-checked` 与 `disabled`；
  提交体（`assigneeUserId` / `assigneeAgentId` 互斥）；`data-testid="execute-now-hint"` /
  `"execute-now-reason"` / `"assignee-member-hint"` / `"selection-unavailable-hint"`；
- 真浏览器：`form[aria-label="创建任务"]` 内的 switch/两个下拉/按钮文案；两态截图
  `artifacts/evidence/create-form-split/create-task-form-{off,on}.png`（**给人复核版面**，
  判定仍靠断言）；任务与 Run 的事实经 `GET /projects/:id/tasks` 与 `GET /tasks/:id`。

## 判定（成功长什么样）

| 编号 | 判据 | 结果 |
|---|---|---|
| B1 | 责任人下拉只列真人（归档/停用不进；Agent 已从这一栏退出） | PASS（jsdom） |
| B2 | 默认关闭：按钮「创建任务」，只带 `assigneeUserId`；分给真人时无执行 toast | PASS（jsdom） |
| B3 | 开启后：按钮「创建并开始执行」、未选 Agent 不可提交、只带 `assigneeAgentId`（互斥） | PASS（jsdom） |
| B4 | 分给别人：开关禁用 + 说明；**开着执行改选别人 → 显式关闭并清空 Agent** | PASS（jsdom） |
| B5 | 命中区：点标签文本也能开关且只翻一次（jsdom：转发 + 不双触发） | PASS（jsdom） |
| B6 | 没有可用 Agent：开关禁用，且原因是**可见提示**（不只挂在 `title` 上） | PASS（jsdom，评审修复） |
| B7 | 责任人失效（表单开着时被停用 → `member.changed` 重拉名册）：提交前显式阻塞、**零请求**、零任务；重选后成功 | PASS（jsdom + 真浏览器，见 create-to-recovery 路径 5b） |
| B8 | 真浏览器走开关路径完成离线失败/原任务恢复/在线成功三条链（含点文本开开关） | PASS（p1-312，3 passed） |
| B9 | 邻域五项目回归（p1-07/p1-19/p1-158/p1-314/p1-315） | PASS（各 1 passed，证据 `artifacts/evidence/p1-344/`） |
| G0 | `pnpm check` 全绿 | PASS（1644 passed + 7 expected fail） |

复跑的判据命令与证据目录见上；证据已 `redact` 并过 `scripts/secret-scan.sh`。

## 归因（失败先看哪层）

- 按钮文案/开关状态不对 → `web.form`（本页的 `CreateTaskForm`）与 vendored `Switch` 的 `aria-checked`；
- 请求体形状不对 → `web.api` 的提交体构造（互斥三元）→ `packages/protocol` 的 superRefine 400；
- 责任人/Agent 列表缺项 → `web.team`（名册 queryKey）与归档过滤 `archivedAt`；
- 真浏览器里开关点不动 → label 转发（本页的 `.field-switch`）与 vendored CSS 的 `pointer-events`。
- 完整索引见 [evidence-map.md](./evidence-map.md)。

## 取证

```bash
pnpm exec tsx scripts/redact-evidence.mts artifacts/evidence/p1-344 artifacts/evidence/create-form-split
scripts/secret-scan.sh artifacts/evidence/p1-344        # 期望：OK 未命中
ls artifacts/evidence/create-form-split/                 # 开关关/开两态截图（给人看，不作判定）
```

## 边界与未覆盖

- 开关沿用 vendored `Switch` 的 36×20 轨道（改尺寸要动 vendored 文件，ADR-0008 §3 禁改）；
  命中区靠整行 label 补（jsdom + 真浏览器各一条判据），**触屏体感留真人试用**。
- 「Agent 归档」没有 HTTP 端点，端到端只验了成员停用那条真实路径；归档侧由 `selectableAgents`
  过滤 + Hub 400 兜底（jsdom 里以「不在可选集合」等价验证）。
- 审批档位与受理/环境归属规则**未在本页重验**：本页只做界面拆分，服务端一字未改；
  语义不变由 create-to-recovery 的五条路径与既有 approval 面覆盖。

## 复跑

```bash
git checkout main && git pull        # 合入后
pnpm install --frozen-lockfile && pnpm build
pnpm check
pnpm exec playwright test --project=p1-312 && pnpm exec playwright test --project=p1-07
# 期望：3 passed / 1 passed；证据在 artifacts/evidence/create-form-split 与 p1-344
```
