# 候选交付物发布前检查验收

- Issue：P1-313；对应 G6-01/G6-04，Q0/Q1/Q2/Q5。
- 日期：2026-10-14。先红：4 条缺入口/缺确认判据失败；页面：13 条通过；Q0/Q1：1488 条通过（7 条预期失败）；Q2：12 条通过；Q5 双成员：2 条通过。

## 用户路径与判定

Bob 在任务房检查 candidate 文本或下载文件，状态仍为 candidate；Alice 的聚合无候选且内容接口返回 404。Bob 显式确认发布给团队后，Alice 通过网页下载，字节 SHA-256 必须与同一 artifact 的摘要相同。预览采用文本展示，不执行 HTML/script。Artifact owner 是候选读取依据，不随 Task 改派自动转移。

## 驱动与观测

```bash
pnpm -r --if-present build
pnpm exec vitest run --project web apps/web/tests/artifact-list.spec.tsx
pnpm exec tsx scripts/with-test-postgres.mts vitest run --project integration apps/hub/tests/artifact.integration.spec.ts
pnpm exec playwright test --config playwright.operations.config.ts --project p1-19 --grep 'G5：Bob|G6-04 Artifact'
```

Q5 走双浏览器、生产 Hub bin、真 Node/Runtime 和 DSH replay；两个用例顺序执行，首个生成真实候选。operations 配置独立端口及临时目录，不清理其他现场的 Node/Runtime。会话网络 trace 关闭。

## 取证与归因

成功证据为 `artifacts/evidence/candidate-inspection/result.json`，带 `component=web.artifact`、run/artifact 身份、发布前后状态、对端 404、声明与下载摘要；缺任一环机器判据失败。文件正文、Cookie、Token、绝对路径不入包。失败包复用 `artifacts/evidence/e2e/`。

入口/确认错 → web.artifact；404/受众错 → hub.http；下载摘要错 → artifact.store。证据地图已登记。

```bash
bash scripts/secret-scan.sh artifacts/evidence/candidate-inspection
```

## 边界

不增加二进制在线渲染器。超大文本与不支持格式明确下载检查；不强制用户预览后才能发布。发布前后的内容身份由既有不可变 artifact 摘要及受控存储校验保证。真实模型调用不在本链范围。
