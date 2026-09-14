# 一次性 PostgreSQL 的卷回收与陈旧容器清扫验收（#188）

- 对应门禁：Q2/Q5/Q6/Q7 的**前置环境**（`scripts/with-test-postgres.mts`、`scripts/e2e-serve.mts`、`scripts/q5-loop.sh`）+ 本片新增判据
- 对应 Issue：#188（本机累积 1332 个孤儿卷 / 58.59 GB）
- 上次验证：2026-09-11 · `fix/p1-188-ephemeral-volume` · 结果 PASS

## 验的是哪条链路

每次门禁运行都会起一个一次性 `postgres:18` 容器。`postgres` 镜像声明了匿名 `VOLUME`
（PG18 起挂在 `/var/lib/postgresql`，实测 `Config.Volumes` 只有这一项），所以每个容器必带一个
匿名卷（实测 39 MB）。**`--rm` 只在容器自己退出时回收匿名卷**；一旦运行被 SIGKILL / 超时打断，
容器会留着，事后任何**不带 `-v`** 的删除都会把卷永久留下。

本机实测的完整链：中断一次运行 → 容器仍活着、卷 +1 → `docker rm -f`（无 `-v`）→ 容器没了、
**卷仍在**。1332 × ~40 MB ≈ 58.6 GB，与 `docker volume prune -f` 回收的 58.59 GB 吻合。

## 驱动（怎么触发）

```bash
# ① 环境层判据（真实 Docker；Docker 不可用则 skip，不假绿）
npx tsx scripts/with-test-postgres.mts vitest run --project integration \
  scripts/tests/ephemeral-volume.integration.spec.ts --testTimeout=180000

# ② 判定与清扫的确定性判据（假 docker，毫秒级）
npx vitest run --project unit scripts/tests/ephemeral-postgres.spec.ts

# ③ 手工复现中断→自愈
npx tsx scripts/with-test-postgres.mts node -e 'setTimeout(()=>{}, 40000)' &   # 然后 kill -9
npx tsx scripts/with-test-postgres.mts node -e 'console.log("ok")'             # 应打印「已清扫…」
```

## 判定

| 判据 | 断言 | 结果 |
|---|---|---|
| **净增卷 = 0**（真实 Docker） | 启停一次后 `docker volume ls` 差集为空（修复前必然多 1 个匿名卷） | PASS |
| 中断后自愈 | kill -9 留下容器+卷 → 下次启动打印「已清扫上一次运行留下的 1 个容器（含其匿名卷）」→ 整轮净增卷 0 | PASS |
| 三条删除路径都带 `-v` | `:150`（重试）、`:294`（removeContainer）、`q5-loop.sh` 均 `rm -f -v` | PASS |
| **同 worktree 并发不互杀** | pid 活着的容器一律不碰（A/B 实测：后起者不再抽走先起者的库） | PASS |
| 无 pid 标签的旧容器 | 只有启动超过宽限期（10 分钟）才判为残留 | PASS |
| 启动链接线 | 第一条命令是按 `e2eScope()` 清扫、清扫在 `run` 之前、启动标签带**同值** scope + 启动者 pid | PASS |
| 失败路径 | `docker ps` 抖动只告警（返回 0）；`rm` 失败只记 WARN 不抛错 | PASS |

## 归因（失败先看哪层）

- **净增卷不为 0** → 先看是哪条删除路径没带 `-v`：`scripts/lib/ephemeral-postgres.mts`
  的 `:150` / `:294`、`scripts/e2e-serve.mts`（走共享清扫）、`scripts/q5-loop.sh`；
- **容器被误杀（并发场景）** → 看 `findStaleContainers` 的 pid 判据：容器是否带
  `whalepod.e2e-runner-pid`，以及 `isPidAlive` 是否把它误判为死；
- **残留清不掉** → 看是否 `docker ps -aq --filter label=…scope=…` 筛不到：cwd 变化（符号链接）
  会让 `e2eScope()` 变值，于是「筛不到自己的旧容器」（方向安全：不误删别人，但会静默累积）；
- **q5 连活容器一起删** → 检查 `--filter status=exited` 是否还在（共用标签必须配这条）。

## 未覆盖与已知项

- **cwd 变化时筛不到旧容器**：`e2eScope()` 由 cwd 派生，符号链接/非物理路径会得到不同 scope，
  旧容器不会被自愈清扫（只能靠人工 `docker volume prune`）。方向安全，未加判据。
- **`q5-loop.sh` 仍是共用标签**：已加 `status=exited` 防止误杀活容器，但它无法只清自己 worktree
  的残留（算不出 scope 哈希）；跨 worktree 的残留由各运行的 pid 感知清扫兜住。
- **历史那 1332 个卷**已手工回收（`docker volume prune -f`，58.59 GB）；本片只保证不再产生新的。
- **命名卷不受影响**：`docker volume prune` 默认只删匿名卷，`rm -f -v` 也只删匿名卷。
- **e2e 全量未跑**：本机负载下未跑完整 `pnpm test:e2e`（评审按同路径启动耗时外推，sweep 增加
  一次 `docker ps` 往返约 13–31 ms）。

## 复跑

```bash
pnpm check                                                          # Q0（含 15 条脚本单测）
npx tsx scripts/with-test-postgres.mts vitest run --project integration \
  scripts/tests/ephemeral-volume.integration.spec.ts --testTimeout=180000
```
