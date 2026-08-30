# Artifact 候选、存储、发布与 Reviewer 输入 验收

- 对应场景/门禁：G6-01..08、04 §6.3 路径攻击矩阵、§6.1 候选可见性（见 04-验收矩阵与测试策略.md）
- 对应 Issue：P1-15（GitHub #19）；评审跟进 #62（Reviewer 输入副本清理覆盖全部终态路径）
- 上次验证：2026-08-30 · fix/p1-15-inputs-cleanup（#62 评审跟进）· 结果 PASS
  - Q0 `pnpm check` 全绿；Q6 `pnpm test:resilience` 全绿（含 #62 新增
    `apps/node/tests/resilience/artifact-inputs-cleanup.spec.ts` 8 tests）
  - `scripts/secret-scan.sh`（改动文件）零命中

## 验的是哪条用户路径

Builder Run 的 Agent 在 Workspace 里产出文件后调用 `publish_artifact` 工具：
候选经 Node 校验（realpath/边界/大小/哈希）上传到 Hub 的内容寻址存储，
只有责任人（Bob）能看到并下载该候选；Bob 点击发布后，全团队立即可下载
（内容与 sha256 一致）；Bob 随后启动 Reviewer Agent 的新 Run 时，任务下已发布
交付物以「只读输入清单 + 受控下载副本」送达 Reviewer Run——不继承 Builder 的
Workspace、不暴露任何本机路径。对应 03 §12 时序图下半场（artifact.candidate →
publish → Reviewer）。

## 驱动（怎么触发）

全部走真人同一条处理路径（Fastify inject = 真实 HTTP；Device Token = Node 真实
鉴权；replay runtime = 真实 DSH Agent Loop，仅 LLM 出口替换）：

```bash
# Q2：Hub 侧 artifact 面（上传/发布/下载/manifest/权限/篡改/超限）
pnpm test:integration -- apps/hub/tests/artifact.integration.spec.ts

# Q1：内容寻址 store（hash/size/临时文件清理/digest 复核/去重）
pnpm vitest run --project unit apps/hub/tests/artifact-store.spec.ts

# Q1：Node 采集器（路径攻击矩阵、staging 副本、上传失败清理）
pnpm vitest run --project unit apps/node/tests/artifact-collect.spec.ts

# Q1：Reviewer 输入准备（manifest 拉取、受控下载、digest 校验、清理）
pnpm vitest run --project unit apps/node/tests/artifact-inputs.spec.ts

# Q1：RunManager 接线（candidate 帧→采集→双受众事件；inputs→initialize）
pnpm vitest run --project unit apps/node/tests/run-manager.spec.ts

# Q6：#62 全部终态路径的输入副本清理（真实文件系统断言，含崩溃/丢失路径）
pnpm vitest run --project resilience apps/node/tests/resilience/artifact-inputs-cleanup.spec.ts

# Q1：桥内 publish_artifact 校验 + read_artifact_input 只读工具
pnpm vitest run --project unit packages/runtime-dsh/tests/artifact-tool.spec.ts \
  packages/runtime-dsh/tests/artifact-input-tool.spec.ts

# Q3：publish_artifact 经真实 DSH 工具调用进入桥（approval allowed/rejected）
pnpm test:dsh-contract

# Web：发布/下载/Reviewer 输入展示
pnpm vitest run --project web apps/web/tests/artifact-list.spec.tsx
```

## 观测（看什么）

- 结构化事件带 `component` 分层：`artifact.store`（Hub blob 落位/完整性故障、
  Node 采集上传，apps/hub/src/modules/artifact/store.ts、apps/node/src/artifact/collect.ts）、
  `hub.audit`（`artifact.publish` 成功审计）、`node.artifact`（采集/输入准备）。
- 落库断言直接读表：`artifact` 行（status/storage_key/sha256）、`team_event`
  （`artifact.changed` 仅发布时出现）、`run_event`（owner/project 双受众
  artifact.candidate）。

## 判定（成功长什么样）

### G6 逐条映射

