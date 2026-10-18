/**
 * 连续对话证据判定器的自证（#393；延续 #345/#381 的判定器纪律）。
 *
 * 判定器若只会说 PASS，它就是装饰。这里用正控 + 逐条负控证明它有牙：每一类
 * 「缺证据 / 说了谎 / 把读面打桩当生产数据 / 锚点其实被拽走 / 阻断其实是灰按钮」
 * 都必须判 FAIL，且原因指名道姓。
 */
import { describe, expect, it } from 'vitest'
import { verifyConversationEvidence } from './conversation-evidence.js'

/** 一份完整、自洽的证据（正控）。各负控从这里改一处。 */
function goodEvidence(): Record<string, unknown> {
  return {
    component: 'web.conversation-flow',
    source: 'production-hub-node-runtime',
    verifiedAt: '2026-10-18T00:00:00.000Z',
    conversation: {
      taskId: 'task-1',
      firstRunId: 'run-1',
      runIds: ['run-1', 'run-2', 'run-3'],
      resumeFromRunId: 'run-1',
      rerunOfRunId: 'run-1',
      domOrderMatchesServer: true,
      repliesPerSegment: 3,
      replyVisibleWithoutOpeningDetail: true,
      approvalInSegment: true,
      memberSeesWaitingOnly: true,
      candidateOnlyOwner: true,
      liveFrames: 57,
    },
    detail: {
      lineageVisible: true,
      metaHasPlacementAndApproval: true,
      consoleOpensFromDetail: true,
    },
    defaults: {
      afterRunCompletedMode: 'resume',
      afterRunCompletedSourceIsLatestBusiness: true,
      whileActiveFollowup: 'followup',
      memberDefaultTargetFollowup: true,
      continueSessionKeepsDraft: true,
      continueSessionFocusesComposer: true,
      historyAndDiscussionDoNotRetarget: true,
      userChoiceSurvivesRunChange: true,
    },
    permission: {
      grantedMemberInstructionRight: true,
      memberFollowupOutcome: 'queued',
      queuedInstructionState: 'pending',
      instructionRunIdMatchesActiveRun: true,
      rejectedCode: 'FORBIDDEN',
      rejectedVisibleInOwnSegment: true,
      memberBlockedAfterRevoke: true,
      memberDraftPreservedAfterRevoke: true,
    },
    paging: {
      runId: 'run-1',
      appPageLimit: 500,
      cursorPages: 12,
      cursorMaxSeq: 12,
      tableMaxSeq: 12,
      tableRows: 12,
      tableSeqContiguous: true,
      cursorReachedTailWithoutOverlap: true,
      memberAudienceRows: 7,
      memberRowsAreSubsetOfTable: true,
      audienceGapIsNotLoss: true,
    },
    offline: {
      blockedBy: 'client-guard',
      blockerShown: true,
      draftPreserved: true,
      explicitSwitchKeepsDraft: true,
      newRunsAfterAttempt: 0,
      instructionPosts: 3,
      instructionPostsAfterBlock: 3,
      liveFrames: 229,
    },
    window: {
      stubbed: 'task-aggregate+runs+events（25 段由读面桩供给；交互全部真实）',
      totalRunsBeforeGrowth: 28,
      totalRunsAfterGrowth: 29,
      firstScreen: 20,
      hiddenBefore: 8,
      afterLoadEarlier: 28,
      loadEarlierGone: true,
      singleScroller: 'workspace-transcript conversation-transcript',
      transcriptOverflows: true,
    },
    anchor: {
      hookAnchorKey: 'run-run-9',
      neighborRunId: 'run-13',
      beforeOffset: 120,
      afterOffset: 121,
      deltaPx: 1,
      neighborDriftPx: 21,
      neighborTolerancePx: 24,
    },
    follow: {
      stoppedFollowingOnScrollUp: true,
      scrollTopBeforeGrowth: 0,
      scrollTopAfterGrowth: 0,
      newSegmentAtBottom: true,
      jumpVisibleAfterGrowth: true,
      nearBottomAfterJump: true,
    },
    layout: {
      widths: [1440, 390, 320],
      noHorizontalOverflow: true,
      bounds: [
        { width: 1440, viewport: 1440, scroll: 1440 },
        { width: 390, viewport: 390, scroll: 390 },
        { width: 320, viewport: 320, scroll: 320 },
      ],
    },
  }
}

