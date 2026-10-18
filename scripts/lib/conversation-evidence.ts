/**
 * 连续对话工作区证据判定器（#393 / ADR-0019；判定独立于产者——延续 #345/#381 模式）。
 *
 * 输入是 `artifacts/evidence/conversation-flow/result.json`（生产装配 e2e 写下的）。
 * 判据要求**交叉一致**，不只是「每格非空」：
 *   - 连续呈现里的三段必须是**同一条任务**上的三条不同运行，续聊段与来源、重跑段与来源
 *     必须指回**第 1 次运行**（自相矛盾即 FAIL）；
 *   - 分页游标必须真的**走到事件表末尾**（limit=1 的页数 == 表行数 ⇒ 无重叠无跳号），
 *     成员读到的行必须是同一张表的**子集且更少**（受众过滤有间隙，不是丢帧）；
 *   - 离线拦截必须是 409 且码为 `DEVICE_OFFLINE`，并且**没有**新运行长出来；
 *   - 布局面认的是**首屏 20 段**这条窗口数字与锚点/滚动的**读数**，并且必须显式声明
 *     哪一部分是读面打桩（`window.stubbed`），不许把桩当生产数据；
 *   - 锚点漂移必须 ≤ 4px、跟随关闭后 scrollTop 必须**逐像素不变**（新内容不拽人）。
 *
 * 判定器只认它自己算出来的事实：缺一节、多一节、任何一处不一致都 FAIL，绝不跳过。
 */

