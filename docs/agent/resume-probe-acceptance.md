# resume 可行性探针验收（#176 · ADR-0009 切片①）

- 对应场景/门禁：Q3 DSH 契约门（`pnpm test:dsh-contract`，探针文件 `packages/runtime-dsh/tests/dsh-contract/resume.contract.spec.ts`）
- 对应 Issue：#176（ADR-0009 实现切片①）
- 上次验证：2026-09-11 · `feat/p1-176-resume-probe` · 结果 **PASS**（探针单跑 + Q3 全量）

## 验的是哪条用户路径

用户反馈「一个 Run 只能进行一次对话」的根因验证：**第二次 Run 能不能接着第一次的会话继续说**。
本探针只验机制（不改 Hub/DB、不改 wire 协议），为 ADR-0009 决策 3「终态后续跑」与切片⑤ 提供事实依据。

## 驱动（怎么触发）

复用 Q3 既有 replay 运行时（`tests/dsh-contract/helpers/replay-runtime.ts`）：真 `RuntimeBridge`
+ 真 DSH boot，只有 LLM 出口被 `@deepseek-ai/dsh-llm-replay` 替换（fixture 驱动，不碰外部模型与密钥）。
唯一新增接缝是 `RuntimeBridgeOptions.probeResumeSessionId`——它把装载方式从「新建会话」换成 DSH 的
**persisted load**（`ctx.agents.resume({ resumeSessionId })`），boot 与 setup 组合面一字不改
（setup 体抽成同一份，create / resume 共用）。

```bash
pnpm test:dsh-contract          # 全量 Q3
npx vitest run --project dsh-contract resume.contract   # 只跑本探针
```

## 观测（看什么）

1. `runtime.ready` 帧里的 `dshSessionId`（谁是这条线程）；
2. `session.event` 里的 `assistant/message` 文本；
3. 设备侧会话日志文件（`$DSH_HOME/sessions/<projectKey>/<sessionId>/session.jsonl`）的字节数与内容。

## 判定（成功长什么样）

| # | 判据 | 机制 |
|---|---|---|
| 1 | 第二轮 `ready.dshSessionId` **等于**第一轮的 | 接上的是同一条线程（不是悄悄新建） |
| 2 | 续跑轮能走完并给出回复，且文本含第一轮的验证码 | replay 脚本的 assistant 文本带 `{{fromRequest:请记住：验证码是 (\d{4})}}` 占位符——它按**模型实际收到的请求内容**解析，**匹配不到即硬失败**（上游 `llm-replay` 行为）。**pattern 必须带「请记住：」前缀**（#177 R3 纠正）：只用「验证码是 (\d{4})」时，第 2 轮的 assistant 回复自身会被持久化进日志、从第 3 轮起自己就能满足该正则 → 判据退化成"上一轮回复在场"。加了用户消息独有的前缀后，每一轮的命中都只能来自第一轮那条用户消息 |
| 3a | 旧日志文件字节**持续增长** | 续跑写的是**同一个文件**（同 id 原地追加） |
| 3b | 会话目录集合恰好是 `[sessionId]` | 没有为续跑新建会话（fork/seed 形态会多出一个新会话目录） |
| 3c | 第一轮那句话在同一文件里的出现次数**续跑前后不变** | 抓"同一文件内重复追加历史"这一类（**抓不到跨会话复制**——那种形态旧文件一字不动，见 #177 R6） |

**反证（判据 2 不是恒真）**：同一份续跑脚本用在**没有 resume 的新会话**上时，占位符
无内容可匹配 → 上游 `llm-replay` 抛 `fromRequest pattern ... matched nothing` → turn 以错误
收敛、bridge 发 `runtime.fatal`、**不出现** `run.completed`。探针里有这一条独立用例
（`反证：同一脚本用在没有续接的新会话上会失败`），所以判据 2 的"绿"确实要求上下文在场。

## 实测结果（2026-09-11，本机 Apple Silicon / Node 24.12）

```
字节数（逐轮可复现，评审独立复跑逐字节一致）：
  首轮 40454 B；第 2..8 轮 73698 / 106942 / 140186 / 173430 / 206674 / 239923 / 273185 B
  → +33.2 KB/轮，线性
ready 时间（区间，跨次有波动；单次样本不足下结论）：
  冷进程新建 387–446 ms；热进程新建 25–28 ms；续跑 26–37 ms
  （Q3 全量并行时三者都抬高：实测续跑 39–75 ms）
第一轮那句话出现 2 次（续跑前也是 2 次）
```

