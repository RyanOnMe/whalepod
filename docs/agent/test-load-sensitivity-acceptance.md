# 判据的负载敏感性收口（#296）

- 对应门禁：Q0（静态门里的 unit + web 两个 project）
- 对应决策：#296「Q0 偶发：run-notifications 在同机并行跑 e2e 时红一次，隔离 4/4 绿」
- 上次验证：2026-10-08 · `fix/p1-296-web-load-flake` · 结果 PASS

## 验的是哪条链路

**不是产品链路，是测试判据本身**：Q0 的 unit/web project 在**机器被抢**时会红，红的是
「这台机器当时多快」，不是产品行为。形态与 #256（固定 sleep）、#297（动画中间态取色）
同族：**判据里混进了与结论无关的物理量**。

原缺陷形态（#296 原文）：`pnpm check` 与 Playwright e2e 同机并行时
`run-notifications.spec.tsx` 红一次，隔离跑 4/4 绿——「一次红 + 无法复现」是这类问题的
标准指纹（负载相关、非确定性，再跑一次就绿）。

## 复现口径（可复跑的关键）

单跑不红说明不了任何事，必须**加压**：**同机并发两遍全量 unit**（`pnpm test:unit` 两个
进程同时跑，双倍 worker 抢 CPU，等价于 CI 共享 runner 的竞争水平）。

| 口径 | 修复前 | 修复后 |
|---|---|---|
| 单遍全量（122 文件 / 1431 用例） | 两次单跑各红 1 条（`runtime-bin-assembly` / `agent-assign`） | 绿（`pnpm check` exit 0） |
| **并发两遍** | **红 8 条 / 红 12 条**（互不相同的用例） | **绿 / 绿**（exit 0） |

修复前加压红单里，被判「偶发」的那条 `run-notifications > 终态进标题徽标…` 就在其中
（1.435s 收场）——#296 的偶发不是孤例，是**一类**（同一批次里 12 条用例分属 12 个文件、
彼此无关，只有「多久能等到元素」这一件事相同）。

## 判定（四类根因与改法）

| 类 | 根因 | 改法 |
|---|---|---|
| RTL 发现超时 1s | `findBy*/waitFor` 默认 `asyncUtilTimeout: 1000`，实测挂在 1.2–1.8s 上 | `apps/web/tests/setup.ts` 全局 `configure({ asyncUtilTimeout: 5_000 })`——判据是「**会**出现」，不是「1 秒内出现」；真不出现照旧红 |
| vitest 用例上限 5s | 一条用例里 3–5 次串行发现，慢机器上合计 > 5s，报「用例挂」而不是「元素没出现」 | web project `testTimeout: 15_000`（发现预算 5s 之上留串行余量）；实测两条以 5.05–5.21s 收场 |
| 秒级钉值 | `有效期剩余 (10:00\|09:59)`：码生成到断言之间越过 1s 就红（加压实测越过 2s 到 09:58），**窗口错过就永不再来**，等多久都没用 | `expectCountdownWindow(min, max)`：只钉形状 + 窗口（10 分钟码钉 [540,600]s；2.5s 短码钉 [0,3]s），到期翻转另有专用用例 |
| 同帧判据被 await 让掉 | 「关闭这一帧还在」用 `await user.click` 后同步 `getBy`：userEvent 内部多次 await 会把控制权让给事件循环，退场定时器（`EXIT_PRESENCE_MS`）在断言前到点（加压实测 3.5s 红） | 改用 `fireEvent.click` 直发：同步派发 + RTL 在同一 tick 内 act 收敛，退场窗口不会在断言前关闭（同一 React 处理路径、同一 DOM 元素，不是测试专用近道；仓库已有「焦点陷阱类判据用 fireEvent.keyDown 直发」同款先例） |
| 重 transform 撞 5s 上限 | `runtime-bin-assembly.spec.ts` 现场 `import('./lib/phase1/chain.js')`（拉进 protocol/testkit 一大片，vite 现场 transform ~1s；并行加压越过 5s） | 该用例 `{ timeout: 30_000 }`——判据是「RUNTIME_BIN 等于包解析产物」，与 transform 快慢无关 |

**没有改判据强弱**：所有断言（元素必须出现、倒计时必须在窗口内、退场必须两段式、RUNTIME_BIN
必须等于包解析产物）逐条不变；改掉的是「多久算够」与「在哪个时刻取样」。

## 变异自证（放宽后仍抓得住）

| 变异 | 结果 |
|---|---|
| `DevicesPage` 倒计时印死 `00:00` | 红 2 条（10 分钟码的下界） |
| `DevicesPage` 倒计时 `remainingMs * 100` | 红 3 条（上界） |
| `RunConsole` 去掉 `data-leaving` | 红 1 条 |
| `RunConsole` 去掉 `leaving` 类（保留 data 属性） | 红 1 条 |

后两条正是 `presence.spec.tsx` 注释里点名的两个「删掉照样绿」的变异——换成 `fireEvent`
直发后依然被抓住（两段式判据的严格性没有因为去掉 await 而降低）。

## 复跑

```bash
# 单遍（= CI 口径）
pnpm check

# 加压口径（红→绿的复现装置；两条都要 exit 0 才算过）
(pnpm test:unit > /tmp/unit-a.log 2>&1) & (pnpm test:unit > /tmp/unit-b.log 2>&1) & wait
grep -E "Tests +[0-9]" /tmp/unit-a.log /tmp/unit-b.log

# 只跑被改判据的四条
pnpm exec vitest run --project web apps/web/tests/devices-pairing.spec.tsx \
  apps/web/tests/presence.spec.tsx
pnpm exec vitest run --project unit scripts/runtime-bin-assembly.spec.ts
```

上次结果（2026-10-08）：`pnpm check` exit 0（122 文件 / 1431 passed + 7 expected fail）；
并发两遍全量均 exit 0；四个变异各自复现红。

## 未覆盖与已知项

- **加压口径不是 CI 口径**：CI 每次只跑一遍，两遍并发是本地刻意造竞争。跑绿说明余量够，
  不等于证明任何负载下都稳——真正的下限是「发现预算 5s / 用例上限 15s」这两个数，机器再慢
  过它们仍会红（那时该调数，不该调判据）。
- **只扫了 Q0 的 unit/web**：e2e（Q5）与 integration 的同类「钉钟表」判据未普查；Q5 的
  Playwright e2e 有自己的 `settleAnimations`/poll 纪律（见 `load-performance-acceptance.md`
  与 `contrast-sweep` 的两个盲区）。若再见到「一次红 + 隔离绿」，按本文件的分类先对照四类根因。
- **web project 的 `asyncUtilTimeout` 是全局值**：个别用例若要断言「立即出现」（同步语义），
  得自己用 `getBy` 而不是 `findBy`——放宽默认值不会让同步判据变松。
