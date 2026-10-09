# Compose 空卷标准闭环验收（A0-5 / #286）

- 对应门禁：**Q9**（`pnpm test:compose-smoke`）
- 对应 Issue：#286（外部审查 A0 第 5 项）；判据原句在 `04-验收矩阵` Q9 行与
  `2026-10-08-release-harden-validate-handoff-plan.md` Phase 1 第 5 项
- 上次验证：2026-10-09 · `feat/p1-a0-compose-standard-loop` · 结果 PASS（含变异自证）

## 验的是哪条链路

**空卷 + 空库**的真实安装（生产同一份 `deploy/compose.yml`、生产镜像）能不能承载
**标准闭环**，以及闭环走到哪一步为止。

先说边界，因为这里最容易说大话：

| 段 | 内容 | 谁验 | 为什么 |
|---|---|---|---|
| **A 安装面** | up → 健康 → 静态资产 → setup/登录 → 邀请/接受 → 双设备 → 双 Workspace → 投影隔离 → Agent 装配 → Task 建单/指派/受理 → 双 Run → **凭证边界** → 跨成员越权拒绝 | **本脚本（机检，CI/本机皆可）** | 不需要模型密钥 |
| **B Agent 执行** | 审批桥、Artifact 发布、Reviewer、验收 | Q5 E2E（开发装配 + DSH replay，无外部模型）+ Phase 2 外部 alpha（真团队真密钥） | **全新安装跑真实 Agent 必须有真实模型密钥**：生产路径不接受 replay overlay（那是验收缝，`apps/node/src/supervisor/environment.ts` 的 `extraPassthrough` 注释明写「生产 cli 不传」）。CI 与他人机器都不具备密钥 |

所以本验收证的是：**空卷安装能承载标准闭环直到凭证边界，且边界处如实报错**——不是
「空卷安装跑通了完整双人闭环」。写 release notes、对外介绍、验收记录时只许照这两段写。

## 驱动（怎么触发）

```bash
pnpm test:compose-smoke        # 需要本机 Docker；15 分钟硬闸，冷构建约 5 分钟
```

脚本自管：随机高位端口、随机项目名、临时 `.env`（0600）、临时 HOME ×2、收尸在 `finally`
（`down -v` + 杀两台 node + 删 HOME/Workspace/`.env`）。

## 判定（跑起来看什么）

冒烟每次打印一行 `phases=[...]`，每阶段带耗时；非零退出即不合格。A 段的新增判据：

| # | 判据 | 反证/正控 |
|---|---|---|
| 1 | 邀请→接受：`POST /invites`（owner）→ `POST /invites/accept`（匿名）→ `GET /team/members` 计数 = 2 | 成员数不符即红（不是「201 就算过」） |
| 2 | 第二台设备独立 HOME 配对 + 第二个 Workspace 登记 + `start` | 第二台进程退出即红 |
| 3 | **投影隔离**：owner 的 `/workspaces` 恰好只有 `smoke-ws`；成员的恰好只有 `smoke-ws-b` | 双向断言（成员视图出现他人 Workspace 也红）——安装面的跨成员边界，不需要密钥 |
| 4 | Agent 经真实管理 API 建：`GET /plugin-packs` 找到 Setup 落的 `core-empty` → `POST /agents` | 找不到 `core-empty` 即红（全新安装的默认 Pack 缺失） |
| 5 | Task 建单 → 指派 → 责任人 `accept`（两位成员各一单） | accept 非 200 即红 |
| 6 | 两位成员**各自在自己 Workspace 上**起 Run（`POST /tasks/:id/runs` 必须 201） | 起点不通即红 |
| 7 | Run 落到 **failed + `MODEL_CREDENTIAL_UNAVAILABLE` + 非空 `failureSummary`** | 只认这一个码：泛化失败（如 `RUNTIME_START_FAILED`）算红——病因必须透传给人 |
| 8 | 成员 Run 对 Owner 可见（任务房间读面 `failed`） | 看不到即红（成员侧执行事实不得丢） |
| 9 | 成员拿 **Owner 的 device+Workspace** 起 Run → 4xx 且该 Task 的 Run 数不变 | 负向断言带「不变」反证 |