> 数字口径：ready 时间 = `runtime.initialize → runtime.ready` 的墙钟（含 **boot + 会话装载 +
> setup + whenIdle**），不是"只量装载"；**冷进程不可与热态并列**（冷启要加载模块与插件），
> 所以对照取热进程新建；「续跑与热态新建不可辨」是区间重叠的说法，不是 n=1 的结论。
> 字节数只说明增长形态（线性），不是存储上限结论。

## 结论（回填 ADR-0009）

1. **resume 可行，且机制比 ADR 原先写的更省**：DSH 的 persisted load 用**同一 session id**重新装载
   既有日志并继续追加（不是「新会话 + 复制前缀」）。因此：
   - ADR 风险二里担心的「逐次 resume 全量历史以新 session id 重持久化 → **近平方存储增长**」
     **不成立**（实测 +33.2 KB/轮，线性；第一轮那句话出现次数不变即无复制）；
   - 决策 3 的措辞应从「以 seed/`fromRestore` 接回」改为「**同 id persisted load**」，
     `seed`/`fromRestore` 退为**换 Workspace**（无既有日志可用）时的替代路径；
   - 切片⑤ 的成本随之下降：不需要「旧日志 → 新会话」的搬运与去重逻辑。
2. **resume 的装载开销在本探针量级上不可辨**：热进程新建 28 ms vs 续跑 26–34 ms（同本底噪声）。
   注意口径：首轮 446 ms 是**冷进程首次 boot**（含模块/插件加载），不能拿来跟热态续跑比。
3. 判据 2 是这套探针里最值钱的一条：它把「上下文接上了」变成**可失败**的机器断言，
   而不是「回复看着像是对的」。

## 归因（失败先看哪层）

- 判据 1 红 → `RuntimeBridgeOptions.probeResumeSessionId` 没传到 `SessionOwner.create`（bridge `start()` 的 `dshSessionId` 上报也一起看）；
- 判据 2 红（replay 抛 `matched nothing`）→ 会话没装载成功（persistence backend 未配置 / 日志路径不对），或续跑那一轮的请求里确实没有历史；
- 判据 3 红 → 走错成了 seed/fork 路径（复制历史），检查 `ctx.agents.resume` 是否被 `create` 顶替。

## 边界与未覆盖

- **长日志未测**：最大只到 273 KB / 8 轮。10 MB 级日志的装载耗时与内存未验（趋势线性，
  但「线性外推到 10 MB」不是实测，不当结论用）。
- **同 Workspace 约束（#177 O2，重要）**：`ResumeAgentOptions` **不接受 `cwd`**，续跑 Run 的
  工作目录来自**持久化 header**，而桥内 artifact 校验用的是**新 spec 的 `workspacePath`**。
  探针两阶段刻意复用同一 workspace，所以这条不对称**在探针里不可观测**：真正落地时
  resume 只允许同 Workspace，切片⑤ 必须把这条做成机器判据，否则会出现「工具在旧 workspace
  跑、artifact 按新 workspace 校验」的错位。
- **跨设备未测**：本探针 Workspace / DSH_HOME 固定在同一台机器；「换设备续跑」没有可装载的
  日志（日志按 `meta.cwd` 分目录），按 ADR-0009 决策 3 的摘要 fallback 处理（未验）。
- **工具调用中途的历史未测**：探针是纯文本轮次（无工具调用、无审批）。带 tool call / 审批的
  历史能否装载后继续，未验。
- **并发续跑未测**：同一 session id 被两个 Runtime 同时装载的行为未验（ADR-0009 决策 5 的
  并发规则在产品侧是单活 Run，但 Runtime 层没有实测护栏）。
- 探针用的 `probeResumeSessionId` 是**探针专用接缝**（生产路径恒为 undefined，与既有
  `extraPatchFiles` 同性质）；把它提升为产品面属于切片⑤，需 wire 字段 + Hub 侧 `resume_from_run_id`。
- 探针跑完**收掉自己的临时目录**（workspace / DSH_HOME），清理写在 `finally` 里，断言红绿都执行——
  证据是可复跑的判据本身，不是一次性的现场快照。（#177 R5：第一版把清理写在 happy path 末尾，
  且每轮 `runtimeSpec({workspacePath…})` 会**先白造两个临时目录再被覆盖**，评审实测每次运行
  净留 14 个孤儿目录；harness 已改为"被覆盖的目录不预先创建"，本次实测残留 0。）

## 复跑

```bash
git checkout <本 PR 合并后的 main>
pnpm test:dsh-contract
```
