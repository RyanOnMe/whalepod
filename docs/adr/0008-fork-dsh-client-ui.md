---
status: accepted
---

# 0008 Fork DSH client UI 源码：只取设计层与视图层，不取壳与 RPC

WhalePod 从上游源码仓（github.com/deepseek-ai/deepseek-harness）复制 `packages/client/ui-*` 中的设计层与视图层进入本仓（vendored copy，不是新增依赖），按 L1 主题 → L2 原语 → L3 运行视图分片推进；`apps/web` 壳与 RPC 全替换永久禁止。DSH 仍是 Runtime，Team/Task 事实仍由 WhalePod 权威保存，因此本决策推翻的是原型 §3 的实现途径，不是继承边界本身。

## 背景

`prototype/DESIGN.md` §3「不直接 Fork DSH Web 的原因」曾裁决不 Fork，理由四条：DSH Web 的首要对象是本地 Workspace 与 Session，WhalePod 的首要对象是团队交付 Task；DSH 的指南是「配置模型 → 选 Workspace → 启动 Session」，WhalePod 必须先表达责任、公开进展、审批边界与 Artifact 发布；把团队身份与权限塞进 Runtime UI 会让上游升级、隐私边界与团队事实同时耦合；DSH 官方仍在 developer preview，组合公开 seam 的升级成本低于长期维护产品级 Fork。

2026-09-10 仓库所有人裁决推翻该条款，改为 Fork DSH client UI 源码。尽调事实：`@deepseek-ai/*` 全部 MIT（每个包带 LICENSE，Copyright (c) 2026 DeepSeek），上游源码仓库公开；npm 分发物是编译后的 JS，无源码、CSS 打包进 JS，因此 Fork 只能从上游源码仓做，无法从 `node_modules` 提取；上游 UI 在 `packages/client/ui-*` 共 **43 个包**（实测：整树 1396 文件 / 8.71 MiB，剔 tests/fixtures 后 1005 / 4.77 MiB，仅 `src/` 745 文件——口径不同数字差别很大，故三者并列）；其中 **40 个有 cordis 插件入口**（`src/client/index.ts`），`ui-theme` 也是 cordis 插件；另 3 个（`ui-primitives`、`ui-slots`、`ui-dockkit`）**自述 zero cordis、无插件入口**——这个分布直接决定了分层难度：L1 要剥 cordis，L2 不用。`apps/web` 壳本身极薄（`main.ts` + `preview.ts`），UI 全在插件包里。

前三条否决理由指向的是**产品权威归属**，第四条指向的是**维护成本**。分离这四条才能看见决策空间：界面层与壳的归属可以变，产品权威不该变；而成本要由分层深度来控制，不能由「Fork 或不 Fork」一刀切。

## 决策（2026-09-10 拍板：分层 Fork L1+L2，L3 后续切片）

