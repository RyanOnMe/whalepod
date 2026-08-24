---
name: dsh-upgrade
description: DSH 或关键依赖的版本升级列车。任何 @deepseek-ai/* 版本变动、catalog/lockfile 升级时必须走这份。
---

# DSH 升级列车（dsh-upgrade）

DSH 是预览版，升级是高风险动作。三条红线（06 文档 §2.1）：

1. 禁止 `latest`、`next`、semver range 自动漂移。
2. 禁止业务模块直接 import DSH；只有 `packages/runtime-dsh`（和 `apps/runtime`）依赖 DSH 包。
3. 禁止把 DSH 升级混进功能、重构或批量依赖 PR。

## 步骤

1. 新建 `chore/dsh-upgrade-<from>-to-<to>` 分支与单独 Issue。
2. 读官方 release note、架构文档与受影响 package 的 README。
3. 只改 pnpm catalog、lockfile 和 `dsh.lock.json` 的 `version`/`verifiedAt`。
4. 跑 `pnpm test:dsh-contract`（Q3 十项契约探针）；失败先记录公开 interface 差异，不要先改业务。
5. 只在 `packages/runtime-dsh` 修 Adapter；业务与 UI 不随 DSH 改名。
6. 跑 Q0–Q8，比较标准 E2E 的 Team Event golden file。
7. 在一个非生产试用实例跑 Builder/Reviewer 标准闭环。
8. 合并后保留上一版 runtime image 与 lockfile 至少一个 Alpha 发布周期。

## 回滚

- Hub 数据 migration 不依赖 DSH schema，DSH image 可独立回滚。
- 已创建 Run 固化其 DSH version，回滚不改历史 Run。
- 回滚后不恢复新版本上正在跑的 Runtime：标记 `failed(runtime_version_rolled_back)`，用户显式 rerun。

## 其他依赖

非 DSH 依赖同样精确版本 + frozen lockfile；安全类升级可单独 PR 走快速评审，但仍要过 Q0–Q2 与受影响门。
