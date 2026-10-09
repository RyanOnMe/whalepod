# 2026-10-08 门禁分级：Q0–Q9 落到 G0/G1/G2

> 状态：已接受（[阶段总纲](./2026-10-08-release-harden-validate-handoff-plan.md)配套）。
> 依据：《04-验收矩阵与测试策略.md》全文（命令、矩阵、阈值原文以 04 为准，本表只做分级映射，不复述数字）。
> 动机：单人维护 + 本地无 Docker，Q0–Q9 全量全阻断不可持续；按"安全正确性 / 日常质量 / 发布证据"三级触发，
> 用最低维护成本守住关键不变量。

## 一、分级定义

| 级别 | 含义 | 触发 |
|---|---|---|
| G0 安全与正确性硬门禁 | 失败禁合、禁发 | 每次 PR 按触发面必跑 + 每次 release 全跑 |
| G1 日常工程质量门禁 | 常规 PR 按受影响面必跑，存量债有受控例外 | PR（按面） |
| G2 观察与发布证据 | 不要求每 PR 跑 | release / 风险触发 / 定时 |

"Q0–Q9 全绿"从此按"G0 常绿 + G1 按面绿 + G2 按触发绿"解读，不再要求每个 PR 跑全部门禁。

## 二、映射表

| 门（命令，见 04 §1） | G0（硬） | G1（按面） | G2（发布/风险触发） |
|---|---|---|---|
| Q0 静态门 `pnpm check` | 生产面 typecheck、`check:boundaries`、`check:protocol-generated`、`check:plugin-fixture`（协议/依赖不变量，便宜且快，每 PR 跑） | `format:check`、`lint`、新增/改动 tests 的 typecheck（存量 61 个错误按 #183 基线：分类、先修关键链路、禁新增） | — |
| Q1 单元门 `pnpm test:unit`（领域 ≥95%） | release 时全绿计入发布门；其中 Run 终态/Approval/Artifact 状态机与权限矩阵子集视为 G0 不变量 | 领域/协议改动 PR 必跑 | — |
| Q2 数据门 `pnpm test:integration` | release 时全绿计入发布门 | DB/Hub 改动 PR 跑受影响文件 | — |
| Q3 DSH 契约门 `pnpm test:dsh-contract` | release 必跑；凡动 `packages/runtime-dsh`、`apps/runtime`、`dsh.lock.json`、catalog 的 PR 必跑（协议兼容性） | — | 不碰 Runtime 的 PR 可不跑 |
| Q4 Node 门 | 墓碑（#100 退役）：Node 用例由 Q1/Q2/Q6 真实执行，不独立触发 | — | — |
| Q5 浏览器门 `pnpm test:e2e` | release 必跑：真实装配双人闭环 + 故障变体（R1/R2/R4–R9 关键项）；动 run/node/runtime/orchestrator 的 PR 跑受影响 project | Web 改动 PR 跑受影响 project | 连续 20 次（`bash scripts/q5-loop.sh 20`）只在 release 前跑；日常不把 20 连跑当最高优先级 |
| Q6 故障门 `pnpm test:resilience` | release 必跑（R1–R9 关键场景） | 动 run/node/supervisor/outbox 的 PR 必跑 | — |
| Q7 安全门 `pnpm test:security` | release 必跑；动认证/授权/审批/投影/artifact/插件面的 PR 必跑（fail-closed + 负向测试） | — | 非安全面 PR 可不跑 |
| Q8 性能门 `pnpm test:load` | — | — | release **证据**（短档，归档 JSON）；**runner 是证据不是判据**（共享 CPU，见尺子账其六）：权威判需专用 4CPU/8GiB Linux，当前未取得（#298）——Alpha 期不声称性能达标；30min/50Run 长档挂 release 手动 |
| Q9 安装门 `pnpm test:compose-smoke` | release 必跑（空卷 15 分钟硬闸；口径=A0-5 收窄的「安装面段」，见 [compose-standard-loop-acceptance](./compose-standard-loop-acceptance.md)） | A0-5 起：动 `scripts/compose-smoke.mts`、`deploy/`、Hub 启动面（migrate/server/inventory 上报）或邀请/配对/workspace 投影面的 PR 手工跑一次（CI 触发面见 #116 延迟项） | 日常功能 PR 不跑 |

