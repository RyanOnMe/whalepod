---
name: acceptance-harness
description: 给一条链路补「能自己点、自己看、自己判」的验证。写验收文档、加探针、做 evidence 包、判断某模块验证是否做完时用。
---

# 验收 Harness（acceptance-harness）

原则全文：`docs/agent/ai-harness-principles.md`。这份 skill 是操作版。

## 什么时候算验完

AI 能自己**触发、观测、判定**这条链路，且别人改坏它检查会红。只有日志没有判据、只有检查没法触发，都不算。

## 给新链接补验证的顺序

1. 挑一条人最常手工验的用户路径（不是某个函数）。
2. 找/做驱动入口：Fastify inject、Fake Adapter、`dsh-llm-replay`、Playwright——必须走真人同一处理路径。
3. 在关键步骤埋结构化事件：带 `component` 分层与 `runId/traceId/commandId/eventSeq`，埋点放最底下的共享包（testkit / protocol）。
4. 写下判定：成功长什么样；没数据、缺一环必须 FAIL。触发和判定拆成两个可独立运行的入口。
5. 补归因：这条链路失败时看哪层、哪份日志，写进文档并更新 `docs/agent/evidence-map.md` 的「现象 → 先看哪层」表。
6. 补取证：能按 runId/scenario 一把捞齐证据；出包必过 `scripts/secret-scan.sh`。
7. **登记**：验收文档用 `docs/agent/acceptance-template.md` 写成 `<场景>-acceptance.md`，挂进 `docs/agent/README.md` 索引；可复跑脚本放 `scripts/`。漏登记等于没做。

## 验收文档必须说清

- 验的是用户哪条路径；怎么触发；成功长什么样（无证据即失败）。
- 日志和数据在哪；哪些边界没验到、为什么；下次怎么复跑；上次结果与 commit。

## 踩坑线

- 不允许「看起来没报错就算过」。
- 不开测试专用通道；绕过 API 直接写库验出来的不算数。
- 绿一次不算稳；留下别人改坏就会红的检查。
- 证据、密钥语料、`/tmp` 三不相容：证据脱敏入包，密钥永不出现，步骤不留 `/tmp`。
