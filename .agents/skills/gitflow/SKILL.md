---
name: gitflow
description: 分支、提交、PR 与评审规则。开分支、写提交说明、开 PR、合 PR、升级依赖时读这份。
---

# 分支与合入（gitflow）

第一阶段不沿用 1.x 的 release 分支体系（05 文档 §6）。

## 分支

- `main` 受保护：只收 squash PR；本地 hook 拦截直接推 main 与非快进推送，GitHub 端同样设保护。
- 短生命周期分支：`feat/p1-<issue>-<slug>`、`fix/p1-<issue>-<slug>`；DSH 升级用 `chore/dsh-upgrade-<from>-to-<to>`。
- 一个 Issue 一个 squash PR；PR 标题带 `P1-XX`。

## 提交

- 必须 DCO sign-off：`git commit -s`（commit-msg hook 强制）。
- 约定式提交，说明写**为什么改**，不记流水账。例：`feat(domain): define task and run lifecycle`。
- 先失败的测试要在提交历史里可见（先红后绿）。
- 提交不包含生成缓存、真实密钥、本机绝对路径；存疑先 `scripts/secret-scan.sh`。

## PR 与评审

- 描述写：验了什么、跑了哪些门、证据在哪。
- 不允许以「后续补测试」合入。
- 协议、migration、DSH Adapter、安全策略改动至少两人 review。
- 本地与 CI gate 按受影响范围跑；P1-19/20 相关必须全量。
- 合自己的 PR：确认 CI 绿、review 过、squash 合入后删分支。
- 合别人的 PR：先看影响面（波及哪些模块/场景），再看代码，再批，再合。只丢来链接没说「合」，就只评估不动手。

## 禁止

- force push、`reset --hard`、`stash drop` 压过他人工作。
- DSH/依赖升级夹进功能 PR（走 skill `dsh-upgrade`）。
- 在 PR 里静默改变承重模型；先 ADR。
