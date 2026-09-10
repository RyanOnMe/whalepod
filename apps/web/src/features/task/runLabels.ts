/**
 * Run 的人话句柄（#162）。
 *
 * 现状（截图实测）：时间线行与直播面板标题写着 `Run 01a08c11`——那是
 * `shortId(run.id)`，半截 UUID 被当成标签用。#152 已判过「`Run` 是 CONTEXT.md 的
 * 正式领域词、不是泄漏」，泄漏的是**把内部 id 当名字/标签用**：`Run 01a08c11`
 * 里没有任何人类可用的信息，它既不能被人复述，也不能被人核对。
 *
 * 本模块给出三个措辞，全仓共用一份，避免各行其是：
 * - `runOrdinalLabel`：同一次 Run 的「第 N 次运行」，N 按 Task Room 聚合视图的运行
 *   顺序（Hub `listRunsByTask` 按 `createdAt` ASC，runs 数组即时间顺序）。
 * - `SELECTED_RUN_LABEL`：Run 直播面板标题。面板永远描述「时间线上被选中的那一次」，
 *   所以它不需要标识符，只需要说清「说的是哪一次」。
 * - `rerunLineageLabel`：重跑血缘句（也给出「第 N 次运行」句柄）。
 *
 * 为什么血缘不说「由上一次运行重跑」这个更显然的写法：`rerunOfRunId` 指向的是
 * **被重跑的那一次 Run**，而不是紧邻的上一条——03 §2.6 的血缘语义是「来源」，
 * 旧代码允许重跑任意历史 Run。写成「上一次」会在「重跑第 1 次运行」这类场景里
 * 说错话（来源其实是 3 次之前那次）；「重跑自第 N 次运行」里那个 N 就是来源在
 * 本任务运行记录里的**位置**，说的是哪一次、不含糊。
 *
 * 原始 id 不退场，只是不再冒充标签：`title`（悬停可见）与 `data-run-id`（定位用）
 * 仍带着完整 UUID，需要核对/复述的人照样拿得到。
 */

/** Run 直播面板标题：面板跟着时间线的选中行走，自称「本次」。 */
export const SELECTED_RUN_LABEL = '本次运行'

/**
 * 血缘句（RunTimeline 行与 RunLivePanel 共用一份措辞）：来源 Run 也用「第 N 次运行」
 * 这个句柄——它与时间线行的标签同款，人可以直接对回去（说「来源运行」只能让人知道
 * 「有来源」，说不出是哪一次）。来源 Run 必在本任务运行记录里：Hub 的重跑校验拒绝
 * 跨 Task 的来源（`orchestrator.ts` 的 `prior.taskId !== taskId` → NOT_FOUND），
 * 所以 `第 N 次运行` 恒可解析；解析不出时退回不指名的「重跑自来源运行」（防御，
 * 不留 id 兜底——id 不冒充标签）。
 */
export function rerunLineageLabel(sourceRunLabel: string | undefined): string {
  return sourceRunLabel === undefined ? '重跑自来源运行' : `重跑自${sourceRunLabel}`
}

/** Artifact 的来源运行格：那个 Run 不在本任务的运行记录里时的人话兜底。 */
export const RUN_NOT_IN_TIMELINE_LABEL = '不在本任务的运行记录中'

/**
 * runId → 「第 N 次运行」。N 取数组下标 +1，因为 runs 的顺序就是创建时间顺序
 * （Hub 侧 `listRunsByTask` 的 `orderBy(asc(runs.createdAt))` 是唯一排序来源，
 * 这里不再排序：多排一次只会多一处能与服务端顺序悄悄分叉的地方）。
 */
export function runOrdinalLabels(
  runs: readonly { readonly id: string }[],
): ReadonlyMap<string, string> {
  return new Map(runs.map((run, index) => [run.id, `第 ${index + 1} 次运行`]))
}
