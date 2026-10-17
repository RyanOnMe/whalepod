/**
 * tests/ 的 typecheck 基线（#183 的「禁新增」半边）。
 *
 * 背景：#178/#183 把「包/应用的 tests 必须进 typecheck 面」做成护栏，未接线的包进
 * `TYPECHECK_WIRING_DEFERRED`（只许缩小）。但 deferral 表里的「N 个存量错误」原先只是
 * **文字**——2026-10-09（A0-7）实测发现它已经漂了：hub 记 30 实际 39、node 记 29 实际 31。
 * 没有棘轮，基线就是一句会烂掉的话。
 *
 * 2026-10-17（#183）：apps/hub（25 → 0）与 apps/node（31 → 0）都已清零接线，登记行与
 * deferral 行同时删除——**本表现在是空的**，机制保留：将来再有未接线的包，先测数字、
 * 记一行在这里，只许向下。
 *
 * 本文件把数字变成判据：每个仍未接线的包，跑一次 `tsc -p tsconfig.test.json`（口径与
 * #183 一致：extends 各自 tsconfig + rootDir 抬到仓库根 + include src+tests），
 * 统计 `error TS` 行数，与这里的数字**严格相等**才算过：
 *   - 变多 = 新引入（去修，别改数字）；
 *   - 变少 = 好事，请把数字改小（棘轮只许向下）。
 *
 * 口径边界（如实标注）：node 侧的计数包含经跨包 import 拖进来的 hub 源文件错误
 * （`apps/node/tests/integration/*` import `apps/hub/tests/helpers.js`）——所以这份基线是
 * 「node 的 tests typecheck 面」的总量，不是「node 自己写错的行数」。拆掉那处耦合
 * （#183 第 1 步，需要先把共享脚手架挪进 packages/testkit）之后，这个数字必须重测。
 */

export interface TestTypecheckBaselineEntry {
  /** 未接线包/应用（与 check-boundaries 的 TYPECHECK_WIRING_DEFERRED 键一一对应）。 */
  readonly where: string
  /** 责任 Issue：只许在执行它的批次里把数字改小。 */
  readonly issue: string
  /** 与 `tsc -p tsconfig.test.json` 的 `error TS` 行数严格相等的基线值。 */
  readonly errors: number
}

export const TEST_TYPECHECK_BASELINE: readonly TestTypecheckBaselineEntry[] = [
  // （空）所有带 tests/ 的包/应用都已接线：tests/ 进各自 typecheck（tsconfig.test.json）。
] as const
