---
name: dev-main
description: whalepod 默认开发方式——从认领 Issue 到开 PR 的完整走法。改代码、修 bug、做功能时先读这份。
---

# 默认开发方式（dev-main）

适用：有代码要改。只研讨不改代码时看 `discuss`。

## 走法

1. **从 Issue 出发**。活都在 GitHub Issue（P1-XX）。没有就先按 skill `file-issue` 登记； Issue 里「怎样算修好」说不清就先问，别猜。
2. **拉短生命周期分支**：`feat/p1-<issue>-<slug>` 或 `fix/p1-<issue>-<slug>`，从最新 main 拉出。
3. **先写会红的检查**（TDD）：正向、拒绝、重复、故障路径都要有断言。测试与实现同属这个 Issue，不允许「后续补测试」。
4. **最小改动**。行为不变不重构周边；目标要能验。
5. **跑受影响的门**，不要无故全仓库跑：
   - 领域/协议改动 → Q0/Q1；DB/Hub → 加 Q2；DSH 相关 → 加 Q3；Node → Q1/Q2（故障面加 Q6；旧 Q4 编号已随 #100 退役，无独立命令）；浏览器 → Q5。
6. **验证走真人路径**：用模块 interface（Fastify inject、Fake/DSH Adapter、Playwright），不抄近道。六原语见 `docs/agent/ai-harness-principles.md`。
7. **留下证据**：新链路补验收文档（`docs/agent/acceptance-template.md`）并登记索引；可复跑脚本放 `scripts/`。
8. **提交**：`git commit -s`，说明写为什么改。开 squash PR，标题带 `P1-XX`，描述写验了什么、跑了哪些门。

## 红线

- 没有机器证据就没有完成；「界面看起来正常」不是判据。
- 业务代码不得直接 import `@deepseek-ai/*`；只有 runtime-dsh adapter 包和 runtime app 可以（依赖方向见 02 文档）。
- 密钥、Token、绝对路径不进代码、日志、截图、证据包；提交前 `scripts/secret-scan.sh`。
- Run 终态不复活；Runtime 崩溃不自动重放副作用工具。
- 禁 force push / `reset --hard` / `stash drop`；本地直接推 main 已被 hook 拦截。
- 改动承重设计（状态机、协议、权限）先看 `docs/adr/`，必要时先写 ADR。
- 仓库正式名 **WhalePod**（#133 定名）：新代码与新文档一律 `@whalepod/*`、`WHALEPOD_*`、`whalepod-node`；历史代号 tabtin / project311 只保留在历史文档（ADR、验收记录、release notes）里，不要扩散。
