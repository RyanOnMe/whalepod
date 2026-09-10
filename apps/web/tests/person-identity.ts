/**
 * #162 判据内核：Task Room 里「指人的位置」不得用 `shortId()` 冒充姓名。
 *
 * 为什么要有这条判据：#152 的 `expectNoJargonVisible` 只抓
 * `/[0-9a-f]{8}-[0-9a-f]{4}-/`（带连字符的完整 UUID），而 `shortId()` 产出的是
 * **前 8 字符、不带连字符**（src/shared/format.ts）——于是「当前责任人 01a08c11」
 * 这类文本整类从判据底下穿了过去，还一路穿到了真实截图上。
 *
 * 为什么不写成「页面里不许出现 8 位十六进制」的一刀切：Task Room 里合法长成这个
 * 形状的东西不止一种——本仓 e2e 自己的用户名就带 8 位随机 tag（`Bob（@bob-1a2b3c4d）`），
 * git sha、内容摘要 sha256 的前缀同理；一刀切会把正确渲染判成红（假红），而假红
 * 的判据很快会被当成噪声静音掉，等于没有判据。这里改成**位置敏感**的口径：只在
 * 明确指人的槽位里问「这个人是谁」，答不出人或答出 id 才算红。
 *
 * 判定是纯函数：e2e（真浏览器 locator 取 innerText）与组件测试（jsdom 取
 * textContent）共用同一份代码，避免两处口径各写一遍后悄悄分叉。
 */

/** 一个「指人的位置」：选择器 + 人话描述（失败信息里要能指出是哪个元素）。 */
export interface PersonSlot {
  readonly selector: string
  readonly what: string
}

/**
 * Task Room 的三个指人位置。`data-testid` 是产品里就有的锚点（不是为判据新造的
 * 近道）：判据取的是这些元素**可见文本**，与真人看到的是同一份东西。
 */
export const PERSON_SLOTS = {
  /** 顶部「当前责任人」格。 */
  assignee: { selector: '[data-testid="task-assignee"]', what: '顶部「当前责任人」的值' },
  /** 任务分配说明（「此任务分配给 X，等待其接受。」）。 */
  assignmentNote: {
    selector: '[data-testid="assignment-assignee-note"]',
    what: '任务分配说明里的责任人',
  },
  /** 留言时间线的作者。 */
  commentAuthor: { selector: '[data-testid="comment-author"]', what: '留言作者' },
} as const satisfies Record<string, PersonSlot>

export interface PersonRoster {
  /** 名录里每个成员可接受的写法：显示名、`@用户名`、`显示名（@用户名）`、裸用户名。 */
  readonly knownLabels: readonly string[]
  /** 查不到人时的兜底文案（人话；不得是 id）。 */
  readonly fallbackLabels: readonly string[]
  /** 视角词：「你」不是名字，但它也**不是**泄漏，而是「这个人就是你」的短说。 */
  readonly viewpointLabels: readonly string[]
}

/**
 * 名册尚未就绪（首帧）或取失败时的兜底文案。判据在它上面等的不是「结果」，是**前提**：
 * 名册还没落定时，人名位置的正确呈现本来就是它，此时判「说了谁」没有意义——先等它过去
 * 再判；一直等不到（名册请求挂了）就是真判定不了，判据必须红而不是静默放过。
 */
export const ROSTER_PENDING_LABEL = '未知成员'

/**
 * 兜底文案白名单（含名册未就绪那一条）。这里刻意**不**从
 * `src/features/team/memberDirectory.ts` 导入：判据内核要零依赖（Playwright 进程不该
 * 为了两个字符串把 React 拉进来），一致性改由 `person-identity.spec.ts` 的断言守住——
 * 改了产品文案而没改这里，单测会红。
 */
export const FALLBACK_LABELS = [ROSTER_PENDING_LABEL, '已离开的成员'] as const

/** 视角词白名单（同上：与产品措辞的一致性由单测守住）。 */
export const VIEWPOINT_LABELS = ['你'] as const

/** GET /team/members 的响应元素形状（Hub 出网字段的子集）。 */
export interface RosterMemberJson {
  readonly userId: string
  readonly username: string
  readonly displayName: string
}

