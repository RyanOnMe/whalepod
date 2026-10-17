# E2E Hub 生产装配验收（dist-only，#281）

- 对应场景/门禁：Q5（`pnpm test:e2e`，11 块）；Q0（`pnpm check` 的 `check:boundaries` 与新增单测）
- 对应 Issue：#281（#99 的余缝：Hub 侧双装配）
- 上次验证：2026-10-17 · `fix/p1-281-hub-dist-entry` · 结果 PASS

## 验的是哪条用户路径

Q5 是「浏览器门」——它必须在**生产产物**上跑，否则 tsc 构建 break（类型错误只断 dist、
不断 src）时浏览器门照样绿，发布证据就成了假证据。修好前：`scripts/e2e-serve.mts` 用
`node --import tsx apps/hub/src/server.ts` 拉起 Hub，而生产 Docker 入口是包内
`dist/server.js`（`deploy/hub.Dockerfile`）——同一入口两套装配。

修复后 Q5 的 Hub 只有一条路：**包解析后的 dist 产物**，且装配前跑一次**增量 build**，
所以「源码改了没重建」（本地）与「构建 break」（CI/本地）都会在 Q5 起手上红。

## 驱动（怎么触发）

```bash
pnpm exec vitest run --project unit scripts/lib/phase1/hub-assembly.spec.ts   # 判定面（Q1）
pnpm check:boundaries                                                        # 白名单例外已摘除（Q0）
pnpm test:e2e                                                                # 全链（Q5，11 块）
```

## 观测（看什么）

- e2e-serve 的启动日志：`Hub 入口（包解析 dist 产物）：<repo>/apps/hub/dist/server.js`
  ——这是**装配事实**的取证行（不再有 `--built-hub` 开关或 tsx 源码分支）；
- 子进程 cmdline：`node <repo>/apps/hub/dist/server.js`（`ps` 可查）；
- 构建失败时的输出尾：`e2e 装配前的增量构建失败（@whalepod/hub... @whalepod/runtime...）：<tsc 输出尾>`。

## 判定（成功长什么样）

实现（三处）：

1. 新增 `scripts/lib/phase1/hub-assembly.ts`：`resolveHubServerEntry(anchor)` 借
   `createRequire` 锚点（`apps/hub/package.json`）解析 `@whalepod/hub` → 取包内
   `dist/server.js`（缺产物即报错并给出 `pnpm -r build` 的可执行动作）；
   `buildWorkspaceDistArtifacts(repoRoot)` 增量 build Hub 与 Runtime 的 dist，
   失败带输出尾抛出（构建 break 必须响亮）。
2. `scripts/e2e-serve.mts`：删除 `--built-hub` 分支与源码 spawn 路径，spawn 前
   `buildWorkspaceDistArtifacts(repoRoot)`，唯一装配走 `resolveHubServerEntry`。
3. `scripts/check-boundaries.ts`：摘除白名单例外
   `scripts/e2e-serve.mts:apps/hub/src/server.ts`（`--built-hub` 开关随之从
   `playwright.micro.config.ts` / `playwright.operations.config.ts` 移除）。

| 面 | 用例 | 断言要点 | 变异自证 |
|---|---|---|---|
| Q1 解析 | `scripts/lib/phase1/hub-assembly.spec.ts`（6 例） | 入口恰为 `<repo>/apps/hub/dist/server.js`、**不含 `/src/`**、文件存在；未构建的包树 → 报错且提示 build；锚点不在本仓库 → 归因到锚点而不是猜下一跳；构建 runner 抛错 → 带输出传播；runner 成功 → cwd 是仓库根；路径/URL 两种锚点等价 | 见下两条 |
| Q0 边界规则 | `scripts/check-boundaries.ts`（既有规则的实跑） | 源码路径入口回潮即红 | 把 `'apps/hub/src/server.ts'` 塞回 `e2e-serve.mts` → `check-boundaries: 1 violation(s) found`（`harness references source path ...`）；摘除白名单例外后规则仍绿 |
| Q0 构建前置 | 同上（真跑 pnpm 过滤器） | `buildWorkspaceDistArtifacts(repoRoot)` 在真实仓库上跑通（up-to-date 时 ~0.4s），随后入口可解析 | 构建失败路径由注入 runner 的负控覆盖（真构建失败即 `tsc` 非零 → 抛） |
| Q5 全链 | `pnpm test:e2e`（11 块） | 每块的 webServer 都打印 dist 入口行；全链绿 | —（装配事实由 Q1 判定 + 边界规则双钉） |

## 归因（失败先看哪层）

| 现象 | 先看 |
|---|---|
| Q5 起手就失败、报「装配前的增量构建失败」 | 构建真断了（tsc 输出尾在报错里）——先在本地 `pnpm -r build` 复现，别当成 harness 问题 |
| 报「Hub 生产产物缺失」 | 没构建过（新 clone / 清过 dist）——`pnpm -r build` |
| 报「无法从锚点 … 解析 @whalepod/hub」 | 锚点不在仓库内或依赖未安装（`pnpm install`） |
| Hub 起来了但行为像旧代码 | 看启动日志的入口行是不是 `apps/hub/dist/server.js`；再确认构建步骤没被绕过（`check-boundaries`） |

## 取证

```bash
git log --oneline -1
pnpm exec vitest run --project unit scripts/lib/phase1/hub-assembly.spec.ts
pnpm check:boundaries
```

Q5 的每轮日志在 `artifacts/q5/run-*.log`（`bash scripts/q5-loop.sh N`）；harness 内部
构建的输出尾在失败时报错里（`redactText` 归约后出仓，纪律照旧）。

## 边界与未覆盖

- **增量 build 的代价**：每次 webServer 冷启都跑一次 `pnpm --filter @whalepod/hub...
  --filter @whalepod/runtime... build`（up-to-date 时 ~0.4s；本轮实测 Q5 全链 11 块 /
  13 次冷启全绿，构建开销被冷启本身吸收）。不缓存「已构建」状态是有意的：缓存本身就是
  「测了旧产物」的另一个入口。
- **Web 侧仍是 vite dev server**（不是 `vite build` 产物）：浏览器门要看的是真实浏览器
  行为，dev server 与生产同源反代形态一致（03 §4）；这与 Hub 的 dist 纪律是两件事，
  未在本 Issue 范围内。
- **Runtime 仍有一条源码路径字符串**（`killStaleByArgMarker('apps/runtime/src/bin.ts')`）：
  那是**残留进程清理标记**（切装配前起的历史进程仍需覆盖一轮），不是 spawn 入口，
  白名单例外保留并注明；`scripts/e2e-serve.mts` 的 spawn 侧已无任何源码路径。
- **CI 侧本来就有 build 步骤**（`check.yml` / `q5-release.yml` 都先 `pnpm -r --if-present
  build`）：本 Issue 的收益主要是「本地/单机 Q5 不会悄悄跑旧产物」与「源码入口从
  harness 里彻底消失」；CI 侧的等价守卫（构建 break 必红）此前已成立。
