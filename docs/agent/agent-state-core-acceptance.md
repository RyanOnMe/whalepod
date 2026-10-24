# P1-437 Agent 状态核心验收

用户在 2026-10-24 明确选择“潮汐蓝＋青绿”，并要求 Agent 工作期间有明显、持续且可辨阶段的反馈。主题契约见 [tidal-brand-theme-acceptance.md](./tidal-brand-theme-acceptance.md)。本切片只扩展应用展示，不新增后端状态或 DSH 依赖。

| Before | After | Why |
| --- | --- | --- |
| 思考、工具、收尾只更换同一个小转圈的文案 | 公开 phase 进入状态模型，驱动不同流体速度、轮廓、核心和轨道 | 阶段在视觉上有区别 |
| 黑白默认外观 | 四个应用品牌色送入原版 AI Blob 的 OKLCH 色带 | 状态核心与品牌统一 |
| 硬切状态 | 原 mood 指数平滑保留，最新真实阶段立即接管目标 | 连续变化可打断，不等待演完旧阶段 |
| 审批与未知活动容易继续显得忙碌 | 非 running、断线、读取失败和未知 phase 优先关停 | 不虚构工作进展 |
| 终态重挂载可能重复播放活动 | 历史终态静态、无 GPU；仅已观测的同 Run active→completed 收束一次 | 不把历史记录当直播 |
| GPU 失败的备用样式缺少离屏暂停 | 外层可见性/reduce gate 与 GPU 是否初始化成功分开 | 降级路径也能停止空闲动画 |

## 来源与分发

本轮从已登录的 `https://bits.collectui.pro/docs/components/ai-blob` 的可见 Code 面板读取源码。保留完整 fragment field、OKLCH ramp 与 mood 平滑；移除原本的语音模拟、麦克风、点击扰动和演示状态。原 Three 场景装配替换为原生 WebGL 的有界屏幕空间渲染，不新增运行依赖。

着色器只做空白整理；去空白 SHA-256 与镜像原文相同：`d191df9419e6e43584a2a679359144003bac5b0c19d37f3c46b70b52120e58dd`。编译入口强制核对该摘要，避免口头声称“取自镜像”而实际换成普通圆圈。私有输入增加 `agent-core.tsx`，公开 manifest 记录第三个输入摘要；共 26 来源 / 31 展示导出。公开仅既有 minified ESM/CSS、声明与来源摘要，编辑原文和 source map 不进仓库。原生 canvas 不承载私有事件或请求载荷。

## 状态真实性

`deriveRunActivity` 在宿主持有状态和标签，内部使用既有事件排序/去重及 Run/project 受众过滤。`AgentView` 是配置档，不包含实时运行事实，因此 Agents 管理卡不会被随机标记为“正在思考”。

- `running`、连接正常、读取完整且最新公开 phase 已知时，才激活 thinking/tool/finalizing。
- 未知最新 phase 不回退到旧 phase；另一个 Run/受众或非法 seq 不能启动动效。
- queued、dispatching、waiting_approval、cancel_requested 和四个终态压过残留 phase。断线与读取中为同步等待，失败/未知有准确文本。
- 宿主以 `key={runId}` 分隔实例。历史 completed 首次挂载是静态勾；仅同实例已真实观测过 active，并收到真实 completed 时才允许一次目标 320ms 的有限收束。查询同步间隙的 unknown/syncing 会立即停止工作循环，不篡改为旧 phase；它也不抹去同 Run 曾真实工作的事实。数据中的 completed 和 active=false 立即生效，不等视觉收束结束。
- 各 phase 可能很短，实际网络传播与 React 批处理可能合并中间可见帧。不得为了拍到每一阶段而延迟协议事实或让 UI 滞留旧阶段；完整转换合同由单测覆盖，浏览器只报告真实观测到的阶段。
- 活动不代表百分比、token 数或语音输入。对当前真实异步工作，键盘输入不会触发全局停播；用户触发的抽屉/文件等控件仍即时反馈。

