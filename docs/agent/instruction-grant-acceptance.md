# 指令权授权验收（P1-198 切片④：责任人 ∪ 被授权成员）

- 对应门禁：Q0（静态）+ Q2（真实 PostgreSQL 集成）
- 对应决策：ADR-0009 决策 4；边界与 ADR-0010 相邻（讨论区不受影响）
- 上次验证：2026-09-14 · `feat/p1-198-instruction-grant`（④a）+ `feat/p1-198b-instruction-grant-api`（④b）· PASS

## 验的是哪条链路

「谁能驱动 Agent」从**责任人独占**变成**责任人 ∪ 被授权成员**。授权只作用于执行区；审批权、
Run 归属、讨论区三件事**不变**（红线）。写路径只有责任人可用。

## 判定（④a 15 条 + ④b 11 条，共 26 条机器判据）

> 表格只列**判据要点**（同一要点可能对应多条 `it()`；以复跑命令里的 spec 为准）。

| 判据 | 断言 | 结果 |
|---|---|---|
| 未授权 403 | 非责任人且未授权 → `FORBIDDEN`，**不落指令、不建 Run** | PASS |
| 授权后成功 | 消息 `author_user_id` 是该成员；Run `owner_user_id` **仍是责任人** | PASS |
| 撤销立刻生效 | 新 key 与**旧 key 重放**都 403；追问路径同样认授权 | PASS |
| 判权先于回放 | 撤销后旧 key 重放 403；未授权者猜到 key 也读不回别人指令（跨 Task 回执不回放） | PASS |
| 执行不换机器 | 成员用自己的设备/他人的工作区 → 拒（orchestrator 层与目标解析层各一组） | PASS |
| 审批不可授予 | 成员决定 → 精确 `FORBIDDEN`，且审批仍 `pending`/未过期；责任人 → `allowed_once` | PASS |
| 讨论区回归 | 任何成员都能评论，且评论**不带来**指令权 | PASS |
| 授权按人过滤 | 同 Task 授权 A、B 开口 → `right(A)=granted`、`right(B)=none` 且 B 被拒 | PASS |
| 表级兜底 | `granted_by` 必须是该 Task 责任人——INSERT 与 **UPDATE** 两条路径都拒绝 | PASS |
| 改派语义 | 改派**保留**名单，`granted_by` 保持"当时的责任人"；现任责任人仍是 `assignee` | PASS |
| 名单读模型 | 责任人排第一（`reason='assignee'`），被授权成员带 `grantedBy/grantedAt` | PASS |
| 幂等授予 | 三次调用 → 一行、**一条**审计事件 | PASS |
| 非责任人不能授 | 被授权成员与**团队管理员**都 403 且不落行 | PASS |
| 幽灵名单 | 授权给非团队成员 → 404 不落行 | PASS |
| 授/撤责任人自己 | 400 `VALIDATION_FAILED`（他本来就永远可驱动） | PASS |
| 撤销未授权者 | 200 `revoked=false`，幂等且不发事件 | PASS |
| 23514 翻译（正反例） | 真实形态错误被翻成 `VALIDATION_FAILED`；**不相关**的 23514（0005 那条）原样返回不误翻 | PASS |
| 名单读模型顺序 | 责任人恒排第一；被授权成员按授予时间（变异：写死 reason / 前两位对调 → 红） | PASS |
| 撤销审计 | 撤销发 `instruction_revoked` 事件；撤销未授权者不发事件 | PASS |
| 跨 key 幂等 | 三次**不同 key** 授予 → 一行一事件；同 key 由回执回放 | PASS |
| 路由幂等键 | 路由写死幂等键 → 回执被跨请求复用，判据红（证明键从请求读） | PASS |
| GET 错误面 | 未知 Task 的 GET → **404**（与 POST/DELETE 一致；此前是 500） | PASS |
| 落库前复核 | 撤销后复核抛 `FORBIDDEN` 且文案指明"建 Run 前被撤销"；复核存在时不误拒 | PASS |
| 带外删除 | 绕过 Task 锁直删授权行 → 建 Run 前的复核拦住（生产可达路径由 Task 锁串行） | PASS |

## 归因（失败先看哪层）

- **403 出现在目标解析之前**：判权（`resolveInstructionRight`）在 `instruction.ts` 最先执行——若你看到
  409 `DEVICE_OFFLINE` 而不是 403，说明请求者**有**权限，问题在设备/工作区；
- **`granted_by must be the task assignee`**：库级触发器；命令层已先判过一次，走到这里说明代码与库的
  假设不一致（命令层的责任人判定被改坏了）；
- **撤销没立刻生效**：先看守卫是不是被挪到了回执回放/目标解析之后（判权必须最先）；
- **成员用自己的设备被拒**：这是**预期**（红线"执行不换机器"）。

## 未覆盖与已知项

- **判权 → 建 Run 的竞态（口径已订正）**：`revokeInstructionRight` 第一步也是 `lockTask` 的
  `for('update')`，与建 Run 抢**同一把 Task 行锁** ⇒ **生产可达路径上两者本就串行，窗口是关着的**
  （复核 PROBE C 实测：撤销在门后阻塞满 3s 超时）。我先前在注释与本文档里写"撤销不阻塞 Task 行锁"
  **是错的**，已订正。落库前的判权复核保留，它防的是**带外删除**（绕过 Task 锁直删授权行，
  复核 PROBE B 复现），并有独立判据守着——此前它零覆盖（删掉整段仍 24/24 全绿）。
- **`granted_by` 的语义随改派漂移**：改派后它表示"当时的责任人"，见 migration 0006 注释；改派时
  **不清理**名单（当前行为，已写进注释并用判据钉住）。若产品决定"改派即清空"，要先写决策记录。
- **浏览器下行事件复用 `task.changed`**（`change: instruction_granted/revoked`）：客户端帧类型是封闭
  8 个字面量，新造类型要动协议与生成物；UI（切片⑥）若要专门呈现授权变更再单独设计。
- **权限页 UI 未接**：原型已定（`prototype/members-permissions.html`），真实界面是切片⑥。

## 复跑

```bash
pnpm check
npx tsx scripts/with-test-postgres.mts vitest run --project integration \
  apps/hub/tests/instruction-grant.integration.spec.ts \
  apps/hub/tests/instruction-grant-api.integration.spec.ts --testTimeout=30000
```