function mutate(path: (evidence: Record<string, unknown>) => void): Record<string, unknown> {
  const evidence = goodEvidence()
  path(evidence)
  return evidence
}

const failuresOf = (evidence: Record<string, unknown>): string[] =>
  verifyConversationEvidence(evidence).failures

describe('#393 连续对话证据判定器', () => {
  it('正控：完整自洽的证据判 PASS（判据数够多，不是三两条）', () => {
    const verdict = verifyConversationEvidence(goodEvidence())
    expect(verdict.failures).toEqual([])
    expect(verdict.ok).toBe(true)
    expect(verdict.checks).toBeGreaterThan(45)
  })

  it('非对象 / 来源不是生产装配：FAIL', () => {
    expect(verifyConversationEvidence(undefined).ok).toBe(false)
    expect(failuresOf(mutate((e) => (e['source'] = 'unit-test-stub')))).toContain(
      "source must name the production assembly chain (contains 'production')",
    )
  })

  it('三段运行不是同一条任务上的三条不同运行：FAIL', () => {
    expect(
      failuresOf(
        mutate((e) => {
          ;(e['conversation'] as Record<string, unknown>)['runIds'] = ['run-1', 'run-1', 'run-3']
        }),
      ),
    ).toContain('the three runs must be distinct')
    expect(
      failuresOf(
        mutate((e) => {
          ;(e['conversation'] as Record<string, unknown>)['runIds'] = ['run-9', 'run-2', 'run-3']
        }),
      ),
    ).toContain('the first run must be the first entry of conversation.runIds')
  })

  it('续聊/重跑不说清血缘，或血缘指向的不是第 1 次运行：FAIL', () => {
    expect(
      failuresOf(
        mutate((e) => {
          ;(e['conversation'] as Record<string, unknown>)['resumeFromRunId'] = null
        }),
      ),
    ).toContain('the resumed run must record the first run as its source')
    expect(
      failuresOf(
        mutate((e) => {
          ;(e['conversation'] as Record<string, unknown>)['rerunOfRunId'] = 'run-2'
        }),
      ),
    ).toContain('the rerun must record the first run as its source')
  })

  it('「历史回复不消失」缺证据（回复数不对 / 需要先选运行）：FAIL', () => {
    expect(
      failuresOf(
        mutate((e) => {
          ;(e['conversation'] as Record<string, unknown>)['repliesPerSegment'] = 1
        }),
      ),
    ).toContain('each of the three segments must carry its own reply (no cross-run dedupe)')
    expect(
      failuresOf(
        mutate((e) => {
          ;(e['conversation'] as Record<string, unknown>)['replyVisibleWithoutOpeningDetail'] =
            false
        }),
      ),
    ).toContain('the reply must be readable without selecting a run or opening details')
  })

  it('审批卡不在它所属的段里 / 候选材料对别人可见 / 没有实时帧：FAIL', () => {
    expect(
      failuresOf(
        mutate((e) => {
          ;(e['conversation'] as Record<string, unknown>)['approvalInSegment'] = false
        }),
      ),
    ).toContain('the approval card must live in the segment of its own run')
    expect(
      failuresOf(
        mutate((e) => {
          ;(e['conversation'] as Record<string, unknown>)['candidateOnlyOwner'] = false
        }),
      ),
    ).toContain('a candidate artifact must stay private to its owner')
    expect(
      failuresOf(
        mutate((e) => {
          ;(e['conversation'] as Record<string, unknown>)['liveFrames'] = 0
        }),
      ),
    ).toContain('the run must have produced realtime frames (not a reload-driven fake)')
  })

  it('默认继续的每一条（结束态/活跃态/成员跟随）都各自要证据：FAIL', () => {
    for (const [key, message] of [
      ['afterRunCompletedMode', "a finished run must default the composer to 'resume'"],
      ['whileActiveFollowup', "an active run must default the composer to 'followup'"],
      ['memberDefaultTargetFollowup', 'an untouched member draft must follow the active run too'],
    ] as const) {
      expect(
        failuresOf(
          mutate((e) => {
            ;(e['defaults'] as Record<string, unknown>)[key] = 'new'
          }),
        ),
      ).toContain(message)
    }
    expect(
      failuresOf(
        mutate((e) => {
          ;(e['defaults'] as Record<string, unknown>)['userChoiceSurvivesRunChange'] = false
        }),
      ),
    ).toContain('a user-chosen target must survive later run-state changes (auto/user marker)')
  })

  it('「继续此会话」丢了草稿 / 没把来源交给底部输入框 / 查看历史改投了目标：FAIL', () => {
    const verdict = verifyConversationEvidence(
      mutate((e) => {
        const defaults = e['defaults'] as Record<string, unknown>
        defaults['continueSessionKeepsDraft'] = false
        defaults['continueSessionFocusesComposer'] = false
        defaults['historyAndDiscussionDoNotRetarget'] = false
      }),
    )
    expect(verdict.failures).toContain('「继续此会话」 must keep the text already typed')
    expect(verdict.failures).toContain(
      '「继续此会话」 must hand the source to the bottom composer and focus it',
    )
    expect(verdict.failures).toContain(
      'viewing history / opening details / switching discussion must not change the send target',
    )
  })

  it('被拒指令的链断一环（没排队 / 码不对 / 理由不可见 / 草稿被吞）：FAIL', () => {
    const verdict = verifyConversationEvidence(
      mutate((e) => {
        const permission = e['permission'] as Record<string, unknown>
        permission['memberFollowupOutcome'] = 'rejected'
        permission['rejectedCode'] = 'CONFLICT'
        permission['rejectedVisibleInOwnSegment'] = false
        permission['memberDraftPreservedAfterRevoke'] = false
      }),
    )
    expect(verdict.failures).toContain(
      "a followup during the approval window must be accepted as 'queued'",
    )
    expect(verdict.failures).toContain(
      'revoking the grant must reject the queued instruction with FORBIDDEN',
    )
    expect(verdict.failures).toContain('the rejection reason must stay readable in its own segment')
    expect(verdict.failures).toContain('the revoked member must keep the text they were typing')
  })

  it('分页：请求形状不对 / 游标没走到末尾 / 有重叠或跳号 / 受众空隙被当丢帧：FAIL', () => {
    expect(
      failuresOf(
        mutate((e) => {
          ;(e['paging'] as Record<string, unknown>)['appPageLimit'] = 50
        }),
      ),
    ).toContain('the app must ask limit=500')
    expect(
      failuresOf(
        mutate((e) => {
          ;(e['paging'] as Record<string, unknown>)['cursorMaxSeq'] = 11
        }),
      ),
    ).toContain('the cursor walk must end exactly at the last event of the table')
    expect(
      failuresOf(
        mutate((e) => {
          ;(e['paging'] as Record<string, unknown>)['cursorPages'] = 13
        }),
      ),
    ).toContain('walking with limit=1 must take exactly one row per page (no overlap, no skip)')
    expect(
      failuresOf(
        mutate((e) => {
          ;(e['paging'] as Record<string, unknown>)['audienceGapIsNotLoss'] = false
        }),
      ),
    ).toContain('audience gaps must not be reported as lost frames')
    expect(
      failuresOf(
        mutate((e) => {
          ;(e['paging'] as Record<string, unknown>)['memberAudienceRows'] = 12
        }),
      ),
    ).toContain('the member audience read must be a strict, non-empty subset of the table')
    expect(
      failuresOf(
        mutate((e) => {
          ;(e['paging'] as Record<string, unknown>)['runId'] = 'run-2'
        }),
      ),
    ).toContain('paging must be measured on the same run as the conversation evidence')
  })

  it('离线阻断：不是客户端挡 / 没说明 / 草稿没保留 / 显式切换吞草稿 / 真的发出去过：FAIL', () => {
    const verdict = verifyConversationEvidence(
      mutate((e) => {
        const offline = e['offline'] as Record<string, unknown>
        offline['blockedBy'] = 'server-409'
        offline['blockerShown'] = false
        offline['draftPreserved'] = false
        offline['explicitSwitchKeepsDraft'] = false
        offline['newRunsAfterAttempt'] = 1
        offline['instructionPostsAfterBlock'] = 4
      }),
    )
    expect(verdict.failures).toContain(
      'the offline case must be blocked by the client guard (a bare disconnect is invisible to the Hub)',
    )
    expect(verdict.failures).toContain('the offline block must explain itself to the user')
    expect(verdict.failures).toContain('the blocked draft must stay in the composer')
    expect(verdict.failures).toContain('switching to a new execution by hand must keep the text')
    expect(verdict.failures).toContain('a blocked continuation must not create a run')
    expect(verdict.failures).toContain(
      'a blocked continuation must not post an instruction at all (the block is not just a grey button)',
    )
  })

  it('实时帧计数只许单调累积（同页同一次驱动）：FAIL', () => {
    expect(
      failuresOf(
        mutate((e) => {
          ;(e['offline'] as Record<string, unknown>)['liveFrames'] = 7
        }),
      ),
    ).toContain('realtime frames must accumulate on the same page (liveFrames must not shrink)')
  })

  it('窗口面：把读面打桩说成生产数据 / 窗口数字不成立 / 不是单一滚动容器 / 容器没滚动：FAIL', () => {
    expect(
      failuresOf(
        mutate((e) => {
          ;(e['window'] as Record<string, unknown>)['stubbed'] = ''
        }),
      ),
    ).toContain('window.stubbed must declare which reads were stubbed')
    expect(
      failuresOf(
        mutate((e) => {
          ;(e['window'] as Record<string, unknown>)['afterLoadEarlier'] = 20
        }),
      ),
    ).toContain('loading earlier must reveal the older runs (window grows by a step)')
    expect(
      failuresOf(
        mutate((e) => {
          ;(e['window'] as Record<string, unknown>)['singleScroller'] = 'workspace-dock'
        }),
      ),
    ).toContain('the conversation must live in the single main scroll container')
    expect(
      failuresOf(
        mutate((e) => {
          ;(e['window'] as Record<string, unknown>)['transcriptOverflows'] = false
        }),
      ),
    ).toContain('the transcript must overflow at the measured viewport (the judgements are real)')
  })

  it('锚点：应用锚的条目被拽走 / 锚点下方跳太多 / 容差被悄悄放大：FAIL', () => {
    const verdict = verifyConversationEvidence(
      mutate((e) => {
        const anchor = e['anchor'] as Record<string, unknown>
        anchor['deltaPx'] = 120
        anchor['neighborDriftPx'] = 60
      }),
    )
    expect(verdict.failures).toContain(
      'the app-anchored entry must stay within 4px across loading earlier runs',
    )
    expect(verdict.failures).toContain(
      'content below the anchor must not jump either (only the separator may shift it)',
    )
    // 容差本身不许被悄悄放大（自放宽的判据等于没有判据）。
    expect(
      failuresOf(
        mutate((e) => {
          ;(e['anchor'] as Record<string, unknown>)['neighborTolerancePx'] = 120
        }),
      ),
    ).toContain('the documented neighbour tolerance must stay within one segment separator (≤24px)')
  })

  it('跟随面：上翻没停跟随 / 新内容拽走读者 / 没有新内容 / 回不到底部：FAIL', () => {
    const verdict = verifyConversationEvidence(
      mutate((e) => {
        const follow = e['follow'] as Record<string, unknown>
        follow['stoppedFollowingOnScrollUp'] = false
        follow['scrollTopAfterGrowth'] = 480
        follow['newSegmentAtBottom'] = false
        follow['nearBottomAfterJump'] = false
      }),
    )
    expect(verdict.failures).toContain('scrolling up must stop following and offer 「回到最新」')
    expect(verdict.failures).toContain('new content must not move the reader who scrolled up')
    expect(verdict.failures).toContain('the new content must really have arrived')
    expect(verdict.failures).toContain('「回到最新」 must reach the bottom')
  })

  it('三档宽度缺一档 / 横向溢出：FAIL', () => {
    expect(
      failuresOf(
        mutate((e) => {
          ;(e['layout'] as Record<string, unknown>)['widths'] = [1440, 390]
        }),
      ),
    ).toContain('the layout evidence must cover 1440/390/320')
    expect(
      failuresOf(
        mutate((e) => {
          const bounds = (e['layout'] as Record<string, unknown>)['bounds'] as Array<
            Record<string, unknown>
          >
          bounds[1]!['scroll'] = 420
        }),
      ),
    ).toContain('layout at width 390 must not overflow horizontally')
  })

  it('缺一节（例如整套 defaults 没落盘）：FAIL', () => {
    expect(failuresOf(mutate((e) => delete e['defaults']))).toContain('missing section: defaults')
  })
})