## 生命周期

页面隐藏、离屏、reduce 均停止核心 RAF/CSS 动效；返回只恢复当前阶段，不补播隐藏期间的时间。GPU 不可用或 context loss 有同等标签和品牌备用形态；独立 DOM 可见性 gate 不依赖着色器编译成功。恢复 context 时重新装配当前渲染资源。渲染器拥有自己的 canvas，StrictMode effect 重挂载会创建新表面；销毁先实际移除表面，再释放该上下文，避免复用已丢失的 React-owned canvas。完成收束后和失败/取消时清理 GPU 资源；卸载断开观察器、移除监听。

工具执行脉冲仍由真实 ToolCall 结果/Run/连接状态计算，paused 和结果未知不会继续作执行态；纯展示暂停门只管可见性，不改变工具事实。权限、审批、请求、文件、草稿和事件权威仍归宿主。

## 驱动与独立判定

红测 `04ca0da`：主题 6 项、核心 2 项和 13 个实际接线断言在旧实现失败；新派生模块缺失时 suite 预期无法导入。随后主题 84 项、宿主/运行 78 项通过。完整 unit/web、静态门和最终浏览器结果在收尾记录。

```bash
pnpm exec playwright test --config=playwright.agent-brand.config.ts
node --import tsx scripts/verify-agent-brand-evidence.mts artifacts/evidence/tidal-brand-theme/<本轮目录>
pnpm exec playwright test --config=playwright.motion.config.ts
node --import tsx scripts/verify-workspace-evidence.mts artifacts/evidence/focused-workspace/<本轮目录>
node --import tsx scripts/verify-motion-evidence.mts artifacts/evidence/focused-workspace/<本轮目录>
pnpm exec playwright test --config=playwright.management.config.ts
node --import tsx scripts/verify-management-evidence.mts artifacts/evidence/management-pages/<本轮目录>
```

专项使用既有 operations 的 Web 5313 / Hub 18183 生产包装配。只有 `WHALEPOD_E2E_AGENT_MOTION=1` 的专项进程选用上游现有 `paceMs` 的 replay overlay，让真实模型 chunk 逐步送达；其他 fixture、生产投影和状态机没有时序修改。Setup、成员加入、Node 配对、任务执行与审批均走真实路径，不插表。

观测与判定独立：真实渲染像素、蓝青颜色、绘制和 uniform 时钟、键盘持续活动、reduce/离屏/上下文故障、32 组运行时主题文字配对、22 个焦点背景、三档几何与成员权限缺一失败；checker 有破坏事实的负控。帧内 readPixels 和仅计数的 drawArrays 观察保留生产返回值，不替换 phase 或渲染算法。原工作区 9 场景、动效 140 项 / 3 档、管理页 452 项 / 12 档继续回归。

## 取证、隐私与边界

实际证据存于 `artifacts/evidence/tidal-brand-theme/`，索引与归因入口登记到 `docs/agent/README.md` 和 `evidence-map.md`。录屏在登录与配对后开始；同一 owner 的录屏会话不会交给 member，不录口令、配对码、邀请 token、私有正文或 storageState。日志脱敏后长期保存并扫描；临时日志不作为唯一证据。

状态或循环错误先看 `web.agent-state`；颜色/主题层看 `web.theme.cascade` 与 `web.theme.contrast`；GPU 与备用暂停看 `web.agent-core`；实际执行/审批问题归 `hub.http`、`node.gateway`、`runtime.bridge`。浏览器是 Chromium，软件 WebGL 的验证不能替代所有真实 GPU/移动设备的帧率验证。

## 本轮结果

最终专项成品证据为 `artifacts/evidence/tidal-brand-theme/f4fcc587/`。全部 **5 次真实运行完成**；独立入口判定 **2000 项检查通过，3 次主运行 / 6 档浅深布局 / 32 组运行时文字配对 / 22 个焦点背景**。浏览器错误为空。实际 WebGL 像素、蓝/青颜色、帧变化、键盘持续绘制、减少动态效果、真实文字扫描及成员只读均通过，没有使用 UI 假 phase 或固定进度。