## 二·补、CI 接线现状（A0-6 核对并修正，2026-10-09）

盘点发现一处治理缺陷：本文把 Q3/Q6/Q7 写成 G0「release 必跑、PR 必跑」，但
`.github/workflows/check.yml` 当时只跑 Q0（`pnpm check`）与 Q2——**「必跑」是人心里的门**。
A0-6 把它们接到既有必检 job 上（不新增 job = 不改仓库保护规则）：

| 门 | 接线位置 | 本机实测 | 备注 |
|---|---|---|---|
| Q3 `pnpm test:dsh-contract` | `check.yml` · `check` job | 39 用例 ~3.5s | 无 PG/Docker/网络 |
| Q7 `pnpm test:security` | `check.yml` · `integration` job | ~17.5s（含一次性 PG） | secret-scan 自检 + 实扫 + 许可门同命令 |
| Q6 `pnpm test:resilience` | `check.yml` · `integration` job | 32 用例 9.5s | 含一次性 PG |
| Q5 / Q8 / Q9 | 保持 release 级（q5-release.yml / 手动） | — | 真实浏览器 / 机器规格判据 / 镜像构建；口径见 compose-standard-loop-acceptance |

口径（写文档时照这条）：**「必跑」只许写在 CI 真会跑的门上**；不接 CI 的门要写清为什么，
以及「它因此不能作为 PR 门」这一事实。能力边界与判据清单见
[runtime-capability-contract](./runtime-capability-contract.md)。

## 三、PR 触发规则（按改动面）

| 改动面 | 必跑 |
|---|---|
| `packages/protocol`、protocol 生成物 | Q0-G0 全子集 + Q1 相关 + Q3（若动 wire） |
| `packages/runtime-dsh`、`apps/runtime`、`dsh.lock.json`、catalog | Q0-G0 全子集 + Q3 + 相关 Q2/Q6 |
| `packages/db`、migration、`apps/hub` | Q0-G0 全子集 + 相关 Q1/Q2；涉 run/orchestrator/outbox 加 Q6 相关 |
| `apps/node` | Q1/Q2 相关；涉 supervisor/spool/approval 转发加 Q6 相关 |
| `apps/web` | Q0-G0 全子集 + 相关 Q5 project（`--project=` 定向，不无故全量） |
| `scripts/*.mts`、harness | 相关门 + #76 缝补上前注明 typecheck 盲区 |
| 纯文档（`docs/`、`*.md`） | `format:check` + `secret-scan` 即可 |

## 四、release 发布门（G0 全量项）

发 `v0.1.0-alpha.1`（及后续 release）前必须同时满足：G0 表中全部 release 项全绿；
Q1/Q2/Q6/Q7 全绿；Q5 真实装配闭环 + 故障变体全绿；Q8 短档 + Q9 空卷证据留档；
附带总纲规定的限制声明（互信团队 / DSH Preview / 无强隔离承诺 / 副作用不可撤销 / 无 Project ACL /
附件受限）。**不以关闭全部历史 Issue 为前提，不降 G0 换速度。**

## 五、本地环境说明

本地无 Docker：Q2/Q5/Q6/Q9 以 CI 为准，PR 合并要求 CI 双绿，并在 PR 描述中如实列出
"本地跑了什么 / 哪些门交 CI"（沿用既有"未覆盖/待 CI"清单口径）。

## 六、报告纪律（与 Issue 关闭率脱钩）

工程进度与产品进展分开报告。每轮只回答三问：消除了什么真实风险？验证了什么用户假设？
有没有增加不必要的长期维护负担？答不上任一问的工作重新评估优先级。
