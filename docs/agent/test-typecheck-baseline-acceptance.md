# 测试代码 typecheck 接入与基线棘轮验收（#178 / #183，A0-7）

- 对应门禁：**Q0**（`pnpm check`）
- 对应 Issue：#183（#178 家族）——**2026-10-17 全量收口**：hub 25 → 0、node 31 → 0，两张登记表清空
- 上次验证：2026-10-17 · `fix/p1-183-tests-typecheck` · 结果 PASS（含红/绿与变异自证）

## 验的是哪条链路

**测试代码里的类型错误能不能逃过 Q0。** 根 `typecheck` 只跑 `tsc -b`（只构建根项目），
包能否进 Q0 完全取决于各包自己的 `typecheck` 脚本；而各包 `tsconfig` 只 `include src/**`——
于是 `tests/` 里的漏 import、拼错类型名、签名漂移在合并前没人管，只在运行时偶发暴露。

## 机制（两层）

1. **接线面**：每个有 `tests/` 的包/应用必须有 `tsconfig.test.json`（`extends` 本包 tsconfig、
   `rootDir` 抬到包根、`composite:false`、`noEmit`），且 `typecheck` 脚本包含
   `tsc -p tsconfig.test.json`。这条由 `scripts/check-boundaries.ts` 的
   `checkTypecheckWiring` 机检；未接线的包必须在 `TYPECHECK_WIRING_DEFERRED` 表里，
   **表只许缩小**（新增未接线包进不来）。**本表已空**，且 `typecheck-test-baseline.spec.ts`
   新增一条断言把这个终态钉住：将来若有人想再 deferral 一个包，那条会红（必须显式改它并写下理由）。
   同一 spec 的接线判据在 2026-10-17 也**补了 include 面**：只查脚本文本时可被绕过——评审 B
   先报「把 tests/ 从 include 里摘掉」，改文本判据后又抓到两条同族旁路（**删掉 include 键**
   会走 `extends` 继承的 include、「不写就默认全覆盖」在本仓库不成立；`exclude: ["tests/**"]`
   则文本只查一面）。最终改成 **ground truth**：对每个包跑
   `tsc -p tsconfig.test.json --listFilesOnly`，要求清单里真有 `<pkg>/tests/` 下的文件——
   一次覆盖 extends/include/exclude/glob 的全部形态；tsc 起不来同样判违规（fail-closed）。
   成本实测：9 个包合计约 3s（各 0.2–0.5s），进 Q0。三条旁路各做一次真实变异（domain）：
   收窄 include / 删 include 键 / exclude tests → 全部红，还原绿。
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
| `apps/hub` | 39 → 25（A0-7） | **0（已接线）** | 2026-10-17（#183 第 2 步）：局部助手参数漂移（`{ cookie: string }` → `Session`）、exactOptionalPropertyTypes 的条件展开、两个 plugin spec 的本地脚手架复制品（缺 `artifactStoreDir`/`warnEvents`）改为委托 `createTestApp`（fixture catalog 差异提到 `TestAppOptions`）、`descriptorInject` 的返回类型、`insertRunRow` 的 `dshSessionId` 可空、`insertRun` 的 `createdAt`（#119）、`dispatchPendingInstructions` 的 PgTransaction 契约、故意非法插入里的 `prompt`（runs 无该列）、server-coldboot 的 spawn 形态 |
| `apps/node` | 31 | **0（已接线）** | 2026-10-17（#183 第 1+3 步）：先拆 `apps/node/tests/integration/*` 对 `apps/hub/tests/helpers.js` 的跨包 import（DB 类助手进 `packages/testkit`；hub app 类助手进 `@whalepod/hub/testing`），再修 31 个（2 参 `WorkspaceRegistry`、`pids[0]` 收窄、`waitForValue` 的 Promise 探针、异构 emitter 的 handler 类型、fake socket 的帧类型、缺失的 `deviceId`/`dshDistributionVersion`、timers 签名、driver 缺 `terminate`） |

### 拆耦合后的两处归属（第 1 步）

| 脚手架 | 归属 | 为什么 |
|---|---|---|
| `createTestDatabase` / `resetDatabase` / `waitForValue` | `packages/testkit/src/db-support.ts` | 与 hub app 无关，两侧都能按包名 import |
| `TestApp` / `createTestApp` / `apiInject` / `driveSetup` / `driveLogin` / `driveInviteAndAccept` / `Session` / `idemKey` / `extractSessionCookie` | `apps/hub/src/testing`（`@whalepod/hub/testing`） | 必须建真 hub app（`buildApp`）；与 `@whalepod/db` 公开导出 insert* 脚手架同型 |

exports 的 `./testing` 带 `development → src`：integration spec 里还有 hub src 的深模块
相对 import（`vi.spyOn(nodeConnections, 'attach')`），测试进程必须与它驱动的东西同一份
模块图；退回 dist 会让 cli-hello-refresh 的组合根用例以 30s 超时红（评审实测）。
这条契约由 `apps/node/tests/hub-testing-resolution.spec.ts`（unit 面）常驻钉住。

## 判定（怎么知道它有用）

- 棘轮红/绿自证（A0-7）：把 hub 基线临时改成 24（实际 25）⟹ spec 红并打印
  `apps/hub: 25 > 基线 24`；还原 ⟹ 绿。