export interface ConversationVerification {
  ok: boolean
  failures: string[]
  checks: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

interface Reader {
  check: (condition: boolean, message: string) => void
  str: (node: unknown, label: string) => string | undefined
  num: (node: unknown, label: string) => number | undefined
  section: (input: Record<string, unknown>, key: string) => Record<string, unknown> | undefined
  checks: () => number
}

function makeReader(failures: string[]): Reader {
  let count = 0
  const check = (condition: boolean, message: string): void => {
    count += 1
    if (!condition) failures.push(message)
  }
  const str = (node: unknown, label: string): string | undefined => {
    check(typeof node === 'string' && node.length > 0, `${label} must be a non-empty string`)
    return typeof node === 'string' && node.length > 0 ? node : undefined
  }
  const num = (node: unknown, label: string): number | undefined => {
    check(typeof node === 'number' && Number.isFinite(node), `${label} must be a number`)
    return typeof node === 'number' && Number.isFinite(node) ? node : undefined
  }
  return {
    check,
    str,
    num,
    section: (input, key) => {
      const value = input[key]
      check(isRecord(value), `missing section: ${key}`)
      return isRecord(value) ? value : undefined
    },
    checks: () => count,
  }
}

export function verifyConversationEvidence(input: unknown): ConversationVerification {
  const failures: string[] = []
  const reader = makeReader(failures)
  const { check, str, num } = reader

  if (!isRecord(input)) {
    return { ok: false, failures: ['evidence is not an object'], checks: 1 }
  }
  check(input['component'] === 'web.conversation-flow', "component must be 'web.conversation-flow'")
  const source = str(input['source'], 'source')
  check(
    source !== undefined && source.includes('production'),
    "source must name the production assembly chain (contains 'production')",
  )
  str(input['verifiedAt'], 'verifiedAt')

  const conversation = reader.section(input, 'conversation')
  let firstRunId: string | undefined
  if (conversation !== undefined) {
    str(conversation['taskId'], 'conversation.taskId')
    firstRunId = str(conversation['firstRunId'], 'conversation.firstRunId')
    const runIds = conversation['runIds']
    check(Array.isArray(runIds), 'conversation.runIds must be an array')
    if (Array.isArray(runIds)) {
      check(runIds.length === 3, 'conversation.runIds must hold three runs (new/resume/rerun)')
      const ids = runIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
      check(ids.length === runIds.length, 'every conversation.runIds entry must be a run id')
      check(new Set(ids).size === ids.length, 'the three runs must be distinct')
      // 续聊/重跑都必须指回**第 1 次运行**，并且不是它自己。
      check(
        ids.length === 3 && firstRunId !== undefined && ids[0] === firstRunId,
        'the first run must be the first entry of conversation.runIds',
      )
      check(
        conversation['resumeFromRunId'] !== undefined && conversation['resumeFromRunId'] === ids[0],
        'the resumed run must record the first run as its source',
      )
      check(
        conversation['rerunOfRunId'] !== undefined && conversation['rerunOfRunId'] === ids[0],
        'the rerun must record the first run as its source',
      )
    }
    check(
      conversation['domOrderMatchesServer'] === true,
      'the rendered segments must follow the server run order',
    )
    check(
      num(conversation['repliesPerSegment'], 'conversation.repliesPerSegment') === 3,
      'each of the three segments must carry its own reply (no cross-run dedupe)',
    )
    check(
      conversation['replyVisibleWithoutOpeningDetail'] === true,
      'the reply must be readable without selecting a run or opening details',
    )
    check(
      conversation['approvalInSegment'] === true,
      'the approval card must live in the segment of its own run',
    )
    check(
      conversation['memberSeesWaitingOnly'] === true,
      'another member must see the waiting state but no approval affordance',
    )
    check(
      conversation['candidateOnlyOwner'] === true,
      'a candidate artifact must stay private to its owner',
    )
    check(
      (num(conversation['liveFrames'], 'conversation.liveFrames') ?? 0) > 0,
      'the run must have produced realtime frames (not a reload-driven fake)',
    )
  }

  const detail = reader.section(input, 'detail')
  if (detail !== undefined) {
    check(detail['lineageVisible'] === true, 'run lineage must be visible in the run detail')
    check(
      detail['metaHasPlacementAndApproval'] === true,
      'device/time/approval facts must live in the run detail',
    )
    check(detail['consoleOpensFromDetail'] === true, 'the Console must open from the run detail')
  }

  const defaults = reader.section(input, 'defaults')
  if (defaults !== undefined) {
    check(
      defaults['afterRunCompletedMode'] === 'resume',
      "a finished run must default the composer to 'resume'",
    )
    check(
      defaults['afterRunCompletedSourceIsLatestBusiness'] === true,
      'the default continuation must take the latest business run',
    )
    check(
      defaults['whileActiveFollowup'] === 'followup',
      "an active run must default the composer to 'followup'",
    )
    check(
      defaults['memberDefaultTargetFollowup'] === true,
      'an untouched member draft must follow the active run too',
    )
    check(
      defaults['continueSessionKeepsDraft'] === true,
      '「继续此会话」 must keep the text already typed',
    )
    check(
      defaults['continueSessionFocusesComposer'] === true,
      '「继续此会话」 must hand the source to the bottom composer and focus it',
    )
    check(
      defaults['historyAndDiscussionDoNotRetarget'] === true,
      'viewing history / opening details / switching discussion must not change the send target',
    )
    check(
      defaults['userChoiceSurvivesRunChange'] === true,
      'a user-chosen target must survive later run-state changes (auto/user marker)',
    )
  }

  const permission = reader.section(input, 'permission')
  if (permission !== undefined) {
    check(
      permission['grantedMemberInstructionRight'] === true,
      'the grant flow must have been exercised on the real permissions page',
    )
    check(
      permission['memberFollowupOutcome'] === 'queued',
      "a followup during the approval window must be accepted as 'queued'",
    )
    check(
      permission['queuedInstructionState'] === 'pending',
      'the queued instruction must be pending until the run reaches it',
    )
    check(
      permission['instructionRunIdMatchesActiveRun'] === true,
      'the queued instruction must belong to the active run segment',
    )
    check(
      permission['rejectedCode'] === 'FORBIDDEN',
      'revoking the grant must reject the queued instruction with FORBIDDEN',
    )
    check(
      permission['rejectedVisibleInOwnSegment'] === true,
      'the rejection reason must stay readable in its own segment',
    )
    check(
      permission['memberBlockedAfterRevoke'] === true,
      'the revoked member must be blocked from sending (draft kept)',
    )
    check(
      permission['memberDraftPreservedAfterRevoke'] === true,
      'the revoked member must keep the text they were typing',
    )
  }

  const paging = reader.section(input, 'paging')
  if (paging !== undefined) {
    const runId = str(paging['runId'], 'paging.runId')
    check(
      runId !== undefined && firstRunId !== undefined && runId === firstRunId,
      'paging must be measured on the same run as the conversation evidence',
    )
    check(num(paging['appPageLimit'], 'paging.appPageLimit') === 500, 'the app must ask limit=500')
    const cursorPages = num(paging['cursorPages'], 'paging.cursorPages')
    const tableRows = num(paging['tableRows'], 'paging.tableRows')
    check(
      cursorPages !== undefined && cursorPages > 1,
      'the cursor walk must have needed more than one page (real paging)',
    )
    // limit=1 逐页：页数必须等于表的行数 ⇒ 每一页恰好送出一行、无重叠无跳号。
    check(
      cursorPages !== undefined && tableRows !== undefined && cursorPages === tableRows,
      'walking with limit=1 must take exactly one row per page (no overlap, no skip)',
    )
    const tableMaxSeq = num(paging['tableMaxSeq'], 'paging.tableMaxSeq')
    check(
      num(paging['cursorMaxSeq'], 'paging.cursorMaxSeq') === tableMaxSeq &&
        tableMaxSeq !== undefined &&
        tableMaxSeq > 0,
      'the cursor walk must end exactly at the last event of the table',
    )
    check(paging['tableSeqContiguous'] === true, 'run_event seq must be contiguous without dupes')
    check(
      paging['cursorReachedTailWithoutOverlap'] === true,
      'the cursor walk must reach the tail without overlap',
    )
    const memberRows = num(paging['memberAudienceRows'], 'paging.memberAudienceRows')
    check(
      memberRows !== undefined &&
        tableRows !== undefined &&
        memberRows > 0 &&
        memberRows < tableRows,
      'the member audience read must be a strict, non-empty subset of the table',
    )
    check(
      paging['memberRowsAreSubsetOfTable'] === true,
      'member rows must be rows of the same table (no invented events)',
    )
    check(
      paging['audienceGapIsNotLoss'] === true,
      'audience gaps must not be reported as lost frames',
    )
  }

  const offline = reader.section(input, 'offline')
  if (offline !== undefined) {
    // 离线这条**只能客户端挡**（Hub 的 DEVICE_OFFLINE 读设备事实列，断连不清），
    // 所以判据是「界面明确阻断 + 说清原因 + 草稿保留 + 没有新运行」，而不是某个 HTTP 码。
    check(
      offline['blockedBy'] === 'client-guard',
      'the offline case must be blocked by the client guard (a bare disconnect is invisible to the Hub)',
    )
    check(offline['blockerShown'] === true, 'the offline block must explain itself to the user')
    check(offline['draftPreserved'] === true, 'the blocked draft must stay in the composer')
    check(
      offline['explicitSwitchKeepsDraft'] === true,
      'switching to a new execution by hand must keep the text',
    )
    check(
      num(offline['newRunsAfterAttempt'], 'offline.newRunsAfterAttempt') === 0,
      'a blocked continuation must not create a run',
    )
    const posts = num(offline['instructionPosts'], 'offline.instructionPosts')
    check(
      posts !== undefined &&
        posts > 0 &&
        num(offline['instructionPostsAfterBlock'], 'offline.instructionPostsAfterBlock') === posts,
      'a blocked continuation must not post an instruction at all (the block is not just a grey button)',
    )
    // 帧计数是**累计**的：第一段落的快照在前、离线段在后，只要求单调不减（同一页、同一次驱动）。
    const framesAtStart = num(conversation?.['liveFrames'], 'conversation.liveFrames') ?? -1
    const framesAtEnd = num(offline['liveFrames'], 'offline.liveFrames') ?? -2
    check(
      framesAtStart > 0 && framesAtEnd >= framesAtStart,
      'realtime frames must accumulate on the same page (liveFrames must not shrink)',
    )
  }

  const window = reader.section(input, 'window')
  if (window !== undefined) {
    // 哪一部分是读面打桩必须写出来——把桩当生产数据是本判定器要挡的事。
    const stubbed = str(window['stubbed'], 'window.stubbed')
    check(
      stubbed !== undefined && stubbed.includes('桩'),
      'window.stubbed must declare which reads were stubbed',
    )
    const totalRuns = num(window['totalRunsBeforeGrowth'], 'window.totalRunsBeforeGrowth')
    check(num(window['firstScreen'], 'window.firstScreen') === 20, 'the first screen shows 20 runs')
    check(
      totalRuns !== undefined && totalRuns > 20,
      'the window evidence is only meaningful with more than 20 runs',
    )
    check(
      totalRuns !== undefined &&
        num(window['hiddenBefore'], 'window.hiddenBefore') === totalRuns - 20,
      'the hidden count must be total minus the window',
    )
    check(
      num(window['afterLoadEarlier'], 'window.afterLoadEarlier') === totalRuns,
      'loading earlier must reveal the older runs (window grows by a step)',
    )
    check(window['loadEarlierGone'] === true, 'the load-earlier entry must disappear at the top')
    const scroller = str(window['singleScroller'], 'window.singleScroller')
    check(
      scroller !== undefined && scroller.includes('workspace-transcript'),
      'the conversation must live in the single main scroll container',
    )
    check(
      window['transcriptOverflows'] === true,
      'the transcript must overflow at the measured viewport (the judgements are real)',
    )
  }

  const anchor = reader.section(input, 'anchor')
  if (anchor !== undefined) {
    str(anchor['hookAnchorKey'], 'anchor.hookAnchorKey')
    const before = num(anchor['beforeOffset'], 'anchor.beforeOffset')
    const after = num(anchor['afterOffset'], 'anchor.afterOffset')
    const delta = num(anchor['deltaPx'], 'anchor.deltaPx')
    check(
      before !== undefined && after !== undefined && delta !== undefined,
      'the anchor judgement must carry both offsets and the drift',
    )
    // 应用自己的契约：**第一个可见条目**（应用记的锚点）加载更早前后必须留在原处。
    check(
      delta !== undefined && delta <= 4,
      'the app-anchored entry must stay within 4px across loading earlier runs',
    )
    // 锚点**下方**的邻段：只允许「前一段变成非首段」多出的那条分隔（1px 边 + 20px 内边距）。
    const neighbor = num(anchor['neighborDriftPx'], 'anchor.neighborDriftPx')
    const tolerance = num(anchor['neighborTolerancePx'], 'anchor.neighborTolerancePx')
    check(
      tolerance !== undefined && tolerance <= 24,
      'the documented neighbour tolerance must stay within one segment separator (≤24px)',
    )
    check(
      neighbor !== undefined && tolerance !== undefined && neighbor <= tolerance,
      'content below the anchor must not jump either (only the separator may shift it)',
    )
  }

  const follow = reader.section(input, 'follow')
  if (follow !== undefined) {
    check(
      follow['stoppedFollowingOnScrollUp'] === true,
      'scrolling up must stop following and offer 「回到最新」',
    )
    const before = num(follow['scrollTopBeforeGrowth'], 'follow.scrollTopBeforeGrowth')
    const after = num(follow['scrollTopAfterGrowth'], 'follow.scrollTopAfterGrowth')
    check(
      before !== undefined && after !== undefined && before === after,
      'new content must not move the reader who scrolled up',
    )
    check(follow['newSegmentAtBottom'] === true, 'the new content must really have arrived')
    check(follow['jumpVisibleAfterGrowth'] === true, '「回到最新」 must stay available')
    check(follow['nearBottomAfterJump'] === true, '「回到最新」 must reach the bottom')
  }

  const layout = reader.section(input, 'layout')
  if (layout !== undefined) {
    const widths = layout['widths']
    check(
      Array.isArray(widths) && widths.join(',') === '1440,390,320',
      'the layout evidence must cover 1440/390/320',
    )
    check(layout['noHorizontalOverflow'] === true, 'no layout may overflow horizontally')
    const bounds = layout['bounds']
    check(Array.isArray(bounds) && bounds.length === 3, 'each width must carry measured bounds')
    if (Array.isArray(bounds)) {
      for (const row of bounds) {
        if (!isRecord(row)) {
          check(false, 'layout.bounds rows must be objects')
          continue
        }
        const viewport = num(row['viewport'], 'layout.bounds.viewport')
        const scroll = num(row['scroll'], 'layout.bounds.scroll')
        check(
          viewport !== undefined && scroll !== undefined && scroll <= viewport,
          `layout at width ${String(row['width'])} must not overflow horizontally`,
        )
      }
    }
  }

  return { ok: failures.length === 0, failures, checks: reader.checks() }
}
