# 开发机残留自检验收（测试进程收尾，#305）

- 对应场景/门禁：不在 CI 门内（CI runner 一次性，进程随 job 消失——这正是泄漏被掩盖的原因）；
  判定面 = `scripts/check-stray-runtimes.sh`（含 `--self-test`），跑完 Q0/Q1/Q6/Q5 后可复跑
- 对应 Issue：#305
- 判定脚本：`scripts/check-stray-runtimes.sh`（探针残留即 FAIL；`--strict` 再把自家
  Node/Runtime/E2E 进程当残留，发布前清理用；`--self-test` 造一个假探针自证判定力）
- 上次验证：2026-10-17 · 见下方「判定」的实测数字

## 验的是哪条用户路径

开发者在长期存在的机器上跑测试面（Q0/Q1/Q6/Q5…）——**测试为负向判据故意留活的东西
必须被自己收回**，否则「CI 全绿」在开发机上对应的是一次跑多一个持续 `setInterval`
空转的 node 进程（#305 首报：25 个 / 156MB / 最老 18h）。对应用户可见后果：机器越跑越
慢、`ps` 里一堆看不出归属的 node；也污染后续排障（真 Runtime 与探针混在一起）。

## 驱动（怎么触发）

```bash
./scripts/check-stray-runtimes.sh --self-test   # 判定力自检（两种形状的假探针必须判中）
# 自查一律用 --strict：默认档只把「测试探针」当 FAIL，自家 Node/Runtime 进程只列 INFO——
# 修复②（真 CLI 残留）那种回归只有 --strict 才拦得住。
pnpm test:unit && ./scripts/check-stray-runtimes.sh --strict          # 跑完 Q0/Q1 后自查
pnpm test:resilience && ./scripts/check-stray-runtimes.sh --strict    # 跑完 Q6 后自查
pnpm test:e2e && ./scripts/check-stray-runtimes.sh --strict           # 跑完 Q5 全链后自查
```

## 观测（看什么）

- **测试探针**（argv 形如 `-e 'setInterval(() => {}, 1000)' -- --run-id <id> --nonce <id>`）：
  只可能来自测试驱动，命中即 FAIL——判据不该依赖"记得杀"；
- **自家进程**（`whalepod-node`/`whalepod-runtime`/e2e-serve 等）：开发机上可能正被正常使用
  （手工起的 Node、正在跑的 Run），故默认只列出为 INFO；`--strict` 才当残留（发布前清单）。

## 判定（成功长什么样）

1. 修复前实测（红）：
   - `pnpm exec vitest run --project unit apps/node/tests/recovery.spec.ts` → 探针残留 **+1**
     （`r-orphan-2`，与该 spec 的负向用例一一对应）；
   - `pnpm test:resilience` → 真实 `apps/node/src/cli.ts start` 残留 **+1**（存活至
     `--strict` 扫描仍在，父进程已是 launchd）。
2. 修复后实测（绿，同一台机器、同一命令）：
   - recovery 负向用例断言完**自己回收**探针（按 pid 精确 SIGKILL + 断言真的消失）；
     且探针 pid 一注册就交给 `afterAll` 兜底——**失败/超时路径**也收尾（评审 P2：
     原实现只在 happy path 末尾回收，而这恰是最需要收尾的场景）。实测：故意让该用例
     红一次（把「仍活着」翻成 `toBe(false)`），跑完 `--strict` 仍零残留。
   - `node-restart-orphan-cli.spec` 改独立进程组 spawn + **按进程组** SIGKILL（tsx 的
     launcher 会再 spawn 真 CLI，杀 launcher 会把它 reparent 到 launchd），收尾断言
     `awaitDead` 不通过即红。
   - 复跑链（全部 `--strict`）：`test:unit`（1662 + 7 expected fail）→ 干净；
     `test:resilience`（32）→ 干净；`pnpm test:e2e` **全链 exit 0**（11 段，含
     create-to-recovery / preparation-return 两条 tsx 链与尾段 micro）→ 干净；
     `pnpm check`（Q0，含 unit）→ 干净（此前每跑一次 Q0 多一个探针）。
