# Q8 性能门（短档）验收登记

- 对应场景/门禁：Q8（04 矩阵行 + §8 环境判据）；命令 `pnpm test:load`
- 对应 Issue：#24（交付⑥）；判据裁决 #109（短档/长档分离、含糊行改写、环境 FAIL 不 SKIP）
- 上次验证：2026-09-07 · feat/p1-20-compose-q9 · **DEV-REPORT（macOS，exit 3 不充当判据）**：
  传播 p95=266ms(界500) · ingest p95=33ms(界100) · 空闲段斜率=-184MiB/min(界+1，
  释放方向不判红) · 净增=-125MiB(界96) · 样本 23,700+2,370 · live 地面真值 18 行。
  **判据数字待 ubuntu runner 首跑**（q5-release.yml 的 load job，#104 同平台限制：
  合并前无法 dispatch）。

## 验的是哪条链路
真人拓扑的**同进程腿**（phase1 chain：Hub+Node 同 tsx 进程、真 Runtime 子进程、
真 ephemeral PG）：2 个真 Task/Run 真跑到终态（live 旁证=DB 真实事件行数 >0），
随后**定速合成流** 2×20 ev/s × 60s 经真设备 WS 上行（走迟到事件持久路径），
10 条真浏览器 WS 连接收扇出。

## 判定（scripts/lib/phase1/load.ts，红样门卫 14 例）
| 判据 | 界 | 测量形态 |
|---|---|---|
| Team Event 传播 p95 | <500ms | t0=上行发出、t1=浏览器收到（同进程单调钟）；**每可见连接独立样本**；被 4009 踢=FAIL（缺样不缩样） |
| Run Event ingest p95 | <100ms | t0=发出、t1=ack 水位覆盖该 seq（throughSeq 语义）|
| RSS 无持续增长 | 空闲段斜率 <1MiB/min 且净增 <96MiB | **负载后 30s 空闲窗**采样（见"尺子账"）|
| 产品链路真跑 | live>0 | 合成流不许独自作证 |
| 环境 | 4CPU/8GiB/Linux/Docker | 不合格 exit 3（非 0 非 2，SKIP 不存在）|

## 尺子账（本案最大的一个设计修正，实测驱动）
第一版按"负载窗内 RSS 斜率<4MiB/min"判——60s 预演实测 34.3MiB/min 直接"红"。
归因：**分配速率高时 V8 堆扩张让 RSS 单调台阶，量的不是泄漏**。放宽阈值=门变烂；
正确代理=**空闲段还在涨**（04 用"空闲 30 分钟"同逻辑，短档把窗缩为负载 60s +
空闲 30s——口径变更在此留账，04 §8 原口径保留为长档未覆盖）。改后同机实测：
空闲斜率 -184（GC 释放，方向不判红）、净增 -125MiB。

## 边界与未覆盖（不许转述成"性能全验了"）
1. **测不出 §8 的 Hub RSS<400MiB / Node RSS<250MiB 行**（同进程混合）——
   per-process 判据要 Q5 拓扑（e2e-serve 子进程）+ 30min 长档，归 release soak；
2. 合成流绕过 Runtime stdout/projector/spool（走 Hub ingest 半边，文档口径=
   「Hub ingest 面 @20ev/s」，不是「全链吞吐」）；
3. replay **产生不了** 20ev/s（paceMs 只喂 live delta，fixture ~9 持久行/Run——
   调研实测），合成流是必需而非偷懒；
4. 传播含 250ms 轮询节拍（p95<500 ⟹ ≤2 tick；pollIntervalMs 不可配、没配，
   不许为门绿调它）；
5. Node 上行逐帧串行（node-websocket chain），ingest 天然含队列等待——这正是
   被测量的一部分；
6. `run_one_active_per_task`（DB 唯一索引）⟹ "2 并发 Run"必须 2 Task，本门自建
   task2 走真 HTTP；capacity=2 即拓扑上限，第三 Run 会 NODE_CAPACITY_REACHED；
7. §8 其余行（API 50req/s、Outbox p95、PG≤20、50Run 泄漏）不在短档——**门的
   覆盖度=Q8 行的「10 连接+2 Run」半边**，AGENTS 状态列如实标注。

## 复跑
```bash
pnpm test:load                      # Linux 判据机：真判；本机：exit 3 明示不合格
pnpm test:load -- --dev-report      # 开发机调试（数字打印但不判，恒退 3）
pnpm exec vitest run --project unit scripts/tests/load-threshold.spec.ts  # 尺子自检
```

## 尺子账其二：环境判据的前提被闸亲手证伪（#109 修订）

裁决时假设"ubuntu-latest = 4vCPU/16GB"（checkpoint 原话，**未验证**）。
Runner 首跑实测：**2 vCPU / 7.8 GiB**——不合格；本机 Docker Desktop VM 实测
2 CPU / 1.9 GiB——也不合格；合格判据环境当时**没有任何一个可及**。环境闸
按设计拒判（exit 3 而非绿洗），抓的是我自己的假断言。

修订（两级判定，FAIL 永不绿洗）：
- 合格环境：权威判（PASS=0 / FAIL=2），语义不变；
- 欠规环境**跑完照判**：PASS ⟹ exit 0 但标签 `PASS-CONSERVATIVE`（弱机过
  强机必过——保守证据，非权威判据）；FAIL ⟹ exit 3 `INCONCLUSIVE`
  （可能是环境贫血，须合格环境复判——不误杀也不放行）；
- `--dev-report` 恒 3，不变。

权威判据的欠账（**Alpha 发布前必须偿还**）：在 4CPU/8GiB/Linux Docker 环境
真跑一次 PASS（候选：本机 Docker VM 提额 4C/9GiB——hypervisor 事实须披露；
或任意合格 Linux 机）。偿还后本节补退出码与报告 JSON 摘要。