1. **推翻与保留的边界**。推翻 `DESIGN.md` §3 的「不直接 Fork DSH Web」结论，以及 ADR 0001「Considered Options」第一条中被否决的 Fork 实现途径（ui-theme / ui-primitives / 运行视图源码可进本仓）；**保留** 0001 的实体：DSH 是 Runtime、不是产品权威，Team/Task/Approval/Artifact 由 WhalePod Hub 权威保存，DSH Web **不成为顶层导航与团队事实来源**。§1/§2 的继承边界不变。协作对象（Team、Task、成员权限）永不放进 DSH 插件树——这是 0001 否决理由中不可让渡的部分。
2. **Fork 深度分层**。L1 主题：`ui-theme` 设计 token（变量/字体/间距）剥出 cordis，首批；L2 原语：`ui-primitives`（按钮/弹层/输入）——上游该包**本就是 zero-cordis 的纯 React 库**（`package.json` 自述 “zero cordis”，无 cordis 插件入口，运行时不引用 cordis；包内 `@deepseek-ai/cordis` 仅是 peerDependency 残留），因此移植**不需要去 cordis 化**，只处理 import 形态（`clsx` → 本仓自带的 `cx`、后缀补 `.js`）——首批切片实测印证：其 adaptations 里没有这一项。首批；L3 运行视图：`ui-chat` / `ui-conversation` / `ui-trajectory` / `ui-tool`（Run Console 的 transcript 与工具渲染），后续切片，前提是把 DSH 的 session/turn 数据协议映射为 WhalePod 的 Run 事件；L4 整个 `apps/web` 壳 + RPC 全替换 —— **禁止**，会撞回 §1/§2 的否决理由。
3. **Fork 是 vendored copy，不是依赖**。复制源码进本仓，`@deepseek-ai/*` 依赖面零变更，AGENTS.md 红线「只有 `packages/runtime-dsh` 和 `apps/runtime` 可以 import `@deepseek-ai/*`」继续逐字有效。落地约束：vendored 代码放**应用内的专用子树**（首批 `apps/web/src/vendor/dsh-ui/`），不进 `packages/*`、不进 workspace——它必须是「看起来就知道是复制品」的东西，而不是一个能被别人当依赖装的包；只能按本仓**相对路径** import，不得以包说明符或 `@deepseek-ai/ui-*` 名义解析；子树内保留上游 LICENSE 全文与 `Copyright (c) 2026 DeepSeek`，并以 `manifest.json` 钉住上游 repo、取用 commit SHA 与逐文件映射。**出处与许可登记由随行的文档 PR 承载**（`NOTICE` 的第三方声明 + `docs/agent/dsh-ui-vendoring.md` 的人读台账）——切片 PR 供机器可核的 `manifest.json`，台账 PR 供人读的映射与同步纪律；**两者必须同批合入**，否则本 ADR 宣告的完成判据（登记文件缺失即视为未完成）不成立。另一处本仓侧改动也要记：vendored 子树列入 `.oxfmtrc.json` 的 ignorePatterns——理由是保住上游紧凑 CSS 的字节锚点，不让本仓 formatter 重排它（改的是本仓口径，不是上游文件）。Q0 静态门新增断言钉死三条：业务代码零 `@deepseek-ai/*` import、vendored 目录不以包说明符出现在本仓 import 里、登记文件覆盖 vendored 目录的每个文件。取源纪律：只从上游源码仓按钉住的 SHA 取（npm 分发物是编译 JS，不可提取）；同步方式为人工比对 + 更新 SHA，**不存在自动合并**；「可复跑取源脚本」与 L3 视图一起评估（首批以 `manifest.json` + 台账记录为准，脚本未落地前不得声称可复现）。
4. **协议主权留在 WhalePod 侧**。L3 只渲染 WhalePod 的 Run 事件与 Projection，`runId ↔ sessionId` 映射与事件投影生成仍在 `packages/runtime-dsh` / `apps/runtime`；Fork 来的视图不接触 DSH session 数据结构，否则 L3 会把 0001 的边界重新拉进 UI 层。
5. **品牌剥离**。`ui-brand-official` 与任何 DSH 商标、鲸鱼 logo 资产不 Fork（TRADEMARKS.md 红线）。L1/L2 交付物带 WhalePod 自身视觉标识。**具体到文件**（2026-09-10 实测）：品牌图形并不只住在 `ui-brand-official` 里——`ui-primitives/src/` 内的 `FishLogo.tsx`（导出官方 fish logo 的 SVG path）与 `BrandWordmark.tsx`（官方品牌字标）**都在该包的公开导出面上**，因此「取整个包」这类偷懒动作会把品牌资产一并带进本仓。取源必须逐文件过，vendored 子树内不得出现这两个文件及其图形数据；**该复查落成 Q0 断言**（子树内禁止出现 `FishLogo`/`BrandWordmark` 文件名与 `FISH_LOGO_*` 等图形导出）——人工「复查一次」不算完成，它不可执行也不可核。
6. **不整仓继承**。43 包 / 6.5MB 不是继承范围，只取被 L1/L2/L3 点名的部分；上游漂移按 patch 形式人工 cherry-pick，不存在自动合并纪律。

## 后果

- 正向：Run Console 的 transcript、步骤与工具渲染不必从零重写，直接继承上游已调优的交互细节；设计 token 与原语成为本仓一等代码，团队 UI 与运行视图共享一套视觉语言；Fork 深度可停止在 L2，L3 之前不接触数据协议，误入 L4 之前有明文闸门。
- 代价与风险：一，上游漂移——fork 后 DSH 的 UI 修复不会自动到达，需人工 cherry-pick，无自动合并纪律，故 vendoring 必须记录上游 commit 才能判断「已分叉多远」。二，Q5 浏览器门要覆盖全部新组件，现有 **17 条用例 / 5 套 project**（`playwright test --list` 实测）基于旧壳，需随 L1/L2 落地扩容，不能只靠局部截图判定。三，品牌剥离是硬约束：任何 DSH 商标/logo 资产随 Fork 进仓即违 TRADEMARKS.md，审查须逐资产过。四，MIT 合规是保留版权与许可声明的义务，登记文件缺失即视为未完成。
- 弃选：只借视觉 token、不 Fork 原语与视图——不用担上游漂移，但收益只剩「颜色字体看起来像」，交互与运行视图（对话、步骤、工具渲染）仍要自己重写；token 这一步本决策采纳的 L1 也会做，区别在于是否继续往 L2/L3 走；维持现状（自有 UI + 组合 seam）——保住 0001 的纯度，但长期重写 DSH 的对话/步骤/工具渲染，是更慢的漂移；全壳 Fork——短期最省事，代价是 43 包的 cordis 依赖树与整个 RPC 面一同进仓，且正面撞上 §3 理由 3 与 ADR 0001 的否决，不可接受。
- 后续：L1/L2 先落 vendored 子树（含 manifest/出处注释）+ 许可与出处登记 + Q0 新断言、Q5 扩容；L3 与 Run 事件协议映射另行切片拍板，届时同步回填 `prototype/DESIGN.md` §3 与 `04-验收矩阵与测试策略.md` 的 Q5 覆盖范围。