该目录完整保留 `facts.json`、18 张主布局/状态实拍、`agent-fallback-visible.png`、6 份 `visible-text-*.json`、`visibility-probe.json`、`completion-loss.json`、`lost-before-completion.json` 和认证后的 `agent-brand-preview.webm`。主事实与旁证已逐项校对；真实阶段记录包含查询同步间隙，未为了成图抹掉 unknown 或延长 tool/finalizing。

两种完成故障均实际触发：完成收束中的原生丢失为 `attempted=true / lost=true`，以及真实 thinking 中永久丢失、未恢复后继续审批完成。二者最终均为静态完成勾可见、`active=false`、`completing=false`、canvas 数为 0，且无运行中的 CSS 动画。独立不可用 GPU 路径也完成真实屏外暂停与返回恢复。正常审批期间的 context loss/restore 保留同一业务状态。

对应的真正定向变异红测为 `artifacts/evidence/tidal-brand-theme/44100e40/`：保留 `hasLiveWork`、仅撤销三处 loss 完成清理的编译变异确实接到原生丢失，随后完成勾被隐藏、canvas 为 1、`data-completing` 未撤销。它与最终绿测形成机器证据对照，**不是旧 HEAD 原包的红测**。`9fd1d982`、`0767faad` 仅是目标前提未触发样本，不能充当该故障的红测。

| 回归 | 本轮证据 | 独立结果 |
| --- | --- | --- |
| 原聚焦工作区与交互动效 | `artifacts/evidence/focused-workspace/722ae937/` | 9 场景通过；140 项 / 3 档通过 |
| 成员、插件、Agent、设备管理页 | `artifacts/evidence/management-pages/5c0f72c5/` | 452 项 / 12 档通过 |

Q0 的静态部分全部通过。最新 unit/web 共 **2081 项，2079 项通过**；两项未改动的 Hub 检查遇到 5 秒 import/build 超时。单独复跑时 build 项恢复，source import 项仍触发 5 秒限制，因此不得写成“全量 2081 项通过”，仍需 CI 确认。此前 2058 项全量通过对应较早的 50 项 checker，不能替代当前版本的全量结论。最新定向 checker、核心/宿主回归、固定 HEAD、独立审批和 CI 结果由主任务统一追加。

另一次 `artifacts/evidence/tidal-brand-theme/c4dc4d11/` 在 queued→dispatching 后等待 120 秒仍未进入 GPU 验证；该轮与 Q0 构建/类型检查并行，现有事实不足以归因为 UI 或确定底层根因。随后增加失败专用安全 `run-triage.json`：只读取 Run 状态/错误码、事件类型/受众/序号计数、审批状态、产物数量、outbox 状态和 Runtime PID，不记录载荷或正文。最终 `f4fcc587` 在不并行构建的情况下完整通过，但不能据此断言先前失败的根因。


## 真实故障验证与未触发样本

专项由五次独立的真人路径运行组成：前三次分别验证 1440/390/320 的浅深主题与实际 GPU；第四次仅对独立 owner 上下文的原生 `canvas.getContext('webgl')` 返回 null，验证不可用 GPU 时 CSS 备用形态的真实滚动暂停/恢复；第五次在真实 thinking 中注入原生 context loss，保持未恢复，再正常审批至真实 completed。后三种故障均不写 Run/phase、不插投影、不更换渲染结果。

GPU 验收在生产绘制同一帧读取真实 framebuffer，要求非空、蓝色/青色像素和不同帧哈希；同时检查真实 draw 调用计数及 shader 时钟。审批/reduce 的 framebuffer 可能已被浏览器丢弃，不能仅以两次全零哈希相同宣称静止，必须同时没有新 draw、时钟不前进且没有运行中的 CSS 循环。正常 thinking 时的键盘输入仍要求上述真实绘制继续。

