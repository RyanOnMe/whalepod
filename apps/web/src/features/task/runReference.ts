/**
 * 讨论里引用某次运行（切片⑥f）。
 *
 * **为什么不需要改协议**：引用不是新字段，而是**正文里的一段可识别 token**——讨论流是一条纯文本
 * 记录（`CommentView.body`），给它加"引用数组"要么动协议、要么动 migration，而这一片要的只是
 * "让人能在讨论里指着某次运行说话"。所以做成**窄解析**：正文里出现 `R-<8 位十六进制>` 就认，
 * 能对上任务房间里某次运行就渲染成可点的 chip，对不上**保持纯文本**（绝不做死链）。
 *
 * 三条刻意的取舍：
 *  1. **窄**：只认 `R-` + 8 位十六进制（Hub 的短号口径，与执行区/Console 显示的同一套）。
 *     不认"运行"二字、不认裸 8 位十六进制——否则普通句子里的一串字符会被点成链接。
 *  2. **可读**：token 就是人看得懂的「运行 R-ab12cd34」，不是 `@run:ab12cd34` 这种机器语法。
 *     用户手打同样有效（同一套语法），不需要"必须点按钮才会被识别"的隐藏规则。
 *  3. **解析不到就不是引用**：删掉的那次运行、别的任务的短号，都只会显示原文。
 */
import type { TaskRoomRun } from '../../shared/api/types.js'
import { shortId } from '../../shared/format.js'

/**
 * 短号口径：`R-` + 8 位小写十六进制（**前端的显示约定**，不是 Hub 的概念——Hub 侧没有"短号"，
 * 执行区与 Console 显示的也是同一套）。复用 `shortId()`，不自己重写截断规则（`runLabels.ts`
 * 开头就写着"全仓共用一份，避免各行其是"）。
 *
 * 两个边界断言都是必要的（评测定点实测）：
 *  · 左边的 `(?<![0-9a-z])`：否则 `xR-aaaaaaaa` 会把 chip 从 `R-` 处切出来；
 *  · 右边的 `(?![0-9a-fA-F])`：只写 `[0-9a-f]` 时 `R-aaaaaaaaA` 会被认成"`R-aaaaaaaa` + 尾巴 A"，
 *    同一形状大小写不同待遇，与"窄"不自洽。
 */
const REF_PATTERN = /(?<![0-9a-z])R-([0-9a-f]{8})(?![0-9a-fA-F])/g

/** 把一次运行写成可被识别的引用文本（输入框里插入的就是它）。 */
export function formatRunReference(runId: string): string {
  return `运行 R-${shortId(runId)}`
}

export interface RunReferenceSegment {
  text: string
  /** 只有**解析到任务房间里某次运行**时才有值——否则这一段就是普通文本。 */
  runId: string | null
}

/**
 * 把正文切成"普通文本 / 运行引用"两类片段。
 *
 * `runs` 是任务房间里的运行列表（团队可见投影）：短号只在**这个任务**的运行里解析，
 * 所以在别处复制来的短号不会被当成本任务的引用（避免指错）。
 */
export function parseRunReferences(
  body: string,
  runs: readonly TaskRoomRun[],
): RunReferenceSegment[] {
  const segments: RunReferenceSegment[] = []
  let cursor = 0
  // `REF_PATTERN` 是模块级的 `g` 正则：这行归零是**承重**的（否则上一次调用的 lastIndex 会带进来）。
  // 今天安全的原因是循环只在 `exec` 返回 null 时退出、而 null 会把 lastIndex 归零，且函数内无
  // `await`/回调重入——将来谁在循环里加 `return`/`await` 就会开始泄漏（评审实测过当前无污染）。
  REF_PATTERN.lastIndex = 0
  let match = REF_PATTERN.exec(body)
  while (match !== null) {
    const prefix = match[1] ?? ''
    // **唯一命中**才算引用：短号是截断值，**两条运行短号相同时 `find` 取第一条 = 静默指错**
    // （评审 S3；生产 id 是 UUIDv4、前 8 位 32 位随机，概率极低，但仓库夹具 `nextId()` 造出的
    // 所有 run 前 8 位都是 `00000000`，必然碰撞）。命中不唯一时按"解析不到"处理，保持纯文本
    // ——与本文件第 3 条取舍同源：宁可不算引用，也不指错。
    const matched = runs.filter((candidate) => shortId(candidate.id) === prefix)
    const run = matched.length === 1 ? matched[0] : undefined
    if (run === undefined) {
      // 认得出形状但对不上具体运行 → 不切成片段，留在普通文本里。
      match = REF_PATTERN.exec(body)
      continue
    }
    // 短号前的"运行 "两个字一并吃进 chip（它是引用的一部分，不该在 chip 外孤零零漂着）。
    let start = match.index
    if (body.slice(Math.max(0, start - 3), start) === '运行 ') start -= 3
    if (start > cursor) segments.push({ text: body.slice(cursor, start), runId: null })
    segments.push({ text: body.slice(start, match.index + match[0].length), runId: run.id })
    cursor = match.index + match[0].length
    match = REF_PATTERN.exec(body)
  }
  if (cursor < body.length) segments.push({ text: body.slice(cursor), runId: null })
  return segments
}