/**
 * 真实名册（控制面 HTTP 取回的 `TeamMemberView[]`）→ 判据用的可接受写法集合。
 * 期望值就是**产品自己那份数据**，不是测试里手写的姓名——写死名字的判据只能在
 * 测试自己身上通过。
 */
export function personRosterFromMembers(members: readonly RosterMemberJson[]): PersonRoster {
  const knownLabels: string[] = []
  for (const member of members) {
    knownLabels.push(
      `${member.displayName}（@${member.username}）`,
      member.displayName,
      `@${member.username}`,
      member.username,
    )
  }
  return {
    knownLabels,
    fallbackLabels: FALLBACK_LABELS,
    viewpointLabels: VIEWPOINT_LABELS,
  }
}

/** 样本：某个槽位这一轮实际渲染出的可见文本（同名元素可能多个，如多条留言）。 */
export interface PersonSlotSample {
  readonly slot: PersonSlot
  readonly texts: readonly string[]
}

/** 8 位十六进制**裸 token**：`shortId()` 的产物形状（前后不能粘着其他词/连字符）。 */
const SHORT_ID_TOKEN = /(?:^|[^\w-])([0-9a-fA-F]{8})(?![0-9a-zA-Z-])/

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * 单个人名位置的判定：返回 `null` = 通过；返回一句人话 = 为什么不过（含实测文本
 * 与期望，失败信息必须能自己指出问题，不能只说「断言失败」）。
 */
export function personSlotVerdict(text: string, roster: PersonRoster): string | null {
  const shown = normalize(text)
  const accepted = [
    ...roster.knownLabels,
    ...roster.fallbackLabels,
    ...roster.viewpointLabels,
  ].sort((a, b) => b.length - a.length)
  // 先抓短 id，再说「没说清是谁」：整格就是一个短 id 时（旧 TaskHeader 的
  // `bbbbbbbb`），最该说出口的诊断是「这里拿 id 当名字」，不是含糊的「没人名」。
  // 摘掉所有可接受的写法后仍剩 8 位十六进制裸 token 的，就是 `shortId()` 的产物：
  // 名字得由人给，id 不能顶替（`@bob-1a2b3c4d` 这种合法用户名会连同写法一起被摘掉）。
  let rest = shown
  for (const label of accepted) rest = rest.split(label).join(' ')
  const found = SHORT_ID_TOKEN.exec(rest)
  if (found !== null) {
    return (
      `人名位置出现了 8 位十六进制内部 id「${found[1]}」（可见文本「${shown}」）：` +
      `期望成员显示名（如 ${roster.knownLabels[0] ?? '显示名（@用户名）'}）或兜底文案` +
      `（${roster.fallbackLabels.join('、')}），短 id 不得当名字用`
    )
  }
  if (!accepted.some((label) => shown.includes(label))) {
    const names = roster.knownLabels.filter((label) => !label.startsWith('@')).slice(0, 3)
    return (
      `这个位置没能说出「是谁」：可见文本是「${shown}」，里面既没有名录里的成员名` +
      `（如 ${names.join('、') || '（名录为空）'}），也没有兜底文案` +
      `（${roster.fallbackLabels.join('、')}）或视角词（${roster.viewpointLabels.join('、')}）`
    )
  }
  return null
}

/**
 * 批量判定：返回**全部**问题（不是遇到第一个就停）——一次跑完能看到所有漏点。
 * 空数组 = 全过。
 */
export function personSlotProblems(
  samples: readonly PersonSlotSample[],
  roster: PersonRoster,
): string[] {
  const problems: string[] = []
  for (const sample of samples) {
    sample.texts.forEach((text, index) => {
      const verdict = personSlotVerdict(text, roster)
      if (verdict !== null) {
        problems.push(
          `${sample.slot.what}（${sample.slot.selector} 第 ${index + 1} 个）：${verdict}`,
        )
      }
    })
  }
  return problems
}

/**
 * jsdom 侧的样本采集：组件测试用它与 e2e 走**同一份**判定（jsdom 没有
 * `innerText` 布局语义，取 `textContent`；e2e 那边取真实浏览器可见文本）。
 */
export function domPersonSlotSamples(
  slots: readonly PersonSlot[],
  root: ParentNode = document,
): PersonSlotSample[] {
  return slots.map((slot) => ({
    slot,
    texts: [...root.querySelectorAll(slot.selector)].map((element) => element.textContent ?? ''),
  }))
}