| 场景 | 判定 | 测试/证据 |
|---|---|---|
| G6-01 Builder 调 `publish_artifact` 相对路径 → candidate 上传，只有 Bob 能打开 | 201 candidate 行（status/storage_key/sha256 正确）；Bob 下载 200 字节一致；Alice 404 且与不存在同形态 | apps/hub/tests/artifact.integration.spec.ts「G6-01」；Node 采集链 apps/node/tests/run-manager.spec.ts「artifact.candidate 帧 → 采集 → 双受众事件」 |
| G6-02 Agent 提交 `../secret.txt` → `ARTIFACT_PATH_OUTSIDE_WORKSPACE` | 桥内工具失败（不发帧）；Node 采集拒绝（不上传）；Hub 无 artifact 行 | packages/runtime-dsh/tests/artifact-tool.spec.ts（桥半场）；apps/node/tests/artifact-collect.spec.ts（Node 半场，`../`、绝对路径、NUL、`%2e%2e`、大小写变体、symlink 逃逸） |
| G6-03 上传过程中篡改内容 → `ARTIFACT_HASH_MISMATCH`，临时文件删除 | Hub 复核实收 sha256 ≠ 声明 → 400；`artifact` 零行；store tmp 目录清空、无 blob | apps/hub/tests/artifact.integration.spec.ts「G6-03」；apps/hub/tests/artifact-store.spec.ts「hash 不匹配」；apps/node/tests/artifact-collect.spec.ts「上传失败：临时副本清理」 |
| G6-04 Bob 发布 candidate → Alice 立即可下载，内容与 digest 一致 | 发布 200（published/publishedAt）；Alice 下载 200 且 sha256 一致；`artifact.changed` Team Event 一条 | apps/hub/tests/artifact.integration.spec.ts「G6-04」；Web 下载按钮 apps/web/tests/artifact-list.spec.tsx「已发布 Artifact 展示元数据与下载按钮」 |
| G6-05 Alice/Bob 试图发布别人的 candidate → 403 | 403 FORBIDDEN（状态仍 candidate）；owner 发布成功；重复发布 409 INVALID_ARTIFACT_TRANSITION | apps/hub/tests/artifact.integration.spec.ts「G6-05」 |
| G6-06 Bob 启动 Reviewer Run → 新 Run 用 Reviewer Revision，Session 分离 | run.start 时拉输入清单；initialize 载荷带 artifactInputs+artifactInputsDir（成对，fail-closed）；每个 Run 的 DSH Session id 独立（`project311-run-<runId>`，P1-11 既有契约） | apps/node/tests/run-manager.spec.ts「Reviewer Run：initialize 带 artifactInputs+dir」「Builder Run：initialize 不携带输入字段」；packages/protocol/tests/artifact-inputs.spec.ts（pair 规则） |
| G6-07 Reviewer 读取发布 Artifact → 受控下载副本，不继承 Builder Workspace，无路径泄露 | manifest 只含已发布且 JSON 无 storageKey/sourceRelativePath；Node 下载副本经 sha256 校验（文件名=artifactId）；Reviewer 只读工具按清单白名单读取、拒绝消息无绝对路径 | apps/hub/tests/artifact.integration.spec.ts「G6-07」；apps/node/tests/artifact-inputs.spec.ts（含篡改→ARTIFACT_HASH_MISMATCH）；packages/runtime-dsh/tests/artifact-input-tool.spec.ts（遍历形 id 不得成路径） |
| G6-08 Reviewer 提交脱敏复核摘要或 Artifact → 时间线闭环 | Reviewer Run 的 run.completed 摘要走 P1-13 双受众投影（project 行 ≤500 字符折叠）；Reviewer 自产的 Artifact 复用 G6-01 全链 | packages/protocol fixture run-event（既有）+ apps/node/tests/run-manager.spec.ts 双受众断言；G6-08 的两浏览器 UI 级断言归 P1-19（见「边界与未覆盖」） |
| #62 全部终态路径清理输入副本（P1-15 评审跟进） | 终态帧（completed/cancelled/runtime.fatal）、协议违例 fail-closed、退出归因（cancelled_forced/runtime_lost）、supervisor lost（runtime_timeout/orphaned_after_node_restart）每条路径终态后 `runtime-inputs/<runId>` 目录真实消失（文件系统断言，非回调记录）；清理收敛在 RunManager 终态单一收敛点 finalizeRun | apps/node/tests/resilience/artifact-inputs-cleanup.spec.ts（8 tests，Q6） |

### 路径攻击矩阵逐条（04 §6.3）

| 攻击样本 | 判定 | 测试 |
|---|---|---|
| `..`（`../secret.txt`） | 拒绝 `ARTIFACT_PATH_OUTSIDE_WORKSPACE`，不上传、不落库 | artifact-tool.spec（桥）+ artifact-collect.spec（Node） |
| 绝对路径（`/etc/passwd`、盘符形） | 同上 | 同上 |
| 双重 URL encode（`%2e%2e/secret`） | 不解码：按字面文件缺失拒绝（`unreadable`/`ARTIFACT_SOURCE_UNAVAILABLE`），绝不发布 | artifact-tool.spec + artifact-collect.spec |
| NUL（`reports/out.md\0`） | 拒绝 `path-outside-workspace` | 同上 |
| symlink 指向根外 | realpath 复验边界 → 拒绝 | 同上（桥与 Node 双侧） |
| symlink 指向根内 | canonical 被采用，允许 | 同上 |
| 大小写变体（`../REPORTS/...`） | 不得借大小写绕过边界 → 拒绝 | 同上（`大小写变体` 用例） |
| 大小超限（52,428,800 上限） | stat 与读入双侧校验 → `ARTIFACT_TOO_LARGE`（真实上限：Hub 侧用 52,428,801 字节 body 实测 413） | artifact-collect.spec（稀疏文件）+ artifact.integration.spec「超限」+ artifact-tool.spec「恰在上限」 |
| 文件在 hash 与 upload 之间变化 | Node 副本=上传字节=被 hash 字节（三同一源）；Hub 仍复算声明比对 → `ARTIFACT_HASH_MISMATCH` | artifact.integration.spec「G6-03」 |
| 下载不校验磁盘 digest | 必须校验：blob 篡改后下载 500，未验证字节不出 Hub | artifact.integration.spec「磁盘 blob 与 DB digest 不一致」+ artifact-store.spec |
| Blob 文件名用用户文件名 | 只用 SHA-256（`sha256/ab/cd/<digest>`） | artifact-store.spec「内容寻址落位」 |