第 6–7 条的因果链（为什么「缺凭证」能机检）：Hub `POST /tasks/:id/runs` → outbox
`run.start` → Node 受理时 `buildRuntimeEnvironment` 发现该 provider/slot 无凭据 →
spawn 前抛 `RuntimeEnvError('MODEL_CREDENTIAL_UNAVAILABLE')` → Node 以 `command.ack`
失败确认 → Hub `handleCommandAck` 把 Run 从 `queued` 转 `failed` 并**透传 ack 的错误码
与摘要**（`apps/hub/src/modules/run/orchestrator.ts`）。任一段被删都会让 7 变红。

## 变异自证（证明判据不是摆设）

| 变异 | 位置 | 结果 |
|---|---|---|
| 删病因透传：`failureCode: ack.error?.code ?? 'RUNTIME_START_FAILED'` → `'RUNTIME_START_FAILED'` | `apps/hub/src/modules/run/orchestrator.ts` | **脚本红**：`run(member) 终态=failed code=RUNTIME_START_FAILED（未配凭证时必须 failed/MODEL_CREDENTIAL_UNAVAILABLE）` |
| 还原（`git status` 只剩脚本改动） | 同上 | 复跑绿（见下方证据） |

这一刀专门验「病因有没有被人看到」：泛化失败也返回 failed，只有码断言能区分。

## 证据

| 跑法 | 结果 | 证据位置 |
|---|---|---|
| 扩前基线（main `1902aff`，热构建） | PASS total=75.2s | `/tmp/q9-evidence/baseline-1902aff.log` |
| 扩后（含 A 段全部判据，冷构建） | PASS total=308.4s（构建 302.8s；闭环逻辑 ~7.1s） | `/tmp/q9-evidence/extended-1.log` |
| 变异（删病因透传） | FAIL：落在判据 7 | `/tmp/q9-evidence/mutation-1.log` |
| 还原复跑（同一棵树） | PASS total=17.7s（增量构建 11.6s） | `/tmp/q9-evidence/revert-verify.log` |
| **提交内容定稿跑**（oxfmt 之后） | PASS total=111.3s（冷构建 105.0s；闭环逻辑 ~6.9s） | `/tmp/q9-evidence/final-formatted.log` |

15 分钟预算的账：冷构建 ~5 分钟 + 闭环 ~7 秒 + up/探活 ~1 分钟，**A 段全部新增判据
合计约 5 秒**。预算不是瓶颈，冷构建才是——加判据几乎不花钱，改仓库任何文件都会让
镜像重建（`COPY . .`）回到冷态。

## CI 触发面（#116 收口，2026-10-09）

`q5-release.yml` 新增 `compose-smoke` job：push tag `v*`（与 Q5 20 连跑同一次发布取证）
或 `workflow_dispatch`。范围内做三件：宿主 build（冒烟要宿主 dist 跑真 node CLI）→
`pnpm test:compose-smoke` 并把日志 `tee` 进 `artifacts/q9/` → `upload-artifact`（保留 90 天）。
**不挂 per-PR**：冷构建 3–6 分钟 + runner 资源画像与判据环境不同，它是发布级证据门
（口径见上表 A/B 两段；门禁分级文档同口径）。

## 未覆盖 / 边界（别读成已验）

- **B 段全部**：审批桥、Artifact、Reviewer、验收、取消/故障收敛——需真密钥，归 Phase 2
  外部 alpha 与人工狗食；开发装配由 Q5 覆盖。
- 真实浏览器（本脚本用 HTTP/WS 替身，web 静态只验可达与哈希资产存在）。
- Q9 尚未进 CI 触发面（#116 延迟项），当前以 release 手动跑为准
  （`docs/agent/2026-10-08-q-gates-g0g1g2-tiers.md` Q9 行）。
- HTTPS/域名形态、升级与回滚路径（`docs/installation.md` E 段）——未被本脚本覆盖。

## 复跑与排障

```bash
pnpm test:compose-smoke                              # 全量
docker compose -p <残留项目名> down -v               # 脚本 finally 失败时的收尸
docker volume ls | grep wpsmoke                      # 查残留匿名卷
```

红了先看 `phases=[...]`：最后完成的阶段就是断点；`FAIL component=hub.smoke` 后的
第一行是断言原文（期望值一起打印，不需要回读脚本）。
