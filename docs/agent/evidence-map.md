# 取证地图：出问题去哪一层找什么

> 状态：随实现推进补全。标「待建」的条目由对应 Issue 落地后更新本表。
> 总原则：按 `component` 字段分层定位，用 `runId / traceId / commandId / eventSeq` 跨层对证据；不去翻与现象无关的日志。

## 分层证据位置

| 层 (component) | 证据 | 位置 | 状态 |
|---|---|---|---|
| browser | Playwright trace + 自动证据包（hub/node/vite 日志尾、run 事实、manifest） | `test-results/**/trace.zip`；`artifacts/evidence/e2e/<attemptId>/`（P1-19 collectEvidenceOnFailure，redactText 源头归约，Node READY 行含 Token 已排除） | 生效（P1-19） |
| hub.http / hub.domain / hub.db / hub.outbox / hub.ws | 结构化 JSON 日志（stdout，含 allowlist 字段） | Hub 进程 stdout；Compose 部署走 `docker compose -f deploy/compose.yml logs hub` | 待 P1-05 起 |
| hub.db | 团队事实：Team Event、`run_event`、`outbox` | PostgreSQL 直接查；测试用 `scripts/with-test-postgres.mts` 起的临时实例 | 待 P1-04 |
| node.gateway / node.workspace / node.supervisor | Node 结构化日志、本地 spool、SQLite registry | Node 本地状态目录（方案暂定 `~/.project311-node/`，随定名调整）；诊断走本地 Unix socket | 待 P1-09/12 |
| runtime.bridge / dsh.agent | Runtime stderr 尾部（≤8 KiB，脱敏）、NDJSON 协议帧 | Node 暂存；owner-only | 待 P1-11/12 |
| artifact.store | 内容寻址 blob、candidate 元数据 | Hub `blobs/sha256/ab/<digest>` + DB | 待 P1-15 |

## 一把捞齐

- 按 Run/场景取证（P1-18）：`pnpm phase1:evidence -- --evidence <dir> [--run <id>]`；
  驱动 `pnpm phase1:drive`、判定+归因 `pnpm phase1:verify`（exit code 即结论）。
  采集由 `scripts/lib/phase1/` 六原语 harness 完成：真 Hub+真 Node+真 Runtime+双
  Browser WS，跨层 traceId/runId 索引在证据目录的 `index.json`（按 run 一把捞齐
  四层证据计数与文件）。验收细节见 [harness-acceptance.md](./harness-acceptance.md)。
- E2E 失败自动产包：`artifacts/evidence/<scenario-id>/<attempt-id>/`，含 `manifest.json`（git commit、DSH 版本、协议版本、种子、起止时间）、`assertions.json`、`api.jsonl`、`team-events.jsonl`、`node-events.jsonl`、`runtime-summary.jsonl`、`db-snapshot.json`、双浏览器截图。
- P1-19 E2E 自动产包：`artifacts/evidence/e2e/<attemptId>/`（`hub.log.txt`/`node.log.txt`/`vite.log.txt` 三层日志尾 + `run-<id8>.json` 相关 Run 全量事实白名单 + `manifest.json` traceId/error/runIds）。控制面 `/control/tails` 与 `/control/db/run/:id` 是打包数据源；归因按 component 前缀（hub.*/node.*/runtime.*）分层。
- 任何证据离开本机或进 git 之前：`scripts/secret-scan.sh <路径>`，命中即拒（Q7）。
  绝对路径模式覆盖 macOS home、Linux home 与 tmpdir 形态（含本机 os.tmpdir()
  锚点）；模式本身的可信度用 `scripts/secret-scan.sh --self-test` 逐条语料自检（#73）。

## 现象 → 先看哪层

| 现象 | 先看 |
|---|---|
| Run 状态不动 | hub.outbox 是否派发 → node.gateway 是否 ack → node.supervisor 是否拉起子进程 |
| 浏览器看不到进度 | hub.ws cursor 是否推进 → 浏览器是否收到 `resync.required` → hub.domain 是否产事件 |
| 事件重复/缺序 | `run_event` 表 `(run_id, seq)` 是否有缺口/重复 → node spool 是否重发 |
| 审批卡住 | hub.domain `approval` 行状态 → node.gateway 决定帧 → runtime.bridge answerer |
| Artifact 打不开 | artifact.store digest 与 DB metadata 比对 → hub.http 权限判定 |
| 疑似泄露 | 直接跑 `scripts/secret-scan.sh` 扫相关证据与日志 |
| 性能回归疑云 | `pnpm test:load`（Q8 短档）报告 JSON：传播/ingest p95、空闲段 RSS 斜率、droppedConnections；判据/边界见 `docs/agent/load-performance-acceptance.md` |

## 绝不进入证据的东西

密码、Setup/Invite/Device Token、模型密钥、绝对路径、完整 DSH Session JSONL、未发布 Artifact 正文（04 文档 §9）。
