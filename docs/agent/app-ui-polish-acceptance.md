# App UI 展示层精修验收（P1-421）

- 对应：G5 审批、G6 交付物、Q0、Q5；沿用 ADR-0018/0019 的连续工作区。
- Issue：#421。日期：2026-10-23；实现锚点与最终门检见本 PR。
- 本轮范围：聊天输入栏、审批卡片、文件卡片及其“更多”菜单。运行协议、权限、草稿和滚动归属未改。

## 用户路径与来源

进入任务 → 输入要求/选择 Agent → 真实审批 → 检查候选文件 → 发布给团队 →
通过“更多”选择复核/修订/讨论引用。主操作保留预览和下载。

网页来源：

- [Prompt Input 2](https://bits.collectui.pro/docs/app-ui/prompt-input/prompt-input-2)
- [Agent Approval 1](https://bits.collectui.pro/docs/app-ui/agent-approval/agent-approval-1)
- [AI Chat 2](https://bits.collectui.pro/docs/app-ui/ai-chat/ai-chat-2)

经维护者明确确认的混淆包集成：仅提取展示结构，替换为宿主槽位和 WhalePod 主题变量。
移除演示消息、模型/搜索选择器、模拟 token 数、计时器、演示审批状态及滚动/流式实现。
不新增 Motion、图标包或运行时依赖。审批参数与有效期保持直接可见。

可编辑适配源码及保留的原文摘录在忽略目录 `artifacts/private-ui/collectui/`。
公开目录只包含 minify 后的 JS/CSS、自有声明文件、许可说明与来源清单。
`capturedExcerptSha256` 是所留摘录的摘要，不冒充上游完整文件或 Git revision。
维护者关于客服授权的确认按事实记录在 LICENSE.md；未宣称这些资产获得 Apache-2.0 授权。

## 驱动、观测与判定

```bash
pnpm check
pnpm test:e2e:workspace
node --import tsx scripts/verify-workspace-evidence.mts artifacts/evidence/focused-workspace/<本次目录>
node --import tsx scripts/verify-app-ui-evidence.mts artifacts/evidence/focused-workspace/<本次目录>/facts.json
pnpm exec playwright test --project=p1-19
node --import tsx scripts/run-conversation-acceptance.mts
pnpm test:e2e:micro
```

Q5 使用一次性 PostgreSQL、包解析后的真实 Hub、Node、Runtime 与 DSH replay。
只有已登记的静态 Plugin Pack 种子；不直写运行状态或团队投影。协议/HTTP 路径沿用生产装配。
驱动在 `apps/web/tests/e2e/app-ui-audit.ts` 与 focused-workspace；独立纯判定器在
`scripts/lib/app-ui-evidence.ts`，缺字段、缺档位、菜单溢出、额外 POST、过小按钮、错误回焦均失败。
负控由同目录 spec 自证，旧工作区独立判定器也调用新判定并检查六张新增截图存在。

| component | 观测 | 判据 |
| --- | --- | --- |
| web.app-ui / prompts | 1440/390/320 输入数量、输入与外框焦点阴影 | 唯一原生输入；无内外两层焦点框；草稿与原 HTTP 路径由现有组件/端到端测试覆盖 |
| web.app-ui / approvals | 卡片与参数几何、批准/拒绝按钮高度 | 三档无横向溢出；参数在卡内可读；两按钮至少 40px；有效期直接可见 |
| web.app-ui / files | portaled 菜单几何、项数、POST 计数与焦点 | 三档含三项低频动作、未触发 POST；ArrowDown 可达；Esc 只收菜单，外层面板保留并回焦 |
| web.approval / web.artifact | 真正决定、下载摘要、发布前后双受众事实 | owner 决定、他人等待、candidate 私有、已发布可共享；真实复核/修订仍走原流程 |
| bundle | 分发文件集合、编译/输出摘要、导出与许可说明 | 无原始 JSX/TSX/CSS 源文件或 source map、无凭据/网络/演示状态；任何资产漂移必须更新清单 |

菜单层采用现有 DSH Menu，宿主补齐 portal 初始聚焦。完整门检曾发现晚到的聚焦帧会把
已按 ArrowDown 的用户拉回首项；已改成只修复缺失焦点，并有确定性延迟帧回归。
文件标题保留原 `.artifact-title` 契约，连续对话内的文件入口与只读抽屉标题分开标记。

## 视觉复核

| Before | After | Why |
| --- | --- | --- |
| 输入与工具行偏松，焦点可能突出内层 textarea | 单一外框、紧凑工具行、明确发送按钮 | 输入是首要动作；焦点强调整个输入面 |
| 审批字段与动作缺少层次 | 状态/工具标题、参数正文、尾部决定三层 | 决定前仍能直接检查真实参数与过期时间 |
| 文件标题和五个操作平铺 | 图标/标题/状态尺寸；预览、下载常驻，其他动作收进菜单 | 降低默认噪音，同时保留完整可达性 |
| 历史卡片布局与抽屉文件表现各异 | 共用编译后的 FileCard 槽位 | 连续对话和详情共享同一文件语言 |

## 证据、归因与维护

生产事实及截图：`artifacts/evidence/focused-workspace/<本次目录>/`。
该目录 `facts.json` 含 `web.app-ui` 的九组测量；新增 `app-ui-approval-{1440,390,320}.png`
与 `app-ui-files-{1440,390,320}.png`。默认输入栏见 desktop-ready.png。
同一套证据还覆盖十类抽屉/二级页面的三档布局，必须由旧工作区判定器一并复核。

提交前运行 `scripts/secret-scan.sh` 与该证据目录扫描；不把原始口令、Cookie、key、
本机路径、未发布用户正文或网络 trace 放入证据。忽略目录本身不进入 Git。
文件行为失败先对 web.artifact → hub.http/artifact.store；审批先对 web.approval →
hub.domain → node.gateway/runtime.bridge；菜单/焦点先看 web.app-ui 的几何和 keyboard 事实。

授权维护者重编译：`node --import tsx apps/web/tools/build-collectui.mts`。
公开 clone 可直接使用已提交资产构建；没有本地私有源码时不能重生成该受限资产包。
JS/CSS/manifest 必须一起重编译，不手改生成文件。编译出现警告即失败。

边界：未测所有辅助技术/浏览器；本轮 Chrome + jsdom。没有将 minify 宣称为加密或保密
保障。CLI 接入验证是此前的独立工具验证，这次三类 App UI 均取自网页，不冒充 CLI 安装。

## 最终验证记录

待本轮门检、独立 agent 评审及 CI 完成后回填。
