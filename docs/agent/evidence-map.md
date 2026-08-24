# 取证地图：出问题去哪一层找什么

> 状态：随实现推进补全。标「待建」的条目由对应 Issue 落地后更新本表。
> 总原则：按 `component` 字段分层定位，用 `runId / traceId / commandId / eventSeq` 跨层对证据；不去翻与现象无关的日志。

## 分层证据位置

| 层 (component) | 证据 | 位置 | 状态 |
|---|---|---|---|
| browser | Playwright trace、截图、console | `test-results/`、`artifacts/evidence/<scenario>/<attempt>/browser-*.png` | 待 P1-19 |
| hub.http / hub.domain / hub.db / hub.outbox / hub.ws | 结构化 JSON 日志（stdout，含 allowlist 字段） | Hub 进程 stdout；Compose 部署走 `docker compose -f deploy/compose.yml logs hub` | 待 P1-05 起 |
| hub.db | 团队事实：Team Event、`run_event`、`outbox` | PostgreSQL 直接查；测试用 `scripts/with-test-postgres.mts` 起的临时实例 | 待 P1-04 |
| node.gateway / node.workspace / node.supervisor | Node 结构化日志、本地 spool、SQLite registry | Node 本地状态目录（方案暂定 `~/.project311-node/`，随定名调整）；诊断走本地 Unix socket | 待 P1-09/12 |
| runtime.bridge / dsh.agent | Runtime stderr 尾部（≤8 KiB，脱敏）、NDJSON 协议帧 | Node 暂存；owner-only | 待 P1-11/12 |
| artifact.store | 内容寻址 blob、candidate 元数据 | Hub `blobs/sha256/ab/<digest>` + DB | 待 P1-15 |

## 一把捞齐

- 按 Run 取证：`pnpm phase1:evidence -- --run <id>`（待 P1-18）。
- E2E 失败自动产包：`artifacts/evidence/<scenario-id>/<attempt-id>/`，含 `manifest.json`（git commit、DSH 版本、协议版本、种子、起止时间）、`assertions.json`、`api.jsonl`、`team-events.jsonl`、`node-events.jsonl`、`runtime-summary.jsonl`、`db-snapshot.json`、双浏览器截图。
- 任何证据离开本机或进 git 之前：`scripts/secret-scan.sh <路径>`，命中即拒（Q7）。

## 现象 → 先看哪层

| 现象 | 先看 |
|---|---|
| Run 状态不动 | hub.outbox 是否派发 → node.gateway 是否 ack → node.supervisor 是否拉起子进程 |
| 浏览器看不到进度 | hub.ws cursor 是否推进 → 浏览器是否收到 `resync.required` → hub.domain 是否产事件 |
| 事件重复/缺序 | `run_event` 表 `(run_id, seq)` 是否有缺口/重复 → node spool 是否重发 |
| 审批卡住 | hub.domain `approval` 行状态 → node.gateway 决定帧 → runtime.bridge answerer |
| Artifact 打不开 | artifact.store digest 与 DB metadata 比对 → hub.http 权限判定 |
| 疑似泄露 | 直接跑 `scripts/secret-scan.sh` 扫相关证据与日志 |

## 绝不进入证据的东西

密码、Setup/Invite/Device Token、模型密钥、绝对路径、完整 DSH Session JSONL、未发布 Artifact 正文（04 文档 §9）。
