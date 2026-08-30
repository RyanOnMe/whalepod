# 六原语 harness 与 Evidence 包 验收

- 对应场景/门禁：05 §4 P1-18 验收标准（断层自证）、04 §9 Evidence 包、六原语全量落地；Q0/Q2/Q7
- 对应 Issue：P1-18（#22）
- 上次验证：2026-08-30 · feat/p1-18-harness-evidence · 结果 PASS（六测全绿：绿链 + 四层断层归因 + CLI 冒烟；门结果见下）

## 验的是哪条用户路径

主链 **Task→Run→Approval→Artifact→Reviewer** 的完整用户动作序列：责任人创建
Project/Task 并接受 → 选 Agent Revision + 自己设备的 Workspace 启动 Run → DSH
工具触发 ask、owner 在 HTTP 上做一次性决定 → `publish_artifact` 产出候选、owner
发布 → Reviewer Run 从 Hub 拉取已发布 Artifact 输入清单（受控下载副本）并跑到
终态。驱动走真人同一条处理路径（真实 HTTP + WS + 真 Hub/Node/Runtime 子进程 +
双 Browser WS 连接），不开任何测试专用通道。

## 驱动（怎么触发）

两个独立入口，可分别复跑（触发与判定分离，可换通道单跑）：

```bash
# 驱动 + 采集（自起一次性 PostgreSQL，证据落 artifacts/evidence/，gitignore）
pnpm phase1:drive -- --scenario minimal|standard|secrets [--fault none|hub|node|runtime|browser]

# 判定 + 归因（exit code 即结论：0=PASS，2=FAIL）
pnpm phase1:verify -- --evidence <drive 输出的证据目录>

# 按 Run/场景打包（出包必过 scripts/secret-scan.sh，命中即拒收）
pnpm phase1:evidence -- --evidence <dir> [--run <runId>]
```

- 场景：`minimal`（单 Run 基础投影）、`standard`（全主链：Approval→Artifact→Reviewer）、
  `secrets`（04 §6.4 六件语料脱敏）。
- 装配复用：`scripts/lib/phase1/chain.ts` 由 P1-13 全链路集成测试的 setupChain
  上升而来（真 Hub + 真 Node 会话 + 真 Runtime/replay 子进程 + 双 Browser WS），
  `apps/node/tests/integration/run-projection-chain.integration.spec.ts` 与
  phase1-drive 共用同一份装配，不再另写一套。
- 故障注入面（chain.ts）：`breakHub()`（关 Hub listener + 停 OutboxWorker）、
  `stopNodeSession()`（停 Node 会话，spool 存活）、Runtime 入口换必崩 stub
  （exit 7、零协议帧）、`closeBrowsers()`（收掉 Browser 连接）。注入时机确定性
  触发（如 fault=hub 等 Runtime 真起来再断 Hub）。

## 观测（看什么）

统一结构化事件流（`events.jsonl`），每条带 `component` 分层字段（06 §8 词表 +
`harness.*`）与 `traceId` 跨层索引键，run 相关事件带 `runId`：

| 层 (component) | 证据文件 | 内容 |
|---|---|---|
| harness.* | events.jsonl | 驱动里程碑、故障注入标记 |
| hub.http | events.jsonl + layer-facts.jsonl | HTTP 请求事实、真 TCP 探活（inject 绕过 listener，不能判 Hub 存亡） |
| hub.outbox / hub.db | events.jsonl + db-snapshot.json | 派发/ack、run/run_event/approval/artifact/outbox 显式列快照 |
| node.gateway / node.run / node.artifact | events.jsonl + node-events.jsonl | 收帧、上行帧全文（已脱敏）、输入清单/候选采集日志 |
| runtime.bridge / dsh.agent | runtime-summary.jsonl + events.jsonl | stdout 帧型+字节长度（文本不出 Runtime 层）、stderr tail（脱敏） |
| browser | browser-alice.jsonl / browser-bob.jsonl | 双 Browser 收到的 ClientFrame 全文（已脱敏）、socket 开闭事实 |

跨层索引 `index.json`：traceId + runId → 各层证据计数与文件、命令链
（commandId → 派发/ack）——按 run 一把捞齐四层证据的入口。

## 判定（成功长什么样）

`phase1:verify` 跑可证伪断言，全部写成检查项（无数据、缺一环即 FAIL）：

- **观测纪律**：事件逐条带 component/traceId；四层观测都在案。
- **链路里程碑**：run.start 命令被 Node ack → Runtime 产生协议帧 → Node 上行 →
  Hub run_event 落库 → run 终态 completed → 双 Browser 各自收到 run.completed
  （owner 全文 / member 仅 project 帧）。
- **G4-04/05**：owner 流含完整最终文本、live delta 只到 owner；member 流零
  owner 行；owner 流 assistant.message 全部先于 run.completed（flush 顺序）。
- **standard 附加**：approval.requested/decided（allowed_once、decidedBy=owner）、
  allow 后 tool.finished succeeded、Artifact published + blob 在库（sha256）、
  Reviewer Run 的 `artifact inputs prepared`（清单拉取+下载校验）+ Reviewer Run
  终态 completed。
- **secrets 附加**：六件语料在 DB/双 Browser/Node 上行全部零出现，owner 完成行
  带脱敏标记（证明是「脱了敏」，不是「没内容」）。
- **跨层索引**：绿链的 run 在 runtime/node/hub/browser 四层均有证据计数。

## 归因（失败先看哪层）