### 候选可见性（§6.1 补充）

- candidate 不产生 `artifact.changed` Team Event（不泄漏给其他成员的 WS 流）；
  Task Room 聚合里 candidate 仅 owner 可见——artifact.integration.spec
  「候选不泄漏」。

## 归因（失败先看哪层）

按 evidence-map：`artifact.candidate` 帧缺失 → 先看 `runtime.bridge`（工具是否
失败：桥内校验）；帧到达但无 Hub 行 → `node.artifact`（采集拒绝/上传失败，
stderr JSON 带 code）；上传 4xx → Hub `artifact.store`/路由（hash/size/幂等）；
发布后 Alice 看不到 → `hub.http`（team_event 是否有 artifact.changed）。

## 取证

```bash
# 本验收的机器证据 = 上述可复跑测试（判定内嵌，无独立 /tmp 步骤）
pnpm test:integration -- apps/hub/tests/artifact.integration.spec.ts
# 证据包（P1-18 起统一）：
# pnpm phase1:evidence -- --run <id> && scripts/secret-scan.sh artifacts/evidence/<scenario>/<attempt>
```

## 边界与未覆盖

- **symlink race（TOCTOU）**：Node 在 realpath 边界复验之后读文件；read 与
  realpath 之间的瞬间换链窗口未做 openat2(RESOLVE_BENEATH) 级硬化（Node 未暴露
  该系统调用）。缓解：上传内容以 sha256 在 Hub 复核、模型每次工具调用需 owner
  一次性批准；完整 TOCTOU 硬化留给 Q7 安全门（P1-20）评估。
- **G6-08 的两浏览器 UI 断言**（Alice/Bob 双端时间线 frame diff）按拆分归
  P1-19 全链 E2E；本 Issue 覆盖到单元/集成层（投影与权限判定）。
- **上传的并发同 key 竞态**由 command_receipt 唯一约束串行化（transactCommand
  既有机制），未在本 Issue 重复压测。
- **输入副本的磁盘生命周期（#62 修订申报）**：RunManager 的**所有**终态路径
  （终态帧投影、协议违例 fail-closed、退出归因 cancelled_forced/runtime_lost、
  supervisor lost runtime_timeout/orphaned_after_node_restart）在终态单一收敛点
  finalizeRun 触发 best-effort 清理，run.start 拒绝路径同样补清；逐路径真实
  文件系统断言见 apps/node/tests/resilience/artifact-inputs-cleanup.spec.ts。
  Node 进程崩溃（清理代码来不及执行）后的残留目录不自动回收——P1-16 孤儿回收
  只回收进程；残留按 runId 目录隔离不串扰，待显式重跑或人工清理。
- **Reviewer 输入清单条目上限 64**（协议层 hard cap；#64 修订申报）：Hub
  input-manifest 在 Task 已发布 Artifact 超 64 条时 **fail-closed 显式拒绝**
  （409 `ARTIFACT_INPUT_MANIFEST_TOO_LARGE`，不下发半份清单、不静默溢出）；
  Node 侧 prepareArtifactInputs 把该码原样透传为 run.start 拒绝（ack
  accepted=false，旧 Node 对未知码退回状态码折算 CONFLICT）。机器证据：
  apps/hub/tests/artifact.integration.spec.ts「超限（#64）」（65 条已发布 →
  409 专用码）、apps/node/tests/artifact-inputs.spec.ts「manifest 超限（#64）」
  （透传 + 不写副本）、packages/protocol/tests/artifact-inputs.spec.ts
  「上限」（schema 上限恰好通过 / 超 1 条拒绝）。

## 复跑

```bash
# 干净环境（需 Docker：Q2 一次性 PostgreSQL）
corepack enable && pnpm install --frozen-lockfile
pnpm check                 # Q0 + Q1 + web
pnpm test:integration      # Q2（含 artifact.integration.spec）
pnpm test:dsh-contract     # Q3
```
