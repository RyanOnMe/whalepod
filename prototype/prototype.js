(function () {
  'use strict';

  var root = document.getElementById('prototype-root');
  var dialog = document.getElementById('prototype-dialog');
  var toast = document.getElementById('prototype-toast');

  var variants = {
    A: { key: 'A', name: 'Task Room', short: '任务作战室' },
    B: { key: 'B', name: 'Mission Control', short: '团队总控台' },
    C: { key: 'C', name: 'Harness First', short: 'DSH 运行台' }
  };

  var fixture = {
    team: {
      name: 'Northstar Studio',
      initials: 'NS',
      members: 5,
      onlineDevices: 3
    },
    project: {
      id: 'launch-kit',
      name: 'Launch Kit',
      health: '有风险',
      progress: 68
    },
    task: {
      id: 'TT-24',
      title: '发布前安全检查',
      status: '进行中',
      priority: 'P0',
      due: '今天 18:00',
      owner: 'Bob',
      goal: '确认 Launch Kit 的依赖、权限与构建链路没有高危问题，并留下可供 Reviewer 独立复核的证据。',
      acceptance: [
        { text: '依赖与许可证扫描完成', done: true },
        { text: '高风险变更由 Workspace 所有人批准', done: false },
        { text: '安全报告发布给 Project', done: false },
        { text: 'Reviewer 独立复核通过', done: false }
      ]
    },
    members: {
      alice: { name: 'Alice', initials: 'AL', role: 'Owner', tone: 'coral' },
      bob: { name: 'Bob', initials: 'BO', role: 'Task 责任人', tone: 'blue' },
      mia: { name: 'Mia', initials: 'MI', role: 'Member', tone: 'green' }
    },
    agents: {
      builder: {
        name: 'Builder',
        initials: 'B',
        role: '实现与检查',
        status: '等待审批',
        tone: 'amber'
      },
      reviewer: {
        name: 'Reviewer',
        initials: 'R',
        role: '独立复核',
        status: '等待交付物',
        tone: 'violet'
      }
    },
    run: {
      id: 'run-18',
      number: '#18',
      agent: 'Builder',
      status: 'waiting_approval',
      statusLabel: '等待 Bob 审批',
      startedAt: '14:06',
      elapsed: '12m 41s',
      sessionId: 'ses_8f2…c19',
      model: 'DeepSeek V3.2',
      tokens: '18.4k',
      cost: '¥0.82',
      workspace: 'Bob 的 Launch Kit Workspace',
      maskedPath: 'workspace://bob/launch-kit',
      device: 'Bob · MacBook Pro',
      summary: '已完成依赖树和权限入口扫描，发现 2 个需要说明的中风险项。当前等待一次有副作用的修复命令审批。',
      steps: [
        { label: '读取项目规则与锁文件', status: '完成', time: '14:07' },
        { label: '运行只读依赖审计', status: '完成', time: '14:10' },
        { label: '生成修复方案与影响说明', status: '完成', time: '14:15' },
        { label: '执行依赖修复', status: '等待审批', time: '14:18' }
      ]
    },
    approval: {
      id: 'approval-91',
      title: '允许修改依赖锁文件？',
      tool: 'bash',
      command: 'pnpm audit --fix',
      reason: '该命令会更新 pnpm-lock.yaml。Builder 已生成影响摘要，但需要 Workspace 所有人确认后才能执行。',
      owner: 'Bob',
      expires: '08:42',
      scope: '仅本次 Tool Call',
      callId: 'call_4d7…a20'
    },
    artifact: {
      id: 'artifact-7',
      name: 'security-review.md',
      size: '18.6 KB',
      status: '候选，尚未发布',
      sha: '9f12c6a…41bd',
      createdAt: '14:17',
      source: 'Builder Run #18',
      preview: [
        '# Launch Kit 安全检查',
        '',
        '## 结论',
        '没有发现阻止发布的高危问题。两个中风险项需要在本次发布说明中保留。',
        '',
        '## 证据',
        '- 依赖树扫描：0 high / 2 moderate',
        '- 构建脚本未发现外部未锁定下载',
        '- 发布 Token 只在本机凭据 Provider 中可见',
        '',
        '## 待复核',
        'Reviewer 需要基于已发布副本重新执行只读审计。'
      ].join('\n')
    },
    profile: {
      name: 'secure-builder@3',
      digest: 'sha256:72b…8e1',
      plugins: [
        { name: 'dsh-base', kind: 'Bundle', status: '已加载' },
        { name: 'tabtin-team-bridge', kind: 'Bridge', status: '已加载' },
        { name: 'dsh-tool-bash', kind: 'Tool', status: '受审批保护' },
        { name: 'dsh-skill-security-audit', kind: 'Skill', status: '已调用' },
        { name: 'filesystem-local', kind: 'Provider', status: '仅 Bob 可见' }
      ]
    }
  };

  var uiState = {
    approval: 'pending',
    artifactPublished: false,
    comments: [],
    steers: [],
    consoleTab: 'activity',
    lastDialogTrigger: null,
    toastTimer: null,
    mobileMenuOpen: false
  };

  function icon(name, className) {
    return [
      '<svg class="icon',
      className ? ' ' + className : '',
      '" aria-hidden="true"><use href="#icon-',
      name,
      '"></use></svg>'
    ].join('');
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function avatar(person, size) {
    return [
      '<span class="avatar avatar--',
      person.tone,
      size ? ' avatar--' + size : '',
      '" aria-label="',
      escapeHtml(person.name),
      '">',
      escapeHtml(person.initials),
      '</span>'
    ].join('');
  }

  function agentAvatar(agent, size) {
    return [
      '<span class="avatar avatar--agent avatar--',
      agent.tone,
      size ? ' avatar--' + size : '',
      '" aria-label="Agent ',
      escapeHtml(agent.name),
      '">',
      icon('agent'),
      '<span>',
      escapeHtml(agent.initials),
      '</span></span>'
    ].join('');
  }

  function badge(label, tone, iconName) {
    return [
      '<span class="badge badge--',
      tone || 'neutral',
      '">',
      iconName ? icon(iconName) : '',
      '<span>',
      escapeHtml(label),
      '</span></span>'
    ].join('');
  }

  function getVariant() {
    var value = new URLSearchParams(window.location.search).get('variant');
    value = value ? value.toUpperCase() : 'A';
    return variants[value] ? value : 'A';
  }

  function setVariant(key) {
    var next = variants[key] ? key : 'A';
    var params = new URLSearchParams(window.location.search);
    params.set('variant', next);
    window.history.replaceState({}, '', window.location.pathname + '?' + params.toString() + window.location.hash);
    render();
    window.scrollTo({ top: 0, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  }

  function cycleVariant(delta) {
    var keys = Object.keys(variants);
    var current = keys.indexOf(getVariant());
    var next = (current + delta + keys.length) % keys.length;
    setVariant(keys[next]);
  }

  function prefersReducedMotion() {
    return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function showToast(message) {
    window.clearTimeout(uiState.toastTimer);
    toast.textContent = message;
    toast.classList.add('prototype-toast--visible');
    uiState.toastTimer = window.setTimeout(function () {
      toast.classList.remove('prototype-toast--visible');
    }, 2800);
  }

  function prototypeFlag() {
    return [
      '<button class="prototype-flag" type="button" data-action="prototype-info">',
      icon('info'),
      '<span>交互原型 · 非真实数据</span>',
      '</button>'
    ].join('');
  }

  function renderSwitcher(current) {
    var meta = variants[current];
    return [
      '<nav class="prototype-switcher" aria-label="原型方向切换器">',
      '<button type="button" class="switcher-arrow" data-action="cycle-variant" data-delta="-1" aria-label="上一个原型方向">',
      icon('chevron-left'),
      '</button>',
      '<div class="switcher-current" aria-live="polite">',
      '<span class="switcher-key">',
      current,
      '</span>',
      '<span><strong>',
      meta.name,
      '</strong><small>',
      meta.short,
      '</small></span>',
      '</div>',
      '<button type="button" class="switcher-arrow" data-action="cycle-variant" data-delta="1" aria-label="下一个原型方向">',
      icon('chevron-right'),
      '</button>',
      '</nav>'
    ].join('');
  }

  function topAvatars() {
    return [
      '<div class="avatar-stack" aria-label="在线协作者">',
      avatar(fixture.members.alice, 'sm'),
      avatar(fixture.members.bob, 'sm'),
      avatar(fixture.members.mia, 'sm'),
      '<span class="avatar avatar--more avatar--sm" aria-label="另外 2 名成员">+2</span>',
      '</div>'
    ].join('');
  }

  function renderATopbar() {
    return [
      '<header class="a-topbar">',
      '<button class="brand brand--a" type="button" data-action="set-variant" data-variant="A" aria-label="TabTin 任务作战室首页">',
      '<span class="brand-mark">', icon('logo'), '</span>',
      '<span class="brand-word">tabtin</span>',
      '</button>',
      '<div class="a-breadcrumb" aria-label="当前位置">',
      '<span>Northstar Studio</span>', icon('chevron-right'),
      '<span>Launch Kit</span>', icon('chevron-right'),
      '<strong>TT-24</strong>',
      '</div>',
      '<button class="search-trigger" type="button" data-action="prototype-info">',
      icon('search'), '<span>搜索任务、成员或 Agent</span><kbd>⌘ K</kbd>',
      '</button>',
      '<div class="topbar-actions">',
      topAvatars(),
      '<button class="icon-button" type="button" aria-label="通知">', icon('bell'), '<span class="notification-dot"></span></button>',
      '<button class="member-menu" type="button" data-action="prototype-info" aria-label="打开 Bob 的菜单">',
      avatar(fixture.members.bob, 'sm'), icon('chevron-down'),
      '</button>',
      '</div>',
      '</header>'
    ].join('');
  }

  function renderASidebar() {
    return [
      '<aside class="a-sidebar" aria-label="团队导航">',
      '<div class="mobile-project-row">',
      '<button class="mobile-menu-button" type="button" data-action="toggle-mobile-menu" aria-expanded="',
      uiState.mobileMenuOpen ? 'true' : 'false',
      '">', icon('project'), '<span>Launch Kit · TT-24</span>', icon('chevron-down'), '</button>',
      '</div>',
      '<div class="a-sidebar-inner', uiState.mobileMenuOpen ? ' is-open' : '', '">',
      '<nav class="primary-nav" aria-label="主要导航">',
      '<a href="#room-activity">', icon('inbox'), '<span>收件箱</span><span class="nav-count">3</span></a>',
      '<a href="#task-title" aria-current="page">', icon('project'), '<span>项目</span></a>',
      '<a href="#agents">', icon('agent'), '<span>Agents</span><span class="live-dot">2</span></a>',
      '<a href="#plugins">', icon('plug'), '<span>插件</span></a>',
      '<a href="#members">', icon('users'), '<span>成员与设备</span></a>',
      '</nav>',
      '<div class="sidebar-section">',
      '<div class="sidebar-heading"><span>当前项目</span><button class="icon-button icon-button--small" type="button" aria-label="项目更多操作">', icon('more'), '</button></div>',
      '<button class="project-button" type="button" data-action="prototype-info">',
      '<span class="project-glyph">LK</span>',
      '<span><strong>Launch Kit</strong><small>12 个任务 · 68%</small></span>',
      icon('chevron-down'),
      '</button>',
      '</div>',
      '<div class="sidebar-section sidebar-tasks">',
      '<div class="sidebar-heading"><span>任务</span><span class="sidebar-filter">本周</span></div>',
      '<button class="task-nav-item task-nav-item--active" type="button">',
      '<span class="task-status task-status--running"></span>',
      '<span class="task-nav-copy"><small>TT-24 · P0</small><strong>发布前安全检查</strong></span>',
      '<span class="task-nav-alert" aria-label="一个待处理审批">1</span>',
      '</button>',
      '<button class="task-nav-item" type="button" data-action="prototype-info">',
      '<span class="task-status task-status--review"></span>',
      '<span class="task-nav-copy"><small>TT-23</small><strong>着陆页最终复核</strong></span>',
      '</button>',
      '<button class="task-nav-item" type="button" data-action="prototype-info">',
      '<span class="task-status task-status--done"></span>',
      '<span class="task-nav-copy"><small>TT-21</small><strong>分析事件对齐</strong></span>',
      '</button>',
      '<button class="show-all-button" type="button" data-action="prototype-info">查看项目全部 12 个任务 ', icon('arrow-right'), '</button>',
      '</div>',
      '<div class="sidebar-footer">',
      '<span class="device-indicator"><span></span>3 台 Device 在线</span>',
      '<button class="icon-button icon-button--small" type="button" aria-label="设置">', icon('settings'), '</button>',
      '</div>',
      '</div>',
      '</aside>'
    ].join('');
  }

  function renderParticipants() {
    return [
      '<section class="participant-strip" aria-labelledby="participants-title">',
      '<div class="strip-title"><span id="participants-title">这间 Task Room 里的协作者</span><small>1 人负责 · 2 个 Agent 参与</small></div>',
      '<div class="participant-list">',
      '<div class="participant">', avatar(fixture.members.bob), '<span><strong>Bob</strong><small>责任人 · 在线</small></span>', badge('可审批', 'blue', 'shield'), '</div>',
      '<div class="participant">', agentAvatar(fixture.agents.builder), '<span><strong>Builder</strong><small>Run #18 · 等待审批</small></span><span class="pulse-status"><span></span>运行中</span></div>',
      '<div class="participant participant--muted">', agentAvatar(fixture.agents.reviewer), '<span><strong>Reviewer</strong><small>等待发布的 Artifact</small></span>', badge('排队中', 'neutral', 'clock'), '</div>',
      '</div>',
      '</section>'
    ].join('');
  }

  function renderApprovalCard(context) {
    if (uiState.approval === 'approved') {
      return [
        '<article class="approval-card approval-card--resolved">',
        '<div class="approval-icon approval-icon--success">', icon('check'), '</div>',
        '<div class="approval-copy"><div class="event-eyebrow">审批已处理 · Bob · 刚刚</div>',
        '<h3>已允许本次依赖修复</h3>',
        '<p>授权只对 Tool Call <code>', fixture.approval.callId, '</code> 生效；Builder 可以继续执行。</p></div>',
        badge('仅本次允许', 'green', 'shield'),
        '</article>'
      ].join('');
    }

    if (uiState.approval === 'denied') {
      return [
        '<article class="approval-card approval-card--resolved approval-card--denied">',
        '<div class="approval-icon">', icon('x'), '</div>',
        '<div class="approval-copy"><div class="event-eyebrow">审批已处理 · Bob · 刚刚</div>',
        '<h3>已拒绝修改依赖锁文件</h3>',
        '<p>Builder 会收到拒绝原因，并可改用只读方案继续完成报告。</p></div>',
        badge('已拒绝', 'red', 'shield'),
        '</article>'
      ].join('');
    }

    return [
      '<article class="approval-card', context === 'focus' ? ' approval-card--focus' : '', '">',
      '<div class="approval-icon">', icon('shield'), '</div>',
      '<div class="approval-copy">',
      '<div class="event-eyebrow">需要 Bob 决定 · 剩余 ', fixture.approval.expires, '</div>',
      '<h3>', fixture.approval.title, '</h3>',
      '<p>', fixture.approval.reason, '</p>',
      '<div class="command-preview"><span>', icon('terminal'), fixture.approval.tool, '</span><code>', fixture.approval.command, '</code></div>',
      '<div class="approval-scope">', icon('lock'), '<span><strong>授权范围：</strong>', fixture.approval.scope, ' · 路径与凭据不会共享给其他成员</span></div>',
      '</div>',
      '<div class="approval-actions">',
      '<button class="button button--primary" type="button" data-action="decide-approval" data-decision="approved">', icon('check'), '允许一次</button>',
      '<button class="button button--secondary" type="button" data-action="decide-approval" data-decision="denied">拒绝</button>',
      '</div>',
      '</article>'
    ].join('');
  }

  function renderArtifactCard(compact) {
    var published = uiState.artifactPublished;
    return [
      '<article class="artifact-card', compact ? ' artifact-card--compact' : '', '">',
      '<div class="file-icon">', icon('file'), '<span>MD</span></div>',
      '<div class="artifact-copy">',
      '<div class="event-eyebrow">', published ? '已发布给 Project · 刚刚' : 'Artifact Candidate · ' + fixture.artifact.createdAt, '</div>',
      '<h3>', fixture.artifact.name, '</h3>',
      '<p>', published ? 'Reviewer 现在可以基于只读副本发起独立复核。' : 'Builder 已提交候选报告；只有 Bob 发布后，其他 Agent 才能读取副本。', '</p>',
      '<div class="artifact-meta"><span>', fixture.artifact.size, '</span><span>SHA ', fixture.artifact.sha, '</span><span>', fixture.artifact.source, '</span></div>',
      '</div>',
      '<div class="artifact-actions">',
      '<button class="button button--secondary" type="button" data-action="open-artifact" data-artifact-id="', fixture.artifact.id, '">', icon('eye'), '预览</button>',
      published
        ? '<span class="published-mark">' + icon('check') + '已发布</span>'
        : '<button class="button button--dark" type="button" data-action="publish-artifact">' + icon('upload') + '发布给 Project</button>',
      '</div>',
      '</article>'
    ].join('');
  }

  function renderRunEvent() {
    var steps = fixture.run.steps.map(function (step, index) {
      var isWaiting = step.status === '等待审批';
      return [
        '<li class="run-step', isWaiting ? ' run-step--waiting' : '', '">',
        '<span class="step-marker">', isWaiting ? icon('pause') : icon('check'), '</span>',
        '<span><strong>', step.label, '</strong><small>', step.status, ' · ', step.time, '</small></span>',
        index === fixture.run.steps.length - 1 ? badge('等待人', 'amber', 'clock') : '',
        '</li>'
      ].join('');
    }).join('');

    return [
      '<article class="room-event room-event--run">',
      '<div class="event-avatar">', agentAvatar(fixture.agents.builder), '</div>',
      '<div class="event-body">',
      '<div class="event-header"><div><strong>Builder</strong><span>启动了 Run ', fixture.run.number, '</span></div><time>14:06</time></div>',
      '<div class="run-card">',
      '<div class="run-card-header">',
      '<div><span class="run-live"><span></span>RUNNING</span><h3>发布前安全检查 · Builder Run ', fixture.run.number, '</h3></div>',
      '<div class="run-card-actions"><span>', icon('clock'), fixture.run.elapsed, '</span><button class="button button--secondary" type="button" data-action="open-run" data-run-id="', fixture.run.id, '">', icon('layout'), '打开 Run Console</button></div>',
      '</div>',
      '<p class="run-summary">', fixture.run.summary, '</p>',
      '<ol class="run-steps">', steps, '</ol>',
      '<div class="run-card-footer">',
      '<span>', icon('device'), fixture.run.device, '</span>',
      '<span>', icon('lock'), fixture.run.workspace, '</span>',
      '<span>', icon('plug'), 'secure-builder@3</span>',
      '</div>',
      '</div>',
      '</div>',
      '</article>'
    ].join('');
  }

  function renderLocalComments() {
    return uiState.comments.map(function (comment) {
      return [
        '<article class="room-event room-event--comment room-event--local">',
        '<div class="event-avatar">', avatar(fixture.members.bob), '</div>',
        '<div class="event-body">',
        '<div class="event-header"><div><strong>Bob</strong><span>补充说明</span></div><time>', comment.time, '</time></div>',
        '<p class="human-comment">', escapeHtml(comment.text), '</p>',
        '</div></article>'
      ].join('');
    }).join('');
  }

  function renderAFeed() {
    return [
      '<section class="room-feed" id="room-activity" aria-labelledby="room-activity-title">',
      '<div class="section-title-row"><div><span class="section-kicker">ROOM ACTIVITY</span><h2 id="room-activity-title">从任务到交付的共同记录</h2></div>',
      '<button class="filter-button" type="button" data-action="prototype-info">', icon('filter'), '全部活动', icon('chevron-down'), '</button></div>',
      '<div class="feed-list">',
      '<article class="room-event room-event--comment">',
      '<div class="event-avatar">', avatar(fixture.members.alice), '</div>',
      '<div class="event-body"><div class="event-header"><div><strong>Alice</strong><span>明确了验收要求</span></div><time>13:52</time></div>',
      '<p class="human-comment">请保留每个依赖升级的影响说明。Reviewer 应该只基于发布后的报告和代码副本复核，不要直接进入 Bob 的 Workspace。</p>',
      '<div class="comment-reaction">', icon('shield'), '<span>隐私边界已写入 Task 验收条件</span></div>',
      '</div></article>',
      renderRunEvent(),
      '<article class="room-event room-event--system">',
      '<div class="event-avatar event-avatar--system">', icon('shield'), '</div>',
      '<div class="event-body">',
      '<div class="event-header"><div><strong>TabTin</strong><span>拦截了高风险工具调用</span></div><time>14:18</time></div>',
      renderApprovalCard('feed'),
      '</div></article>',
      '<article class="room-event room-event--artifact">',
      '<div class="event-avatar">', agentAvatar(fixture.agents.builder), '</div>',
      '<div class="event-body"><div class="event-header"><div><strong>Builder</strong><span>提交了一个候选交付物</span></div><time>14:17</time></div>',
      renderArtifactCard(false),
      '</div></article>',
      renderLocalComments(),
      '</div>',
      '<form class="room-composer" data-form="comment">',
      avatar(fixture.members.bob, 'sm'),
      '<label class="sr-only" for="room-comment">给 Task Room 添加评论</label>',
      '<textarea id="room-comment" name="comment" rows="1" placeholder="写下决定、上下文或给 Agent 的交接说明…"></textarea>',
      '<div class="composer-tools"><span>评论会进入 Team Event Log，不会写入 DSH Session</span><button class="button button--dark" type="submit">发送评论 ', icon('arrow-right'), '</button></div>',
      '</form>',
      '</section>'
    ].join('');
  }

  function renderAFocus() {
    var checks = fixture.task.acceptance.map(function (item) {
      return [
        '<li class="acceptance-item', item.done ? ' is-done' : '', '">',
        '<span class="check-box">', item.done ? icon('check') : '', '</span>',
        '<span>', item.text, '</span>',
        '</li>'
      ].join('');
    }).join('');

    return [
      '<aside class="a-focus" aria-label="当前任务上下文">',
      '<section class="focus-section focus-section--attention">',
      '<div class="focus-heading"><span class="section-kicker">NOW</span><h2>现在需要关注</h2></div>',
      renderApprovalCard('focus'),
      '</section>',
      '<section class="focus-section">',
      '<div class="focus-heading"><h2>交付接力</h2><span>2 / 4</span></div>',
      '<ol class="handoff-chain">',
      '<li class="is-complete"><span class="handoff-dot">', icon('check'), '</span><div><strong>Builder 检查</strong><small>报告候选已生成</small></div></li>',
      '<li class="is-current"><span class="handoff-dot">2</span><div><strong>Bob 审批与发布</strong><small>正在等待</small></div></li>',
      '<li><span class="handoff-dot">3</span><div><strong>Reviewer 复核</strong><small>等待 Artifact</small></div></li>',
      '<li><span class="handoff-dot">4</span><div><strong>Bob 验收</strong><small>由真人完成</small></div></li>',
      '</ol>',
      '</section>',
      '<section class="focus-section">',
      '<div class="focus-heading"><h2>验收条件</h2><span>1 / 4</span></div>',
      '<ul class="acceptance-list">', checks, '</ul>',
      '<button class="text-button" type="button" data-action="prototype-info">编辑验收条件 ', icon('arrow-right'), '</button>',
      '</section>',
      '<section class="focus-section focus-section--privacy">',
      icon('lock'),
      '<div><strong>Workspace 属于 Bob</strong><p>团队只看到脱敏活动和发布后的 Artifact，不会看到本机绝对路径或原始 Session。</p></div>',
      '</section>',
      '</aside>'
    ].join('');
  }

  function renderTaskRoom() {
    return [
      '<div class="app-shell variant-a">',
      renderATopbar(),
      '<div class="a-layout">',
      renderASidebar(),
      '<main class="a-main" id="main-content">',
      '<section class="task-hero" aria-labelledby="task-title">',
      '<div class="task-hero-top">',
      '<div class="task-labels">', badge(fixture.task.priority, 'red', 'alert'), badge(fixture.task.status, 'green', 'play'), '<span class="task-id">', fixture.task.id, '</span></div>',
      '<div class="task-hero-actions">',
      '<button class="button button--secondary" type="button" data-action="open-run" data-run-id="', fixture.run.id, '">', icon('layout'), 'Run Console</button>',
      '<button class="icon-button" type="button" aria-label="任务更多操作">', icon('more'), '</button>',
      '</div>',
      '</div>',
      '<h1 id="task-title">', fixture.task.title, '</h1>',
      '<p class="task-goal">', fixture.task.goal, '</p>',
      '<div class="task-meta">',
      '<span>', avatar(fixture.members.bob, 'xs'), '<span><small>责任人</small><strong>Bob</strong></span></span>',
      '<span>', icon('clock'), '<span><small>截止时间</small><strong>', fixture.task.due, '</strong></span></span>',
      '<span>', icon('shield'), '<span><small>当前阻塞</small><strong>等待 Workspace 审批</strong></span></span>',
      '</div>',
      '</section>',
      renderParticipants(),
      renderAFeed(),
      '</main>',
      renderAFocus(),
      '</div>',
      prototypeFlag(),
      '</div>'
    ].join('');
  }

  function renderBTopbar() {
    return [
      '<header class="b-topbar">',
      '<div class="b-brand">', icon('logo'), '<strong>TabTin</strong><span>MISSION CONTROL</span></div>',
      '<nav class="b-nav" aria-label="总控台导航">',
      '<a href="#b-overview" aria-current="page">总览</a><a href="#b-queue">任务队列</a><a href="#b-runs">Runs</a><a href="#b-agents">Agents</a><a href="#b-plugins">插件</a>',
      '</nav>',
      '<div class="b-top-actions">', topAvatars(), '<button class="b-command" type="button" data-action="prototype-info">', icon('command'), '<span>命令</span><kbd>⌘K</kbd></button>', avatar(fixture.members.bob, 'sm'), '</div>',
      '</header>'
    ].join('');
  }

  function renderBMetrics() {
    return [
      '<section class="b-overview" id="b-overview">',
      '<div class="b-title-block"><span class="b-overline">NORTHSTAR STUDIO · 16 AUG 2026</span><h1>团队现在的工作面</h1><p>先发现阻塞，再进入任务。状态来自 Team Event Log，不读取成员的原始 DSH Session。</p></div>',
      '<div class="b-metrics" aria-label="团队运行摘要">',
      '<div class="b-metric"><span class="metric-signal metric-signal--green"></span><strong>4</strong><span>运行中</span><small>2 人 · 2 Agents</small></div>',
      '<div class="b-metric b-metric--attention"><span class="metric-signal metric-signal--amber"></span><strong>', uiState.approval === 'pending' ? '2' : '1', '</strong><span>等待人</span><small>', uiState.approval === 'pending' ? '最久 8 分钟' : '已处理一项', '</small></div>',
      '<div class="b-metric"><span class="metric-signal metric-signal--red"></span><strong>3</strong><span>今天截止</span><small>其中 1 个 P0</small></div>',
      '<div class="b-metric"><span class="metric-signal metric-signal--blue"></span><strong>3/4</strong><span>Device 在线</span><small>1 台 11 分钟前离线</small></div>',
      '</div>',
      '</section>'
    ].join('');
  }

  function renderBTaskTable() {
    return [
      '<section class="b-panel b-task-queue" id="b-queue" aria-labelledby="queue-title">',
      '<div class="b-panel-heading"><div><span class="b-overline">LIVE QUEUE</span><h2 id="queue-title">任务队列</h2></div><div class="b-panel-actions"><button type="button" class="b-filter" data-action="prototype-info">全部项目 ', icon('chevron-down'), '</button><button type="button" class="b-filter" data-action="prototype-info">活跃任务 ', icon('chevron-down'), '</button></div></div>',
      '<div class="table-scroll">',
      '<table class="task-table"><caption class="sr-only">Northstar Studio 当前活跃任务</caption>',
      '<thead><tr><th scope="col">任务</th><th scope="col">责任人</th><th scope="col">执行角色</th><th scope="col">阶段</th><th scope="col">阻塞</th><th scope="col">更新时间</th><th scope="col"><span class="sr-only">操作</span></th></tr></thead>',
      '<tbody>',
      '<tr class="is-selected"><td data-label="任务"><button type="button" class="table-task" data-action="set-variant" data-variant="A"><span class="priority-mark priority-mark--p0">P0</span><span><strong>TT-24 · 发布前安全检查</strong><small>Launch Kit</small></span></button></td><td data-label="责任人">', avatar(fixture.members.bob, 'xs'), ' Bob</td><td data-label="执行角色">', agentAvatar(fixture.agents.builder, 'xs'), ' Builder #18</td><td data-label="阶段">', badge('运行中', 'green', 'play'), '</td><td data-label="阻塞"><span class="table-alert">', icon('shield'), uiState.approval === 'pending' ? '等 Bob 审批' : '审批已处理', '</span></td><td data-label="更新时间">刚刚</td><td><button class="icon-button icon-button--small" type="button" data-action="open-run" data-run-id="', fixture.run.id, '" aria-label="打开 TT-24 Run">', icon('chevron-right'), '</button></td></tr>',
      '<tr><td data-label="任务"><button type="button" class="table-task" data-action="prototype-info"><span class="priority-mark">P1</span><span><strong>TT-23 · 着陆页最终复核</strong><small>Launch Kit</small></span></button></td><td data-label="责任人">', avatar(fixture.members.alice, 'xs'), ' Alice</td><td data-label="执行角色">', agentAvatar(fixture.agents.reviewer, 'xs'), ' Reviewer #11</td><td data-label="阶段">', badge('复核中', 'violet', 'eye'), '</td><td data-label="阻塞"><span class="table-clear">—</span></td><td data-label="更新时间">4 分钟前</td><td><button class="icon-button icon-button--small" type="button" data-action="prototype-info" aria-label="打开 TT-23">', icon('chevron-right'), '</button></td></tr>',
      '<tr><td data-label="任务"><button type="button" class="table-task" data-action="prototype-info"><span class="priority-mark">P1</span><span><strong>TT-27 · Windows 安装验证</strong><small>Desktop 1.0</small></span></button></td><td data-label="责任人">', avatar(fixture.members.mia, 'xs'), ' Mia</td><td data-label="执行角色">', agentAvatar(fixture.agents.builder, 'xs'), ' Builder #21</td><td data-label="阶段">', badge('已暂停', 'neutral', 'pause'), '</td><td data-label="阻塞"><span class="table-alert table-alert--gray">', icon('device'), 'Device 离线</span></td><td data-label="更新时间">11 分钟前</td><td><button class="icon-button icon-button--small" type="button" data-action="prototype-info" aria-label="打开 TT-27">', icon('chevron-right'), '</button></td></tr>',
      '<tr><td data-label="任务"><button type="button" class="table-task" data-action="prototype-info"><span class="priority-mark priority-mark--p2">P2</span><span><strong>TT-28 · 分析事件命名清理</strong><small>Product Ops</small></span></button></td><td data-label="责任人">', avatar(fixture.members.alice, 'xs'), ' Alice</td><td data-label="执行角色"><span class="human-only">真人任务</span></td><td data-label="阶段">', badge('准备中', 'blue', 'task'), '</td><td data-label="阻塞"><span class="table-clear">—</span></td><td data-label="更新时间">26 分钟前</td><td><button class="icon-button icon-button--small" type="button" data-action="prototype-info" aria-label="打开 TT-28">', icon('chevron-right'), '</button></td></tr>',
      '</tbody></table></div>',
      '</section>'
    ].join('');
  }

  function renderBLanes() {
    return [
      '<section class="b-lanes" id="b-runs" aria-label="工作泳道">',
      '<article class="b-lane b-lane--human">',
      '<header><span>', icon('users'), '需要人</span><strong>', uiState.approval === 'pending' ? '2' : '1', '</strong></header>',
      uiState.approval === 'pending'
        ? '<button class="lane-item lane-item--urgent" type="button" data-action="set-variant" data-variant="A"><span class="lane-time">08:42 后过期</span><strong>TT-24 · 允许修改锁文件？</strong><small>Bob · 仅本次 Tool Call</small><span class="lane-action">处理审批 ' + icon('arrow-right') + '</span></button>'
        : '<div class="lane-resolved">' + icon('check') + '<span>TT-24 审批已由 Bob 处理</span></div>',
      '<button class="lane-item" type="button" data-action="prototype-info"><span class="lane-time">已等待 14m</span><strong>TT-31 · 确认营销文案</strong><small>Alice · Reviewer 提出 3 个问题</small><span class="lane-action">打开任务 ', icon('arrow-right'), '</span></button>',
      '</article>',
      '<article class="b-lane b-lane--agent">',
      '<header><span>', icon('agent'), 'Agent 运行中</span><strong>4</strong></header>',
      '<button class="lane-item" type="button" data-action="open-run" data-run-id="', fixture.run.id, '"><span class="lane-time"><span class="live-dot-inline"></span>12m 41s</span><strong>Builder #18 · 安全检查</strong><small>4 / 5 Steps · DeepSeek V3.2</small><div class="micro-progress"><span style="width: 76%"></span></div><span class="lane-action">Run Console ', icon('arrow-right'), '</span></button>',
      '<button class="lane-item" type="button" data-action="prototype-info"><span class="lane-time"><span class="live-dot-inline"></span>04m 08s</span><strong>Reviewer #11 · 着陆页复核</strong><small>2 / 4 Steps · 无阻塞</small><div class="micro-progress"><span style="width: 48%"></span></div><span class="lane-action">Run Console ', icon('arrow-right'), '</span></button>',
      '</article>',
      '<article class="b-lane b-lane--delivery">',
      '<header><span>', icon('file'), '等待交付</span><strong>3</strong></header>',
      '<button class="lane-item" type="button" data-action="open-artifact" data-artifact-id="', fixture.artifact.id, '"><span class="lane-time">14:17 创建</span><strong>', fixture.artifact.name, '</strong><small>TT-24 · ', uiState.artifactPublished ? '已发布，可复核' : '等待 Bob 发布', '</small><span class="file-row">', icon('file'), fixture.artifact.size, ' · SHA ', fixture.artifact.sha, '</span><span class="lane-action">预览交付物 ', icon('arrow-right'), '</span></button>',
      '<button class="lane-item" type="button" data-action="prototype-info"><span class="lane-time">13:54 创建</span><strong>landing-review.md</strong><small>TT-23 · 等待 Alice 验收</small><span class="file-row">', icon('file'), '9.2 KB · Reviewer #11</span><span class="lane-action">打开交付物 ', icon('arrow-right'), '</span></button>',
      '</article>',
      '</section>'
    ].join('');
  }

  function renderBSelected() {
    return [
      '<section class="b-selected" aria-labelledby="selected-task-title">',
      '<div class="b-selected-main">',
      '<div class="b-panel-heading"><div><span class="b-overline">SELECTED TASK · TT-24</span><h2 id="selected-task-title">发布前安全检查</h2></div><button class="button button--b-primary" type="button" data-action="set-variant" data-variant="A">进入 Task Room ', icon('arrow-right'), '</button></div>',
      '<div class="compact-timeline">',
      '<div class="compact-event"><time>13:52</time><span class="compact-line"></span>', avatar(fixture.members.alice, 'xs'), '<p><strong>Alice</strong> 写入了独立复核与 Workspace 隔离要求</p></div>',
      '<div class="compact-event"><time>14:06</time><span class="compact-line"></span>', agentAvatar(fixture.agents.builder, 'xs'), '<p><strong>Builder #18</strong> 开始执行，共完成 3 个 Step</p></div>',
      '<div class="compact-event compact-event--alert"><time>14:18</time><span class="compact-line"></span><span class="compact-icon">', icon('shield'), '</span><p><strong>等待 Bob</strong> · pnpm audit --fix</p></div>',
      '</div>',
      '</div>',
      '<aside class="b-selected-side">',
      '<dl><div><dt>责任人</dt><dd>', avatar(fixture.members.bob, 'xs'), ' Bob</dd></div><div><dt>截止</dt><dd>今天 18:00</dd></div><div><dt>Run</dt><dd>#18 · ', fixture.run.elapsed, '</dd></div><div><dt>Artifact</dt><dd>', uiState.artifactPublished ? '已发布' : '1 个候选', '</dd></div></dl>',
      '<div class="b-privacy-note">', icon('lock'), '<p><strong>投影视图</strong><br>这里不包含原始 Session、完整 Tool 参数或本机路径。</p></div>',
      '</aside>',
      '</section>'
    ].join('');
  }

  function renderMissionControl() {
    return [
      '<div class="app-shell variant-b">',
      renderBTopbar(),
      '<main class="b-main" id="main-content">',
      renderBMetrics(),
      renderBTaskTable(),
      renderBLanes(),
      renderBSelected(),
      '</main>',
      prototypeFlag(),
      '</div>'
    ].join('');
  }

  function renderCSessions() {
    return [
      '<aside class="c-sessions" aria-label="Run 与 Session">',
      '<div class="c-sidebar-head"><span>RUNS / SESSIONS</span><button class="c-icon-button" type="button" data-action="prototype-info" aria-label="新建 Run">+</button></div>',
      '<div class="c-session-group"><span class="c-group-label">ACTIVE · 2</span>',
      '<button class="c-session c-session--active" type="button" data-action="open-run" data-run-id="', fixture.run.id, '"><span class="c-session-status c-session-status--waiting"></span><span><strong>Builder · Run #18</strong><small>TT-24 · waiting_approval</small></span><time>12m</time></button>',
      '<button class="c-session" type="button" data-action="prototype-info"><span class="c-session-status c-session-status--running"></span><span><strong>Reviewer · Run #11</strong><small>TT-23 · running</small></span><time>4m</time></button>',
      '</div>',
      '<div class="c-session-group"><span class="c-group-label">QUEUED · 1</span>',
      '<button class="c-session" type="button" data-action="prototype-info"><span class="c-session-status"></span><span><strong>Reviewer</strong><small>TT-24 · needs artifact</small></span><time>—</time></button>',
      '</div>',
      '<div class="c-session-group"><span class="c-group-label">RECENT</span>',
      '<button class="c-session" type="button" data-action="prototype-info"><span class="c-session-status c-session-status--done"></span><span><strong>Builder · Run #16</strong><small>TT-21 · completed</small></span><time>1h</time></button>',
      '<button class="c-session" type="button" data-action="prototype-info"><span class="c-session-status c-session-status--failed"></span><span><strong>Builder · Run #15</strong><small>TT-21 · runtime_lost</small></span><time>2h</time></button>',
      '</div>',
      '<div class="c-sidebar-foot"><div><span class="c-online-dot"></span><span>Node connected</span></div><small>Bob · macbook-pro</small></div>',
      '</aside>'
    ].join('');
  }

  function renderCStepLog() {
    var steerMessages = uiState.steers.map(function (message) {
      return [
        '<article class="c-message c-message--user c-message--local">',
        '<div class="c-message-meta"><span>BOB · STEER</span><time>NOW</time></div>',
        '<p>', escapeHtml(message), '</p>',
        '</article>'
      ].join('');
    }).join('');

    return [
      '<section class="c-transcript" aria-label="Run 执行记录">',
      '<article class="c-message c-message--user"><div class="c-message-meta"><span>BOB · USER INPUT</span><time>14:06:02</time></div><p>完成发布前安全检查。不要修改文件，除非先给出影响说明并获得我的批准。最后生成 security-review.md。</p></article>',
      '<div class="c-turn"><div class="c-turn-label"><span>TURN 04</span><small>3 steps · 8,241 tokens</small></div>',
      '<article class="c-step"><header><span><span class="c-step-index">01</span>ASSISTANT SUMMARY</span><time>14:15:28</time></header><p>依赖扫描完成。没有高危项；发现两个中风险依赖。已生成修改影响说明，下一步需要修改锁文件，因此先请求 Bob 批准。</p></article>',
      '<article class="c-tool-call c-tool-call--done"><header><span>', icon('terminal'), '<strong>bash</strong><code>pnpm audit --json</code></span><span class="c-tool-status">', icon('check'), 'EXIT 0 · 2.3s</span></header><details><summary>查看脱敏结果摘要</summary><pre>high: 0\nmoderate: 2\nworkspace: workspace://bob/launch-kit</pre></details></article>',
      '<article class="c-tool-call c-tool-call--done"><header><span>', icon('file'), '<strong>write_file</strong><code>security-review.md</code></span><span class="c-tool-status">', icon('check'), '18.6 KB</span></header></article>',
      '<article class="c-approval-inline">',
      '<div class="c-approval-head"><span class="c-warning-icon">', icon('shield'), '</span><div><span>TOOLS / PRE-EXECUTE → ASK</span><h2>Approval required</h2></div><time>08:42</time></div>',
      '<code class="c-command">', fixture.approval.command, '</code>',
      '<p>', fixture.approval.reason, '</p>',
      uiState.approval === 'pending'
        ? '<div class="c-approval-actions"><button type="button" class="c-button c-button--allow" data-action="decide-approval" data-decision="approved">' + icon('check') + 'Allow once</button><button type="button" class="c-button" data-action="decide-approval" data-decision="denied">Deny</button><span>owner: Bob · call: ' + fixture.approval.callId + '</span></div>'
        : '<div class="c-resolution">' + icon(uiState.approval === 'approved' ? 'check' : 'x') + '<span>' + (uiState.approval === 'approved' ? 'Allowed once by Bob' : 'Denied by Bob') + '</span></div>',
      '</article>',
      '</div>',
      steerMessages,
      '</section>'
    ].join('');
  }

  function renderCInspector() {
    var plugins = fixture.profile.plugins.map(function (plugin) {
      return [
        '<li><span class="c-plugin-icon">', icon(plugin.kind === 'Tool' ? 'terminal' : plugin.kind === 'Skill' ? 'task' : plugin.kind === 'Bridge' ? 'branch' : 'plug'), '</span>',
        '<span><strong>', plugin.name, '</strong><small>', plugin.kind, '</small></span><em>', plugin.status, '</em></li>'
      ].join('');
    }).join('');

    return [
      '<aside class="c-inspector" aria-label="Runtime Inspector">',
      '<div class="c-inspector-tabs" role="tablist" aria-label="检查器栏目"><button role="tab" aria-selected="true" type="button">Runtime</button><button role="tab" aria-selected="false" type="button" data-action="prototype-info">Events</button></div>',
      '<section class="c-inspector-section"><div class="c-inspector-heading"><span>PROFILE</span><button type="button" class="c-link-button" data-action="prototype-info">inspect</button></div><strong class="c-profile-name">', fixture.profile.name, '</strong><code>', fixture.profile.digest, '</code></section>',
      '<section class="c-inspector-section"><div class="c-inspector-heading"><span>PLUGINS · 5</span><span class="c-health">healthy</span></div><ul class="c-plugin-list">', plugins, '</ul></section>',
      '<section class="c-inspector-section"><div class="c-inspector-heading"><span>EXECUTION WORLD</span></div><dl class="c-runtime-dl"><div><dt>model</dt><dd>', fixture.run.model, '</dd></div><div><dt>tokens</dt><dd>', fixture.run.tokens, '</dd></div><div><dt>elapsed</dt><dd>', fixture.run.elapsed, '</dd></div><div><dt>session</dt><dd>', fixture.run.sessionId, '</dd></div></dl></section>',
      '<section class="c-inspector-section c-workspace-box"><div class="c-inspector-heading"><span>WORKSPACE</span>', icon('lock'), '</div><strong>', fixture.run.workspace, '</strong><code>', fixture.run.maskedPath, '</code><small>raw path stays on Bob’s Node</small></section>',
      '<section class="c-inspector-section c-projection-box">', icon('eye'), '<p><strong>PROJECT PROJECTION</strong><br>其他成员只看到 committed summaries、tool labels、Approval 和已发布 Artifact。</p></section>',
      '</aside>'
    ].join('');
  }

  function renderHarnessFirst() {
    return [
      '<div class="app-shell variant-c">',
      '<header class="c-topbar">',
      '<div class="c-brand">', icon('logo'), '<strong>TABTIN</strong><span>/</span><em>HARNESS</em><small>DSH runtime surface</small></div>',
      '<div class="c-top-status"><span class="c-online-dot"></span><span>runtime connected</span><code>localhost:3080</code></div>',
      '<div class="c-top-actions"><button type="button" class="c-icon-button" data-action="prototype-info" aria-label="搜索">', icon('search'), '</button><button type="button" class="c-icon-button" data-action="prototype-info" aria-label="设置">', icon('settings'), '</button>', avatar(fixture.members.bob, 'sm'), '</div>',
      '</header>',
      '<section class="c-task-context">',
      '<div><span class="c-context-label">TASK CONTEXT</span><strong>TT-24 · 发布前安全检查</strong>', badge('等待 Bob', 'amber', 'shield'), '</div>',
      '<p>在这个方向里，Task 只是 Session 上方的一条上下文；团队责任和交付关系明显退居次位。</p>',
      '<button type="button" class="c-return-button" data-action="set-variant" data-variant="A">', icon('arrow-right'), '<span>返回推荐的 Task Room</span></button>',
      '</section>',
      '<div class="c-layout">',
      renderCSessions(),
      '<main class="c-canvas" id="main-content">',
      '<header class="c-run-head"><div><span class="c-run-kicker"><span class="c-online-dot c-online-dot--amber"></span>WAITING_APPROVAL</span><h1>Builder / Run #18</h1><p>session ', fixture.run.sessionId, ' · started ', fixture.run.startedAt, '</p></div><div class="c-run-actions"><button type="button" class="c-button" data-action="prototype-info">', icon('refresh'), 'Fork</button><button type="button" class="c-button c-button--danger" data-action="prototype-info">', icon('stop'), 'Cancel</button></div></header>',
      renderCStepLog(),
      '<form class="c-composer" data-form="steer"><label for="c-steer">继续指令或 Steer 当前 Run</label><div><textarea id="c-steer" name="steer" rows="2" placeholder="告诉 Builder 下一步怎么做…"></textarea><button type="submit" class="c-send-button" aria-label="发送 Steer">', icon('arrow-right'), '</button></div><footer><span><kbd>⌘</kbd><kbd>↵</kbd> send · <kbd>esc</kbd> stop</span><span>input → agent.steer()</span></footer></form>',
      '</main>',
      renderCInspector(),
      '</div>',
      prototypeFlag(),
      '</div>'
    ].join('');
  }

  function renderRunDialogBody() {
    var tab = uiState.consoleTab;
    if (tab === 'tools') {
      return [
        '<div class="run-console-tools">',
        '<article class="console-tool console-tool--done"><div class="console-tool-icon">', icon('terminal'), '</div><div><span class="console-time">14:10:08 · 2.3s</span><h3>bash</h3><code>pnpm audit --json</code><p>完成 · 0 high / 2 moderate</p></div>', badge('完成', 'green', 'check'), '</article>',
        '<article class="console-tool console-tool--done"><div class="console-tool-icon">', icon('file'), '</div><div><span class="console-time">14:17:31 · 0.4s</span><h3>write_file</h3><code>security-review.md</code><p>已生成 Artifact Candidate · 18.6 KB</p></div>', badge('完成', 'green', 'check'), '</article>',
        '<article class="console-tool console-tool--waiting"><div class="console-tool-icon">', icon('shield'), '</div><div><span class="console-time">14:18:43 · waiting</span><h3>bash</h3><code>', fixture.approval.command, '</code><p>', uiState.approval === 'pending' ? 'tools/pre-execute 返回 ask；等待 Workspace 所有人。' : '审批已由 Bob 处理。', '</p></div>', badge(uiState.approval === 'pending' ? '等待审批' : '已处理', uiState.approval === 'pending' ? 'amber' : 'green', 'shield'), '</article>',
        '</div>'
      ].join('');
    }

    if (tab === 'plugins') {
      return [
        '<div class="run-console-profile">',
        '<div class="profile-summary"><span class="profile-glyph">SB</span><div><span class="console-time">ACTIVE PROFILE</span><h3>', fixture.profile.name, '</h3><code>', fixture.profile.digest, '</code></div>', badge('契约匹配', 'green', 'check'), '</div>',
        '<table class="plugin-table"><caption class="sr-only">当前 Run 加载的 DSH 插件</caption><thead><tr><th>插件</th><th>角色</th><th>状态</th><th>对团队可见</th></tr></thead><tbody>',
        fixture.profile.plugins.map(function (plugin) {
          return '<tr><td><strong>' + plugin.name + '</strong></td><td>' + plugin.kind + '</td><td>' + plugin.status + '</td><td>' + (plugin.name === 'filesystem-local' ? '仅能力摘要' : '是') + '</td></tr>';
        }).join(''),
        '</tbody></table>',
        '<div class="console-architecture-note">', icon('branch'), '<div><strong>组合，而不是 Fork</strong><p>TabTin Bridge 作为 DSH Profile 中的一等插件，监听 Session/Agent/Tool seam；Team、Task 和 Artifact 权威仍在 TabTin Hub。</p></div></div>',
        '</div>'
      ].join('');
    }

    return [
      '<div class="run-console-activity">',
      '<div class="console-summary-grid"><div><span>状态</span><strong>', fixture.run.statusLabel, '</strong></div><div><span>耗时</span><strong>', fixture.run.elapsed, '</strong></div><div><span>模型</span><strong>', fixture.run.model, '</strong></div><div><span>Tokens</span><strong>', fixture.run.tokens, '</strong></div></div>',
      '<div class="console-flow">',
      '<article><span class="flow-time">14:06</span><span class="flow-dot flow-dot--human">BO</span><div><span class="console-time">USER / FOLLOWUP</span><h3>Bob 交付了任务目标</h3><p>要求先只读扫描，任何写入都需审批，并生成可供 Reviewer 复核的报告。</p></div></article>',
      '<article><span class="flow-time">14:10</span><span class="flow-dot flow-dot--agent">B</span><div><span class="console-time">TURN 04 · STEP 01</span><h3>Builder 完成依赖审计</h3><p>0 个高风险，2 个中风险；继续生成影响说明。</p></div></article>',
      '<article><span class="flow-time">14:17</span><span class="flow-dot flow-dot--tool">', icon('file'), '</span><div><span class="console-time">TOOL / RESULT</span><h3>Artifact Candidate 已生成</h3><p>security-review.md · 18.6 KB · 尚未向 Project 发布。</p></div></article>',
      '<article class="flow-waiting"><span class="flow-time">14:18</span><span class="flow-dot flow-dot--approval">', icon('shield'), '</span><div><span class="console-time">TOOLS / PRE-EXECUTE</span><h3>', uiState.approval === 'pending' ? '运行暂停，等待 Bob' : '审批已处理，运行可以继续', '</h3><p>', fixture.approval.command, '</p></div></article>',
      '</div>',
      '</div>'
    ].join('');
  }

  function renderRunDialog() {
    var tabs = [
      { key: 'activity', label: '活动投影' },
      { key: 'tools', label: '工具调用' },
      { key: 'plugins', label: 'Profile 与插件' }
    ].map(function (item) {
      var selected = item.key === uiState.consoleTab;
      return [
        '<button type="button" role="tab" aria-selected="', selected ? 'true' : 'false',
        '" tabindex="', selected ? '0' : '-1',
        '" data-action="console-tab" data-tab="', item.key, '">',
        item.label,
        '</button>'
      ].join('');
    }).join('');

    return [
      '<div class="dialog-frame run-console-dialog">',
      '<header class="dialog-header">',
      '<div><span class="dialog-kicker">', icon('layout'), 'DSH RUN CONSOLE · TEAM-SAFE PROJECTION</span><h2 id="dialog-title">Builder Run #18</h2><p>TT-24 · 发布前安全检查</p></div>',
      '<div class="dialog-head-actions">', badge(fixture.run.statusLabel, 'amber', 'pause'), '<button class="dialog-close" type="button" data-action="close-dialog" aria-label="关闭 Run Console">', icon('x'), '</button></div>',
      '</header>',
      '<div class="privacy-banner">', icon('lock'), '<span><strong>这是产品投影，不是原始 DSH Session。</strong>绝对路径、完整工具参数、密钥和私有正文只留在 Bob 的 Node。</span></div>',
      '<div class="dialog-tabs" role="tablist" aria-label="Run Console 栏目">', tabs, '</div>',
      '<div class="dialog-body">', renderRunDialogBody(), '</div>',
      '<footer class="dialog-footer"><div><span>', icon('device'), fixture.run.device, '</span><span>', icon('branch'), 'session ', fixture.run.sessionId, '</span></div><button class="button button--secondary" type="button" data-action="close-dialog">返回 Task Room</button></footer>',
      '</div>'
    ].join('');
  }

  function renderArtifactDialog() {
    return [
      '<div class="dialog-frame artifact-dialog">',
      '<header class="dialog-header"><div><span class="dialog-kicker">', icon('file'), uiState.artifactPublished ? 'PUBLISHED ARTIFACT' : 'ARTIFACT CANDIDATE', '</span><h2 id="dialog-title">', fixture.artifact.name, '</h2><p>', fixture.artifact.source, ' · ', fixture.artifact.createdAt, '</p></div><button class="dialog-close" type="button" data-action="close-dialog" aria-label="关闭 Artifact 预览">', icon('x'), '</button></header>',
      '<div class="artifact-preview-layout">',
      '<aside class="artifact-preview-meta"><dl><div><dt>状态</dt><dd>', uiState.artifactPublished ? '已发布给 Project' : fixture.artifact.status, '</dd></div><div><dt>大小</dt><dd>', fixture.artifact.size, '</dd></div><div><dt>SHA-256</dt><dd><code>', fixture.artifact.sha, '</code></dd></div><div><dt>来源</dt><dd>', fixture.artifact.source, '</dd></div><div><dt>可见性</dt><dd>', uiState.artifactPublished ? 'Project 全体成员' : '仅 Bob', '</dd></div></dl><div class="artifact-safety-note">', icon('shield'), '<p>Artifact 是内容副本，不会把 Bob 的 Workspace 路径或凭据带给 Reviewer。</p></div></aside>',
      '<article class="markdown-preview"><div class="markdown-toolbar"><span>', icon('eye'), '预览</span><code>UTF-8 · Markdown</code></div><pre>', escapeHtml(fixture.artifact.preview), '</pre></article>',
      '</div>',
      '<footer class="dialog-footer"><div><span>', icon('file'), fixture.artifact.name, '</span><span>SHA ', fixture.artifact.sha, '</span></div><div class="dialog-footer-actions"><button class="button button--secondary" type="button" data-action="close-dialog">关闭</button>',
      uiState.artifactPublished ? '<span class="published-mark">' + icon('check') + '已发布</span>' : '<button class="button button--dark" type="button" data-action="publish-artifact">' + icon('upload') + '发布给 Project</button>',
      '</div></footer>',
      '</div>'
    ].join('');
  }

  function renderInfoDialog() {
    return [
      '<div class="dialog-frame info-dialog">',
      '<header class="dialog-header"><div><span class="dialog-kicker">', icon('info'), 'PROTOTYPE NOTES</span><h2 id="dialog-title">这个原型在验证什么？</h2><p>三套结构、同一组数据、一个产品判断。</p></div><button class="dialog-close" type="button" data-action="close-dialog" aria-label="关闭原型说明">', icon('x'), '</button></header>',
      '<div class="info-dialog-body">',
      '<section><span class="info-key">A</span><div><h3>Task Room · 推荐</h3><p>先看共同目标、真人责任、阻塞和交付，再按需深入 DSH Run。</p></div></section>',
      '<section><span class="info-key">B</span><div><h3>Mission Control</h3><p>先跨任务扫描状态，适合负责人分诊，但协作关系会被压缩。</p></div></section>',
      '<section><span class="info-key">C</span><div><h3>Harness First</h3><p>最接近直接继承 DSH Web；运行控制很强，但 Team 和 Task 退居次位。</p></div></section>',
      '<div class="info-conclusion">', icon('branch'), '<div><strong>推荐继承方式</strong><p>直接组合 DSH Runtime、Profile、Bundle 和事件 seam；TabTin 自己拥有团队产品外壳。不要 Fork 整个 DSH Web。</p></div></div>',
      '</div>',
      '<footer class="dialog-footer"><span>使用页面底部按钮或键盘 ← → 切换</span><button class="button button--dark" type="button" data-action="close-dialog">继续体验</button></footer>',
      '</div>'
    ].join('');
  }

  function openDialog(kind, trigger) {
    uiState.lastDialogTrigger = trigger || document.activeElement;
    dialog.className = 'prototype-dialog prototype-dialog--' + kind;
    if (kind === 'run') {
      dialog.innerHTML = renderRunDialog();
    } else if (kind === 'artifact') {
      dialog.innerHTML = renderArtifactDialog();
    } else {
      dialog.innerHTML = renderInfoDialog();
    }
    if (!dialog.open) {
      dialog.showModal();
    }
    window.setTimeout(function () {
      var focusTarget = dialog.querySelector('[role="tab"][aria-selected="true"], .dialog-close, button');
      if (focusTarget) focusTarget.focus();
    }, 0);
  }

  function closeDialog() {
    if (dialog.open) dialog.close();
  }

  function render() {
    var current = getVariant();
    document.body.dataset.variant = current;
    document.title = 'TabTin 2.0 · ' + variants[current].name + ' 产品原型';
    var content = current === 'A'
      ? renderTaskRoom()
      : current === 'B'
        ? renderMissionControl()
        : renderHarnessFirst();
    root.innerHTML = content + renderSwitcher(current);
  }

  document.addEventListener('click', function (event) {
    var actionTarget = event.target.closest('[data-action]');
    if (!actionTarget) return;
    var action = actionTarget.dataset.action;

    if (action === 'cycle-variant') {
      cycleVariant(Number(actionTarget.dataset.delta));
      return;
    }
    if (action === 'set-variant') {
      setVariant(actionTarget.dataset.variant);
      return;
    }
    if (action === 'toggle-mobile-menu') {
      uiState.mobileMenuOpen = !uiState.mobileMenuOpen;
      render();
      return;
    }
    if (action === 'open-run') {
      openDialog('run', actionTarget);
      return;
    }
    if (action === 'open-artifact') {
      openDialog('artifact', actionTarget);
      return;
    }
    if (action === 'prototype-info') {
      openDialog('info', actionTarget);
      return;
    }
    if (action === 'close-dialog') {
      closeDialog();
      return;
    }
    if (action === 'console-tab') {
      uiState.consoleTab = actionTarget.dataset.tab;
      dialog.innerHTML = renderRunDialog();
      var activeTab = dialog.querySelector('[data-tab="' + uiState.consoleTab + '"]');
      if (activeTab) activeTab.focus();
      return;
    }
    if (action === 'decide-approval') {
      uiState.approval = actionTarget.dataset.decision;
      if (dialog.open) closeDialog();
      render();
      showToast(uiState.approval === 'approved' ? '已允许一次。Builder 可以继续运行。' : '已拒绝。Builder 会收到决定与原因。');
      return;
    }
    if (action === 'publish-artifact') {
      uiState.artifactPublished = true;
      if (dialog.open) closeDialog();
      render();
      showToast('security-review.md 已发布。Reviewer 现在可以读取副本。');
    }
  });

  document.addEventListener('submit', function (event) {
    var form = event.target.closest('[data-form]');
    if (!form) return;
    event.preventDefault();
    var type = form.dataset.form;

    if (type === 'comment') {
      var commentInput = form.elements.comment;
      var comment = commentInput.value.trim();
      if (!comment) {
        showToast('先写一句需要团队保留的上下文。');
        commentInput.focus();
        return;
      }
      uiState.comments.push({ text: comment, time: '刚刚' });
      render();
      showToast('评论已加入 Task Room 的演示活动流。');
      var nextComment = document.getElementById('room-comment');
      if (nextComment) nextComment.focus();
      return;
    }

    if (type === 'steer') {
      var steerInput = form.elements.steer;
      var steer = steerInput.value.trim();
      if (!steer) {
        showToast('输入一条本地演示指令。');
        steerInput.focus();
        return;
      }
      uiState.steers.push(steer);
      render();
      showToast('演示 Steer 已加入 Run；没有向真实 Runtime 发送。');
      var nextSteer = document.getElementById('c-steer');
      if (nextSteer) nextSteer.focus();
    }
  });

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && dialog.open) {
      event.preventDefault();
      closeDialog();
      return;
    }
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    if (dialog.open) return;
    var target = event.target;
    var tagName = target.tagName ? target.tagName.toLowerCase() : '';
    if (tagName === 'input' || tagName === 'textarea' || tagName === 'select' || target.isContentEditable) return;
    event.preventDefault();
    cycleVariant(event.key === 'ArrowLeft' ? -1 : 1);
  });

  dialog.addEventListener('close', function () {
    var trigger = uiState.lastDialogTrigger;
    uiState.lastDialogTrigger = null;
    if (trigger && document.contains(trigger)) {
      trigger.focus();
    }
  });

  dialog.addEventListener('click', function (event) {
    if (event.target !== dialog) return;
    var rect = dialog.getBoundingClientRect();
    var inside = event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
    if (!inside) closeDialog();
  });

  window.addEventListener('popstate', render);
  render();
}());