完成中断探针先通过真实展开工具记录、hover 核心和向上滚轮进入阅读状态；生产“回到最新”入口证明自动跟随已退出，核心必须真实 active、在视口、有 WebGL、没有 paused，才能武装。MutationObserver 只观察真实 `data-completing`；出现后才调用标准 `WEBGL_lose_context`。`attempted=true` 且原生 `lost=true` 才表示目标故障确已注入。`completion-loss.json` 保存武装前几何/滚动前提、实际状态序列及终态标记/资源；独立判定把同 Run 的真实 active→unknown→completed 与故障、最终静态勾及零 canvas 关联。

前提未触发必须与目标故障失败分开记录：`9fd1d982`、`0767faad` 两次样本都是 `attempted=false / lost=false`，终态已经静止，不能算完成中断 bug 的红测。后者的实际序列显示核心始终可见、阅读状态已停跟随，但 thinking 后曾降为 unknown，再进入 completed；没有观测到收束窗口。记录本身用于归因，不能用源码预期替代实际注入。有效的故障红/绿目录与对应资产摘要须在最终结果中单独登记。

真正的定向变异红测为 `artifacts/evidence/tidal-brand-theme/44100e40/completion-loss.json`：该包保留同实例 `hasLiveWork` 记录真实工作资格，但仅撤销三处 context-loss 完成清理修复。它不是旧 HEAD 原编译包。实际武装时阶段已合法推进到 finalizing，核心仍 active、可见、有真实 WebGL 且阅读跟随已关闭；真实 completed 收束出现后 `attempted=true / lost=true`，随后 `data-completing` 持续未撤销、canvas 数为 1、完成勾不可见，浏览器门在“完成态不得保留 data-completing”检查失败。这才证明目标故障已被真实触发，而非依赖源码推断。

武装条件接受 thinking/tool/finalizing 三种真实工作阶段；不能为了维持测试预期而阻止 thinking 自然推进。独立判定从真实审批后的 active、unknown、completed 子序列建立关联，允许 unknown 后恢复到后续真实 phase，再落 completed；不得要求最后一个工作阶段一定是 thinking，也不得把中间的同步降级修改成旧 phase。

第五次运行只观测真实 context lost，不调用 restore；正常审批后的 completed 必须无需收束即可显示勾、没有 `data-completing`、没有 active 或 canvas、没有持续动画。原生 restored 事件计数须为零，丢失期间若曾启动完成收束也要拒绝。历史 completed 重新挂载同样要求零 canvas。目标收束时长是实现参数；当前序列没有完整时延统计，不把最终资源清除宣称为已测得某个毫秒 SLA。

真实 DOM 扫描覆盖当前可见文字而非只读根 token。浅深每档均保留“已受理”的实际字色、透明背景及祖先链，独立重新混合背景并检查 4.5。原生 closed details 的非 summary 子树按实际不可见处理；匿名空页自测通过真实点击证明展开后的低对比文字仍会被拒绝，closed summary 也不能豁免，嵌套关闭祖先会遮住内层已打开内容。没有降低文字/焦点阈值。

完整证据的 `facts.json` 与 `visibility-probe.json`、`visible-text-*.json`、`completion-loss.json`、`lost-before-completion.json` 必须相互对应，独立入口会拒绝把旧样本旁证混入新事实。失败诊断只记录状态、颜色、canvas/矩形/滚动及经过筛选归约的 GPU 日志，不保存页面正文或原始网络信息。录屏仅前三次认证后的 owner 路径；不可用 GPU 和永久丢失上下文位于独立无录屏窗口。


固定实现提交 `a70a902`；红测已重放为 `04ca0da`，验收版本与重放后整树无差异。最终定向 4 文件 / 107 项通过，其中 checker 73 项；敏感扫描及 626 包许可门通过。独立审批和服务端 `check` / `integration` 结果按本切片 PR 记录，必检未通过不得合入。