- 反向自证（A0-7）：把 `packages/protocol` 的相对路径改回错的 ⟹ `pnpm check` 在 typecheck 段红。
- **接线判据真的会红**（#183 第 2/3 步）：先删 `TYPECHECK_WIRING_DEFERRED` 的行、脚本还没接线时
  跑 `pnpm check:boundaries` ⟹ `apps/hub: typecheck does not run tsconfig.test.json (tests/ excluded from Q0)`
  （node 同形）；接上 `tsc -p tsconfig.test.json` 后转绿。
- **棘轮能拦住新增**：`countTestTypecheckErrors` 的 bug 复用是直接跑真 tsc 并数 `error TS` 行——
  接线后这些错误只要再冒一个，`pnpm typecheck` 就会红（不再是「跑得过就行」）。
- **接线判据的 include 面**：把 `packages/domain/tsconfig.test.json` 的 include 收窄到只有
  `src/**` ⟹ `pnpm check:boundaries` 红（`packages/domain: tsconfig.test.json 的 include 不含
  tests/`）；还原 ⟹ 绿。
- **hub/testing 的解析契约**：临时删掉 `apps/hub/package.json` 的 `exports['./testing'].development`
  ⟹ `apps/node/tests/hub-testing-resolution.spec.ts` 红（打印解析到的 `dist/testing/index.js`
  路径）；还原 ⟹ 绿。

## 复跑

```bash
pnpm check                                                    # Q0：含接线面机检 + 棘轮
pnpm exec vitest run --project unit scripts/tests/typecheck-test-baseline.spec.ts
cd apps/hub && pnpm exec tsc -p tsconfig.test.json | grep -c "error TS"   # 手测某个包当前存量
```

## 未覆盖 / 边界（别读成「这个仓库再没有类型债」）

- **`scripts/*.mts` 仍不在任何 typecheck program 内**（`tsconfig.json` 的 include 是
  `scripts/**/*.ts`）：`e2e-serve.mts`/`e2e-node.mts` 这些 Q5/Q2 装配脚本只有运行期覆盖 → #373。
- **web 的 e2e spec**（`apps/web/tests/e2e/**`）走 playwright，不在本棘轮口径里（它与 browser
  门一起跑）。
- 拆耦合后 node 的计数**没变**（仍 31）：跨包 import 的代价是耦合与「hub 侧错误污染 node 的
  Q0」，不是那 31 里的错误（抬 rootDir 之前的 62 个 TS6059 假象是同一根因的更早形态）。
  **注意别把它读成「node 的 program 里再没有 hub 文件了」**：直接 import 层已切到包名
  （hub 的 `tests/` 内部文件 0 处），但 node 经 `scripts/lib/phase1/chain.ts`（它仍
  relative-import `apps/hub/tests/helpers.js`）仍把 hub 的 helpers 与一批 `apps/hub/src`
  文件编进自己的 typecheck program（2026-10-17 实测 `--listFiles` 含 71 个 hub src 文件）
  ——这条传递路径的收敛另立账 #375（chain.ts 被 tsx/dist 与 vitest/src 双跑，直接换成包名
  import 会引入 dist/src 双实例，要先做装配注入）。
- **类型来自 dist、运行来自 src**（`@whalepod/hub/testing` 的消费面）：包解析下 `tsc` 读
  `dist/testing/index.d.ts`、vitest 读 `src/testing/index.ts`。仓库级 `pnpm typecheck` 的
  拓扑序（…testkit → hub → node）保证 dist 先重建，所以门是安全的；但**单独**
  `pnpm --filter @whalepod/node typecheck` 或 IDE 可能拿旧声明检查新实现（改 hub/testing 的
  接口而不重建 dist 时的窗口）。删除 dist 声明会响亮报 TS2307/TS7016，不会静默。
  另注：`InjectResponse.json<T = any>()` 与上游 light-my-request 一致（有注释），
  `res.json().data.x` 这类行的类型检查因此退回 `any`——这部分行「被 typecheck」名不副实，
  属脚手架刻意的口径（对齐上游、避免全量注解）。
- **跨 app 的**相对** import 不在边界门覆盖内**：`validateImport` 只看 `@whalepod/` 前缀，
  相对路径直接放行（`check-boundaries.spec.ts` 把这条钉死）。node 侧现余
  `cli-hello-refresh` 对 `hub/src/modules/...` 的三处深 import（观测缝用途，PR 已交代），
  `chain.ts` 的 helpers 依赖见上；这类耦合目前靠人工评审与 #99 的 harness 规则管，
  没有机检拦「再往 tests 里加一处相对 import」。
- **`apps/node/tests/` 的说明符白名单**（`check-boundaries.ts` 的 subpaths）：名单列的是
  **允许的完整 specifier 含裸入口**——`@whalepod/hub` 只放行 `@whalepod/hub/testing`（裸
  主入口不在名单里：它没有 development 条件，vitest 下解析到 dist，正是双实例的来源），
  `@whalepod/protocol` 放行裸入口 + digest 子路径，`@whalepod/testkit` 只放行裸入口。
  变异自证：在 `cli-hello-refresh` 里加一行 `import ... from '@whalepod/hub'` ⟹
  `check-boundaries` 红（消息点名「bare entry included」）；还原绿。
- 棘轮只保证「不新增 + 数字与现实一致」，不保证错误本身无害：低风险测试里的类型错误
  （如测试替身形状不符）仍可能在运行时表现为假绿——清零后这句话成立，但**新写的**测试
  仍要自己别写假判据（#183 期间评审抓到的两处假判据就是例子）。
