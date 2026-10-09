# 测试代码 typecheck 接入与基线棘轮验收（#178 / #183，A0-7）

- 对应门禁：**Q0**（`pnpm check`）
- 对应 Issue：#183（#178 家族）；本批收口 protocol/db 两包 + 建棘轮，hub/node 仍留 deferral
- 上次验证：2026-10-09 · `chore/p1-a0-7-evidence-baseline` · 结果 PASS（含棘轮红/绿自证）

## 验的是哪条链路

**测试代码里的类型错误能不能逃过 Q0。** 根 `typecheck` 只跑 `tsc -b`（只构建根项目），
包能否进 Q0 完全取决于各包自己的 `typecheck` 脚本；而各包 `tsconfig` 只 `include src/**`——
于是 `tests/` 里的漏 import、拼错类型名、签名漂移在合并前没人管，只在运行时偶发暴露。

## 机制（两层）

1. **接线面**：每个有 `tests/` 的包/应用必须有 `tsconfig.test.json`（`extends` 本包 tsconfig、
   `rootDir` 抬到包根、`composite:false`、`noEmit`），且 `typecheck` 脚本包含
   `tsc -p tsconfig.test.json`。这条由 `scripts/check-boundaries.ts` 的
   `checkTypecheckWiring` 机检；未接线的包必须在 `TYPECHECK_WIRING_DEFERRED` 表里，
   **表只许缩小**（新增未接线包进不来）。
2. **棘轮（本批新增）**：deferral 表里原先只写「N 个存量错误」这行字——2026-10-09 实测发现
   它已经烂了：hub 记 30 实际 **39**、node 记 29 实际 **31**。现在数字由
   `scripts/lib/typecheck-test-baseline.ts` 承载、由 `scripts/tests/typecheck-test-baseline.spec.ts`
   机检：每个未接线包跑一次 `tsc -p tsconfig.test.json`（口径同 #183），错误行数必须
   **严格等于**基线；变多 = 新引入（去修，不许改数字），变少 = 必须把数字改小（只许向下）。
   同一 spec 还钉死基线表与 deferral 表的**键一一对应**（接线一片 = 两处同时删）。
   本机成本：两条 tsc 合计约 3s，进 Q0（CI 的 check job 也会跑）。

## 本批实测与改动

| 包 | 起 | 止 | 怎么来的 |
|---|---|---|---|
| `packages/protocol` | 1 | **0（已接线）** | `tests/plugin-api.spec.ts` 的 `./src/...` 相对路径写错 → `../src/...` |
| `packages/db` | 2（记录里写 1，已漂） | **0（已接线）** | outbox 里 `row?.x.getTime() - y` 的左操作数为可选（改为期望值断言）；migration 测试里无效的 `as { n: number }`（改 Row 索引签名 + `Number()`） |
| `apps/hub` | 39 | **25** | 修认证限流覆盖值类型（`HubConfig.rateLimit` → `Partial<RateLimitConfig>`，与 app.ts 的 `{...默认, ...覆盖}` 合并语义一致）、审批策略断言类型、setup 并发 `PromiseSettledResult` 窄化、A0-4 引入的两处同步探针（`waitForValue` 契约是 Promise 探针） |
| `apps/node` | 31 | 31（仍 deferral） | 需先拆 `apps/node/tests/integration/*` 对 `apps/hub/tests/helpers.js` 的跨包 import（共享脚手架要挪进 `packages/testkit`），否则接线即一片 TS6059 噪音 |

## 判定（怎么知道它有用）

- 棘轮红/绿自证：把 hub 基线临时改成 24（实际 25）⟹ spec 红并打印
  `apps/hub: 25 > 基线 24`；还原 ⟹ 绿。
- 反向自证：把 `packages/protocol` 的相对路径改回错的 ⟹ `pnpm check` 在 typecheck 段红
  （本批就是这么发现它的）。
- 接线必须真的能红：两个包接线时各修掉了真实错误（上表）。

## 复跑

```bash
pnpm check                                                    # Q0：含接线面机检 + 棘轮
pnpm exec vitest run --project unit scripts/tests/typecheck-test-baseline.spec.ts
cd apps/hub && pnpm exec tsc -p tsconfig.test.json | grep -c "error TS"   # 手测某个包当前存量
```

## 未覆盖 / 边界（别读成「测试类型都干净了」）

- `apps/hub`（25）、`apps/node`（31）**仍未进 typecheck 面**——它们的测试类型错误今天仍逃得过 Q0，
  只是「不许再变多」。真正清零要按 #183 的分批走，先做 node 的跨包 import 拆分。
- node 侧计数**包含**经跨包 import 拖进来的 hub 源文件错误——它是「node 的 tests typecheck 面」
  总量，不是「node 自己写错的行数」；拆完耦合必须重测这个数字。
- 棘轮只保证「不新增 + 数字与现实一致」，不保证错误本身无害：低风险测试里的类型错误
  （如测试替身形状不符）仍可能在运行时表现为假绿——清完才能真正说这句话。
