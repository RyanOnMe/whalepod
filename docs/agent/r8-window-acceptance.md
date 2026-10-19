# R8 派发前崩溃窗口验收（#399）

## 真人路径与故障驱动

真浏览器启动执行 → 真 Hub 事务写 Run / Outbox → 物理 socket 断连导致派发失败 → SIGKILL Hub → 重启后 Outbox 续派发 → 真人批准 → Run completed。Hub、Node、Runtime 均走生产包解析，不插入业务表、不伪造 ack 或设备状态。

原固定 4 秒断连会被 UI 耗时耗尽。现在网络故障缝以 faultId 显式保持，只有相同持有者释放才恢复；错误 id、试图用定时断连覆盖保持、非法时长都拒绝。原 R4/R5 定时断连保留。故障控制仅在 E2E 的鉴权本地控制口，不进入产品 API。

## 观测与判定

- node.gateway：held / faultId / offline / liveSockets / blockedConnectionAttempts。
- hub.outbox：崩溃前 Run 必须 queued/dispatching，仅一个 run.start、acked=false、attempts>=1；同时对应断连仍保持且零活连接。未命中窗口的负控必须失败，不放宽 ack 判据。
- 重启后必须出现新派发（attempts 比崩溃前增加且至少 2）、acked=true，最终 completed；事件序号无缺无重，Runtime 由产品路径回收。

独立判定器 `apps/web/tests/e2e/r8-window.ts` 与 CLI `scripts/verify-r8-evidence.mts` 对保存的窄投影重判。缺 JSON、缺环、已 ack、错误 faultId、活连接、无失败派发或没有重启后新派发均 FAIL。单测用可控时钟推进 60 秒证明保持不会过期，并覆盖释放幂等和旧 id 不能释放新故障。

## 取证与复跑

证据：`artifacts/evidence/r8-window/result.json`，仅包含分层故障状态与派发事实，无 Token、路径或完整协议帧。每次启动 p1-19 先删除旧结果，不能借历史 PASS。本地定向 R8 已通过，独立重判 PASS；完整组合 Q5 待三项分支装配后记录。

```bash
pnpm exec playwright test --config playwright.operations.config.ts --project p1-19 --grep 'R8：'
pnpm exec tsx scripts/verify-r8-evidence.mts artifacts/evidence/r8-window/result.json
scripts/secret-scan.sh artifacts/evidence/r8-window
```

完整 `pnpm test:e2e` 已在 p1-19 后接入独立重判。完整套件连续冷启用 `bash scripts/q5-loop.sh N`；发布所需 20 连仍以该脚本的 20 轮结果为准。
