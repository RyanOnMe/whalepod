# AGENTS.md — 在这个仓库里怎么干活

**WhalePod**（正式名，2026-09 定名，见 #133）：面向 3–10 人小团队的 DSH 多人协作发行版。全新仓库，不迁移 1.x 代码。历史代号 tabtin / project311 只出现在历史文档（ADR、验收记录、release notes）中；新增代码与文档一律用 WhalePod（`@whalepod/*`、`WHALEPOD_*`、`whalepod-node`）。
本文件是人和 AI 进仓库的第一站：先读这里，再按需要往下走。

## 权威文档（冲突时以这些为准）

1. [CONTEXT.md](./CONTEXT.md) — 领域语言（Team/Task/Run/Workspace…）
2. [README.md](./README.md) — 第一阶段交付定义与边界，含完整阅读顺序
3. [03-领域模型与运行协议.md](./03-领域模型与运行协议.md) — 协议字段与状态机
4. [04-验收矩阵与测试策略.md](./04-验收矩阵与测试策略.md) — Q0–Q9 质量门、G/R 场景
5. [05-里程碑与Issue拆分.md](./05-里程碑与Issue拆分.md) — P1-01…P1-20 Issue 与依赖
6. [docs/adr/](./docs/adr/) — 难以逆转的架构决策；改承重决定先写 ADR

## 干活方式：先选模式

**研讨**（skill: `discuss`）
梳理、调研、看现场，没有要合并的代码。不主动提交、不推送、不开 PR，除非明确说「提交」。

**开发**（skill: `dev-main`）
默认方式。要领的活都在 GitHub Issue（P1-XX）里：先认领 Issue，再开短生命周期分支，当场验证。
没有现成验证手段时，按六原语补一条（见下），而不是「看起来没报错就算过」。

## git 纪律（skill: `gitflow`）

- 受保护 `main`；本地 hook 已拦截直接推 main 与非快进推送，服务器端同样设为受保护。
- 分支：`feat/p1-<issue>-<slug>`、`fix/p1-<issue>-<slug>`；一个 Issue 一个 squash PR，标题带 `P1-XX`。
- 提交必须 DCO sign-off：`git commit -s`（commit-msg hook 强制）。
- **DSH 版本升级永远单独 PR**（`chore/dsh-upgrade-<from>-to-<to>`），步骤见 skill `dsh-upgrade`。
- 禁止：force push、`reset --hard`、`stash drop` 等不可逆操作压过别人的工作；协议、migration、DSH Adapter、安全策略的 PR 至少两人 review。
- 不允许以「后续补测试」合入；测试属于同一 Issue 的交付物。
- clone 后跑一次 `scripts/install-hooks.sh` 启用本仓库 hooks。

## 质量门（P1-01 起逐步生效）

| 门 | 命令 | 状态 |
|---|---|---|
| Q0 静态门 | `pnpm check` | 生效中（P1-01 起） |
| Q1 单元门 | `pnpm test:unit`（领域分支覆盖 ≥95%） | 生效中（P1-02 起；覆盖率阈值见 packages/domain/vitest.config.ts） |
| Q2 数据门 | `pnpm test:integration`（真实 PostgreSQL） | 生效中（P1-04 起，Docker 一次性容器；#43 起 CI 同跑） |
| Q3 DSH 契约门 | `pnpm test:dsh-contract` | 生效中（P1-11 起） |
| Q4 Node 门 | ~~`pnpm test:node`~~ | 已退役（#100）：从未建立；Node 覆盖归 Q1/Q2/Q6 |
| Q5 浏览器门 | `pnpm test:e2e`；连续 20 次用 `bash scripts/q5-loop.sh 20` | 生效中（P1-19 起） |
| Q6 故障门 | `pnpm test:resilience` | 生效中（P1-16 起） |
| Q7 安全门 | `pnpm test:security`（security project + secret-scan 自检与实扫 + 依赖许可 gate 四半边） | 生效中（#106 起首用例族：口令政策；许可/SBOM 面见 #24 与 release-artifacts） |
| Q8 性能门 | `pnpm test:load`（短档：10 WS 传播 p95 + 2 Run ingest p95 + 空闲段 RSS 斜率；30min/50Run 长档挂 release 手动） | 生效中（P1-20 起；判据数字以 ubuntu runner 为准，见 load-performance-acceptance） |
| Q9 安装门 | `pnpm test:compose-smoke` | 生效中（P1-20 起；镜像+空卷 15 分钟硬闸） |

现在就能跑的：`scripts/baseline-check.sh`（环境基线）、`scripts/secret-scan.sh [路径]`（敏感语料扫描）。
改代码时跑与改动有关的门，不要无故跑全仓库；P1-19/20 必须全量。

## 验证六原语

验一条改动，六件要齐，缺一不算验完（详见 [docs/agent/ai-harness-principles.md](./docs/agent/ai-harness-principles.md)）：

1. **驱动**：走真人同一条处理路径（HTTP/WS 契约、Fake Adapter、DSH replay），不开测试专用近道。
2. **观测**：结构化事件，带 `component` 分层字段，不看截图、不正则爬日志。
3. **判定**：成功标准写成能跑的检查；没数据、缺一环必须失败。
4. **归因**：按 component 定位断在哪层（hub.* / node.* / runtime.bridge / dsh.agent…）。
5. **取证**：日志位置查 [docs/agent/evidence-map.md](./docs/agent/evidence-map.md)；证据脱敏后入包，绝不留 `/tmp`。
6. **发现**：验过的步骤登记到 `docs/agent/`（acceptance 文档）或 `scripts/`（可复跑脚本），并挂进索引。漏登记等于没做。

## 红线（随时生效，不等代码）

- 没有机器证据就没有完成；任一关键场景不得用「界面看起来正常」判定。
- 密钥、Token、绝对路径不进 git、不进日志、不进团队投影；提交前过 `scripts/secret-scan.sh`。
- 业务代码不得直接 import `@deepseek-ai/*`；只有 `packages/runtime-dsh` 和 `apps/runtime` 可以。
- DSH 锁精确版本，禁 `latest`/range；升级走 `dsh-upgrade` 流程。
- Run 终态禁止复活；Runtime 崩溃后不自动重放可能有副作用的工具。

## 目录地图

```
.agents/skills/     开发 Skill（叫到才走）
.githooks/          git 护栏（install-hooks.sh 启用）
docs/agent/         harness 文档：原则、取证地图、验收模板、issue 流程
docs/adr/           架构决策记录
scripts/            可复跑脚本（基线核验、敏感扫描、hooks 安装）
prototype/          产品原型（非生产代码）
01-…07-*.md         第一阶段方案权威文档
```

## Skills 索引

| Skill | 什么时候用 |
|---|---|
| `discuss` | 只研讨/调研，不改代码不提交 |
| `dev-main` | 默认开发：从 Issue 到 PR 的完整走法 |
| `gitflow` | 分支、提交、PR、评审规则 |
| `dsh-upgrade` | DSH 或依赖版本升级列车 |
| `acceptance-harness` | 给一条链路补「能自己点、自己看、自己判」的验证 |
| `file-issue` | 把口头问题整理成 GitHub Issue |
