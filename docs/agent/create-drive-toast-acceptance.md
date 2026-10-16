# 指派驱动结果（#312）：创建任务时的执行命运如实告知 验收

- 对应场景/门禁：Q0（静态+单测）、Q5（真浏览器；新增 p1-312 冷启成套）
- 对应 Issue：#312（缺陷）、#239（指派即执行的产品面）
- 上次验证：2026-10-16 · `fix/p1-312-drive-toast-envelope` · 结果 PASS

## 验的是哪条用户路径

真人在项目页「创建任务」把责任人选成一个 Agent（或分给真人）：

1. 提交后**任务必须算创建成功**（201 不吞，落到刚建的任务里）；
2. 「这次执行到底有没有开始」必须如实告知——成功说已开始执行，设备离线/被拒/排队各说各话，
   不再把「受理了」说成「跑起来了」；
3. 自动执行失败后，用户进入的是**已经创建的那个任务**，在它的执行区准备环境后手动发起；
   重试发生在这个任务上，**不重开任务**。

缺陷本体（#312）：驱动结果 `drive` 在成功信封的**顶层兄弟位**（`{ ok, data, drive }`），
前端按 `data.drive` 读，`apiRequest` 又只回 `data` —— 于是那条 toast 恒不出现；而 web 用例的
fixture 把 `drive` 塞进了 `data`，两侧一起绿，缺陷漏网。

## 驱动（怎么触发）

```bash
# 静态与单测（Q0 的一半）
pnpm check

# 驱动结果与文案的两组单测（jsdom/unit）
pnpm exec vitest run --project unit apps/web/tests/api-envelope-siblings.spec.ts apps/web/tests/assignment-drive.spec.ts
pnpm exec vitest run --project web apps/web/tests/agent-assign.spec.tsx

# 真浏览器（真 Chrome + 真 Hub + 真 Node/Runtime replay）：Q5 新面
pnpm build                                   # 生产入口要 dist 包解析（harness 不绕包解析）
pnpm exec playwright test --project=p1-312   # apps/web/tests/e2e/task-create-drive.spec.ts
```

真人路径纪律：页面动作全走 UI（项目页表单 → 责任人下拉 → 提交 → Task Room 执行区）；
配对码签发与 Node 生命周期走既有旁路（HTTP + e2e-serve 控制面，与本仓 Q5 惯例一致）。

## 观测（看什么）

- **页面**：`.toast-item` 文本（成功/失败两支）；`/tasks/<id>` 落地 URL；Task Room 的 `.run-item`。
- **Hub HTTP**（判定事实，不驱动产品动作）：`GET /projects/:id/tasks`（任务数）、
  `GET /tasks/:id`（聚合里的 `runs`）、`GET /devices`（设备在线）。
- **wire 契约**：`apps/hub/src/modules/task/routes.ts` 的 `...(drive !== undefined ? { drive } : {})`
  ——`drive` 是 `data` 的兄弟；`drive.outcome ∈ {started_run, followup, queued, rejected, failed}`。

## 判定（成功长什么样）

先红（对未修代码，同一批用例/同一支 spec）：

| 面 | 红的样子 | 证据 |
|---|---|---|
| 单测（信封） | `api.mutateWithSiblings is not a function`；`assignment-drive` 模块缺失 | `artifacts/evidence/p1-312/red-unit.txt` |
| 组件（jsdom） | 4 条 toast 用例失败（drive 被丢，什么都不弹） | `artifacts/evidence/p1-312/red-web.txt` |
| 真浏览器 | 落地的任务页上 `.toast-item` **元素都找不到**（#312 的原始现象） | `artifacts/evidence/p1-312/e2e-red-main.txt` |

后绿：

| 编号 | 判据 | 结果 |
|---|---|---|
| D1 | 成功信封的兄弟字段与 `data` **分开**交回：`siblings.drive` 有值、`data.drive` 恒为 undefined；无兄弟字段时是空对象 | PASS（`api-envelope-siblings.spec.ts` 3 条） |
| D2 | 五种命运各一句如实的话：只有 `started_run` 能说「已自动开始执行」；`queued`/`rejected`/`followup` 都不是；`failed` 带错误码与恢复入口；未知形状不收窄（页面因此不说话） | PASS（`assignment-drive.spec.ts` 5 条） |
| D3 | 组件面：失败分支 toast =「自动执行未开始（DEVICE_OFFLINE）…可在任务执行区手动发起」；排队分支不得出现「已自动开始执行」；分给真人（无 drive）不弹执行 toast | PASS（`agent-assign.spec.tsx` 9 条） |
| D4 | 真浏览器·设备离线：任务仍创建成功（项目任务数=1，URL 落在该任务），toast 带 `DEVICE_OFFLINE` 与恢复入口，该任务**没有 Run**（不谎报执行） | PASS |
| D5 | 真浏览器·失败后恢复：配对真 Node 后在**原任务**执行区手动发起 → Run 真起来，项目任务数**仍是 1** | PASS |
| D6 | 真浏览器·设备在线：toast 说「任务已创建，Agent 已自动开始执行」，Task Room 聚合里真的出现 Run，任务数=2 | PASS |
| G0 | `pnpm check` 全绿（含排版门；首轮红在两处格式，已 oxfmt） | PASS（`q0-check.txt`） |

没数据/缺一环必须 FAIL：D4 的「没有 Run」与 D5 的「任务数不变」都是显式断言，
不是「没报错就算过」。

## 归因（失败先看哪层）

- toast 不出现 → 先看 `web.api` 层的信封读法（是否又只回了 `data`）→ 再看
  `web.assignment` 的收窄与文案 → 最后才是 toast 通道本身（`web.toast`）。
- 任务没被创建 / 落错地方 → `hub.task` 的 201 与 `web.route` 的落点。
- 起了 Run 但没动 → `hub.run` → `node.ws` → `runtime.bridge`（本 Issue 不含，见 evidence-map）。
- 具体路径见 [evidence-map.md](./evidence-map.md)（本面本轮新增一行）。

## 取证

```bash
# 脱敏证据（本地包，不进 git：artifacts/evidence/ 已 ignore）
ls artifacts/evidence/p1-312/
#   red-unit.txt red-web.txt e2e-red-main.txt e2e-run2.txt q0-check.txt build.txt
scripts/secret-scan.sh artifacts/evidence/p1-312
```

证据里不记账号口令、Cookie、配对码、设备绝对路径；原始 Playwright trace 一律不入包
（标准配置 `trace: retain-on-failure`，失败面只有文本日志）。

## 边界与未覆盖

- `followup` / `queued` / `rejected` 三档**在新建任务路径上不可达**（新建任务无活跃 Run；
  三档来自 Hub 共用的 `sendInstruction` 受理结果类型）。它们的文案与收窄由单测钉住，
  真浏览器只走 `started_run` 与 `failed`（这两支才是创建路径的真实分布）。
- 真浏览器判据只覆盖「设备未配对」这一种离线成因；`设备已撤销` 是 Hub 侧同一错误码的
  另一条成因，由 hub 集成用例（`agent-assign.integration.spec.ts`）与 #314 的重指派面覆盖。
- 超时重试与连点的**不重复创建**不在本 Issue：本 Issue 钉的是「恢复不重开任务」；
  连点/超时的幂等归创建→恢复生产验收（C 段）。
- Runtime 真模型执行质量不在范围（replay 适配器无真实模型）。

## 复跑

```bash
git checkout fix/p1-312-drive-toast-envelope
pnpm install --frozen-lockfile && pnpm build
pnpm check
pnpm exec playwright test --project=p1-312
```