3. `--self-test`：两种形状的假探针（`-e setInterval` 探针、只有 `--run-id/--nonce` 的探针）
   都必须判中、回收后必须判空（防判定力退化；评审曾抓到第二支模式写坏成 `---run-id`
   永不匹配——自检语料现在覆盖它）。

## 同族普查（本 Issue 要求的"顺带核一遍"）

| 场景 | 形态 | 结论 |
|---|---|---|
| `apps/node/tests/recovery.spec.ts` 负向用例 | 故意留活的探针（证明未误杀） | **修复**：断言后按 pid 回收 + 断言消失 |
| `apps/node/tests/resilience/node-restart-orphan-cli.spec.ts` | 真 CLI 长驻（证明不崩），只杀 tsx launcher | **修复**：detached 进程组 + 组杀 + `awaitDead` 收尾断言 |
| `apps/node/tests/runtime-supervisor.spec.ts` | detached 探针，supervisor 终止进程组 | 复跑零增量（已实测），无需改 |
| `apps/node/tests/resilience/*`（harness 驱动） | 同 supervisor 形态 + `afterEach` 清理 | 复跑零增量（已实测），无需改 |
| `apps/node/tests/cli-argv.spec.ts` | tsx launcher + 自退出的子命令 | 命令自身退出、父等 exit，零残留（已实测） |
| `apps/node/tests/dsh-version-probe.spec.ts` | `setInterval` 探针，靠**生产超时**终止 + `waitGone` 自证 | 复跑零残留（已实测）；注意其 argv 无 run-id/nonce，一旦泄漏默认档与 `--strict` 都看不见（见边界节） |
| Q5 `scripts/e2e-serve.mts` / `e2e-node.mts` | 长驻服务 + 真 Node | 跑完 Q5 零残留（已实测） |

## 归因（失败先看哪层）

| 现象 | 先看 |
|---|---|
| 脚本报探针残留 | 哪条 spec 最近跑过（argv 里的 `--run-id` 值就是用例的 runId）；对应负向用例是否漏了收尾 |
| 脚本报自家 Node/Runtime 进程 | 真是你在用的实例就忽略（INFO 档）；否则按 argv 判断来自哪条链路（`--strict` 时按 FAIL 处理） |
| 自检就红 | `scripts/check-stray-runtimes.sh` 的模式本身被改坏——先修模式再谈残留 |

## 边界与未覆盖

- 判据是**本机形态**的扫描（`ps` 全量 argv），不覆盖 CI（CI 一次性 runner 无此问题，也不需要）；
- 不覆盖非本仓进程（红线：不按宽模式 `pkill`，只按精确 pid/进程组收尾；脚本只读不杀）；
- 「自家进程」档有意不 FAIL：开发机上「手工起的 Node + 正在执行的 Run」完全正当，
  脚本不替使用者判断（要清场时用 `--strict` 复核）；
- 探针模式基于当前探针 argv 形状（`-e setInterval… -- --run-id`、或带 `--run-id/--nonce` 的
  探针）：探针形状若改，模式要同步（`--self-test` 的两种语料就是同形假探针，模式漂了会先红）。
- **看不见的形态**（如实）：argv 既不带 `--run-id/--nonce` 又不匹配 `self_re` 的自家进程
  （例如不带参数的短命探针）不在扫描面内——`self_re` 覆盖的是长驻/入口类（src 与 dist 的
  cli/bin、runtime、e2e-serve），各探针用例自己的 `waitGone` 断言才是第一道收尾。

## 复跑

```bash
./scripts/check-stray-runtimes.sh --self-test
pnpm test:unit && pnpm test:resilience && ./scripts/check-stray-runtimes.sh --strict
```
