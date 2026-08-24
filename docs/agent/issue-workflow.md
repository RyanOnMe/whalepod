# 问题怎么从发现走到合入

问题只认 GitHub Issue。看见隐患先查重再登记；登记不等于这周就修。

## 1. 发现 → 登记

口头说一个 bug 或想法，用 skill `file-issue` 整理成 Issue，写清四件事：

- **现象**：用户哪条路径上发生了什么
- **原因**：已知的归因，不知道就写不知道
- **影响**：谁受影响、多严重
- **怎样算修好**：可证伪的判据，对应 04 文档的 G/R/Q 编号更好

标签体系（05 文档 §1）：`type:*`、`phase:1`、`area:*`、`priority:p0|p1`、`blocked | ready | needs-decision`。
Phase 1 的 Issue 默认 `priority:p0`；只有文案、视觉微调、非 Chromium 兼容可标 `p1`。

已经聊清楚的一坨想法：`to-prd` 收成需求，`to-issues` 拆成能分开领的任务（纵向拆分，不按水平层拆）。

## 2. 认领 → 开发

- 从 Issue 拉分支：`feat/p1-<issue>-<slug>` 或 `fix/p1-<issue>-<slug>`（skill `gitflow`）。
- 还没想明白就先研讨（skill `discuss`），方案不稳就多问几句，别急着写代码。
- 先写一条会红的检查，再改实现（TDD）；正向、拒绝、重复、故障路径都要有断言。
- 跑与改动有关的门，不要无故全仓库跑。

## 3. 验证 → 留下

- 能用现成探针/门禁就用；没有就按 [ai-harness-principles.md](./ai-harness-principles.md) 的六原语补一条。
- 验证一条链路后写验收文档（模板：[acceptance-template.md](./acceptance-template.md)），登记进 [索引](./README.md)。
- 证据和脚本不能只在 `/tmp` 或对话里。

## 4. 提交 → 合入

- `git commit -s`（DCO）；提交说明写为什么改，不记流水账。
- 开 squash PR，标题带 `P1-XX`；描述里写验了什么、跑了哪些门。
- 协议、migration、DSH Adapter、安全策略的 PR 至少两人 review。
- DSH 升级永远单独 PR（skill `dsh-upgrade`）。
- 合完在 Issue 里写闭环：验了什么、还有什么限制、哪些情况没覆盖，然后关 Issue。

## 5. 什么时候升级成「大改盯方向」

特别大的改法（拆成多波、多人/多 AI 并行）才用总控机制：先定这轮要的一个能用命令检查的业务结果（北极星），再拆波次；每一波只认自己跑过那个命令，子任务报完成不算数。日常小修不用这套，但「先想清楚、再改、再验、再留下」都要走。
