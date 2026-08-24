---
name: file-issue
description: 把口头说的 bug、想法、隐患整理成 GitHub Issue。只记账，这轮不改代码。
---

# 登记 Issue（file-issue）

问题只认 GitHub Issue。登记不等于这周就修。

## 步骤

1. **查重**：先搜已有 Issue，有就补充评论，不开新的。
2. **写清四件事**：
   - 现象：用户哪条路径上发生了什么（最好对应 04 文档的 G/R 场景）
   - 原因：已知归因；不知道就写不知道，别编
   - 影响：谁受影响、多严重
   - 怎样算修好：可证伪判据（「期望 X、实际 Y」）
3. **打标签**（05 文档 §1）：`type:*`、`phase:1`、`area:domain|hub|web|node|runtime|security|test`、`priority:p0|p1`、`blocked|ready|needs-decision`。Phase 1 默认 `p0`。
4. **对上工作包**：能归入 P1-01…P1-20 的挂上对应编号；归不进去的提醒用户：可能在膨胀第一阶段范围（06 文档风险表第 15 条）。

## 规则

- 只记账，**这轮不改代码**；要修另起 Issue 驱动的开发流程（`dev-main`）。
- 一个 Issue 对应一个可独立验收的纵向切片，不按水平层拆。
- 涉及承重决定（状态机、协议、权限、隔离）的，标 `needs-decision` 并提示先 ADR。