归因树（verify.ts `attribute()`）从终端证据逆因果链上溯，第一层「输入到了、
产出没到」的就是断点；上游断掉时下游缺失不背锅。归因只看证据事实（探活、
outbox ack、Node 上行、Runtime 帧摘要、DB 快照、Browser 帧与 socket 事实），
**不看 drive 的注入参数**——fault 字段只进报告标题，不自证。

| 故意打断的层 | 证据签名 | verify 归因 |
|---|---|---|
| Hub（breakHub） | 探活失败 + outbox acked_at 为空 或 Node 侧已产出 run.completed 而 Hub 未落库 | **Hub** |
| Node（stopNodeSession） | Hub 在线且已派发，Node 会话未收到 run.start / 未 ack | **Node** |
| Runtime（必崩 stub） | run.start 已 ack，runtime-summary 零帧，run 落 failed(RUNTIME_LOST) | **Runtime** |
| Browser（closeBrowsers） | Hub 已落库 completed，Browser socket 已关、帧流缺 run.completed | **Browser** |

绿链上的场景断言失败也各自带层标（如 G4-05 flush 顺序 → Hub 投影面）。

### 断层自证证据表（phase1-drive --fault ×4 → phase1:verify，CLI 实跑）

2026-08-30，`artifacts/evidence/acceptance-demo/results.txt`（判定输出全文）：

| 注入 | drive | verify（exit code 即结论） | 检查 | 归因（verify 原文） |
|---|---|---|---|---|
| 无（绿链 standard） | 采集 2 run | **PASS**（0） | 24/24 | —（无归因） |
| `--fault hub` | breakHub | **FAIL**（2） | 8/12 | `[Hub] Node 侧已产出 run.completed 上行帧而 Hub 未落库，且 Hub 探活失败——Hub 中途下线`（证据：layer-facts hub.probe ok=false；db-snapshot run_event 缺 completed） |
| `--fault node` | stopNodeSession | **FAIL**（2） | 4/12 | `[Node] Hub 在线且已派发（outbox 有派发事实），Node 会话没有收到 run.start——Node 层不在`（证据：outbox run.start acked_at 为空、attempts>0；node.frame.received(run.start) 缺失） |
| `--fault runtime` | 必崩 stub | **FAIL**（2） | 7/12 | `[Runtime] Node 已确认 run.start，但 Runtime 未产生任何协议帧（runtime-summary 为空）——Runtime 未跑起来或即崩`（证据：runtime-summary.jsonl 0 帧；run.start 已 ack） |
| `--fault browser` | closeBrowsers | **FAIL**（2） | 10/12 | `[Browser] Hub 已落库 completed，但 owner Browser 连接在扇出窗口内断开——Browser 层缺失`（证据：db-snapshot run completed；browser-alice.jsonl 缺 run.completed） |

同日 CLI 出包（绿链 standard 按 run 收缩）：`phase1:evidence` → 10 文件包，
`"verdict": "PASS"`、`"secretScan": "PASS"`（secret-scan 命中即删包拒收）。

## 取证

```bash
# 打包（含 --run 收缩包）；出包前必过 secret-scan，命中即删包拒收
pnpm phase1:evidence -- --evidence <dir> [--run <runId>]
# 手工扫描（默认扫 artifacts/evidence/）
scripts/secret-scan.sh
```

包布局（04 §9）：`manifest.json`（commit/DSH 版本/协议版本/平台/起止时间/逐文件
sha256/verdict）、`assertions.json`（verify 判定全文）、README.md（含复跑命令）+
各层证据文件。红线：runtime 层只有帧型与字节长度，文本面全部经过 Node 投影
脱敏，绝对路径在 stderr 证据里归约为 `<home>/`；证据只落 `artifacts/evidence/`
（gitignore），绝不留 /tmp（装配的临时目录收尾即删，stub 等工具文件不入证据）。

## 边界与未覆盖

- Browser 层是双 WS 客户端（P1-13 形态）；Playwright 双 BrowserContext 的
  「界面看起来对」判负留 P1-19（Q5 门）。
- 归因树对四个注入点是确定性的；未经注入的自然故障若落在树未覆盖的缝里，
  按保守规则归到最近缺失里程碑的层（在报告里附证据引用，人工可复核）。
- fault=hub 的 OutboxWorker 重投退避窗口内 acked_at 恒空——归因不依赖
  attempts 计数，只依赖探活与两侧产出对比。
- `pnpm test:e2e`（Q5）与本 harness 不重叠：Q5 管界面，本 harness 管链路事实。

## 复跑

```bash
git clone <repo> && cd <repo> && corepack enable && pnpm install && pnpm -r build
pnpm check                                        # Q0（含 harness 静态门）
pnpm test:integration                             # Q2，含六原语 harness 自证 spec：
                                                  #   scripts/tests/phase1-harness.integration.spec.ts
                                                  #   （绿链 PASS + hub/node/runtime/browser 四层断层 FAIL 且归因正确 + CLI 冒烟）
pnpm phase1:drive -- --scenario standard          # CLI 独立复跑（自起一次性 PG）
pnpm phase1:verify -- --evidence <上一步输出的目录>
pnpm phase1:evidence -- --evidence <目录> --run <runId>
scripts/secret-scan.sh                            # Q7 取证面
```

上次全套结果（6/6）：`绿链 standard PASS · fault=hub→Hub · fault=node→Node ·
fault=runtime→Runtime · fault=browser→Browser · CLI 冒烟（drive→verify→evidence
出包过 secret-scan）PASS`，见 `artifacts/evidence/acceptance-demo/results.txt`。
