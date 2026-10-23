# ReactBits 可感知动效与状态保留验收

## 范围与来源

用户明确要求动效有清晰可感知的反馈。本轮只使用已登录的 `bits.collectui.pro` 页面源码，新增 Agent Activity 2、Wizard 1、Tool Calls 5、Card Spread、Depth Card，深化已接入 AI Chat 2。共 25 个来源 / 30 个展示导出，无新增运行依赖。私有适配与保留摘录仍在忽略的 `artifacts/private-ui/collectui/`；公开仅 minified 资产、声明与摘要，不宣称不可逆加密。

| Before | After | Why |
| --- | --- | --- |
| 展开、入场统一在 160ms 内结束 | 控件反馈保留，展开 360ms、列表入场 440ms、抽屉进退场 320ms | 用户可以感知空间与状态衔接 |
| 抽屉关闭立即隐藏 | 保留退场表面，立即 inert/aria-hidden 并回焦，重开取消旧卸载 | 支持反向操作且不延迟输入 |
| 项目卡静态平面 | 指针归一化的深度与聚光，有限弹簧携带速度，静止即停 | 连续反馈，无空闲持续循环 |
| 运行记录原生硬开关 | 时间线连接、旋转提示和连续展开；内容保持挂载 | 保留阅读与控件状态 |
| 文本预览重复读取、缺少收起入口 | 预览框、显式关闭、保留不可变文件读取结果 | 返回原操作，重开零重复读取 |
| 设备配对没有阶段表达 | 三段指导，成功签发只推进至电脑配对 | 不把已有在线设备当成本次配对成功 |

Card Spread 的扇形几何用于文件分组标记，数量来自当前用户实际可见的交付物；图形不遮盖文件入口。Tool Calls 5 只借用输出面板/筛选结构，使用现有受众过滤后的真实事件、错误与计数，协议没有提供的 stdout/stderr、命令或退出码不出现。业务权限、草稿、请求体、发布/审批与重跑流程由宿主持有。

## 驱动与独立判定

```bash
pnpm build
pnpm check
# 本机多任务时，Q0 前半逐项检查后可用以下低并发完整 unit/web，判据不变：
pnpm exec vitest run --project unit --project web --maxWorkers=2
pnpm exec playwright test --config=playwright.motion.config.ts
node --import tsx scripts/verify-workspace-evidence.mts artifacts/evidence/focused-workspace/<本轮目录>
node --import tsx scripts/verify-motion-evidence.mts artifacts/evidence/focused-workspace/<本轮目录>
pnpm exec playwright test --config=playwright.management.config.ts
node --import tsx scripts/verify-management-evidence.mts artifacts/evidence/management-pages/<本轮目录>
```

Web 5313 / Hub 18183 使用隔离的真实生产装配，不操作用户 5173 预览或另一个工作区。浏览器门走 Setup、成员加入、真 Node 配对、Runtime replay、两次真实执行与审批、产出和发布。第二份材料由显式重跑及审批产生，禁止直插投影。原有工作区、成员权限、文件动作、七类页面与窄屏验收继续执行。

`motion-experience-audit.ts` 在真实点击生成的浏览器动画上暂停采样 20%/80% 中间帧：要求抽屉位移和展开高度实际变化。声明时长与实际时长分开记录：浏览器在中途反向时会缩短实际持续时间，这是连续重定向，不能误判为声明时长漂移。正常时长/上界、几何与可交互状态均保留独立判据。

`web.motion` 的独立判定入口要求 1440/390/320 三档齐全，缺动画/缺帧/静止帧、丢草稿或缓存、重复读取、意外 POST、错受众、失焦、溢出、减少动态效果失效或空闲写样式均失败。单测用负控逐项破坏事实，验证检查本身能拒绝错误数据。定时卸载窗口与实际 CSS token 有一致性检查。

## 证据与归因

- `artifacts/evidence/focused-workspace/<本轮目录>/facts.json`：既有工作区九组事实；`motion.json`：深度反馈与三档连续动效事实。
- `motion-*.png`：稳定状态实拍；`motion-preview.webm`：单独的只读短录屏，从认证和配对码签发之后开始，只看项目/执行/已发布文件，零 POST。不会录登录、有效配对码或邀请链接；录屏上下文只复用同一演示 owner 的会话，绝不与 member 共享。
- `scripts/verify-motion-evidence.mts` 先要求整体驱动完成且无浏览器错误，再检查动效事实和 8 张截图/录屏文件；驱动半途失败留下的局部事实不能独立宣称通过。
- 动画/焦点/裁切先看 web.motion；读写/审批失败查 hub.http/hub.domain；配对与执行查 node.gateway/runtime.bridge；来源/私有输入/资产摘要查 collectui manifest。
- 原文、Cookie、口令、邀请 token、未发布材料正文和本机绝对路径不进证据。日志脱敏后入上述长期目录，运行敏感扫描，不以临时日志为唯一记录。

## 本轮结果

红测 `bcbdcfb`，4/4 在旧实现失败。本轮工作区证据 `artifacts/evidence/focused-workspace/a12e13e1/`：完整生产装配通过，既有 9 场景独立判定成功；新增动效独立判定 122 项 / 3 档成功，含真实中间帧与只读录屏。旧布局取证改为等待抽屉自然入场结束后测量，边界判据未放宽。

Q0 格式、lint、全仓类型检查、依赖边界、协议生成、插件 fixture 均通过；Q1 unit/web 共 183 文件、1959 项通过、7 项预期失败；Web 生产构建通过，许可检查 626 包通过。日志已脱敏保存在上述证据目录。构建仍提示既有大 chunk 警告。

管理页真实回归通过，`artifacts/evidence/management-pages/163527f7/` 独立判定 450 项 / 12 档通过；配对码签发后即使出现在线设备仍停在“电脑配对”，没有伪造本次配对完成。独立审批结果随后登记。GitHub API 当前返回 401，尚未登记本轮 Issue、推送、创建 PR 或运行 CI；使用临时本地分支保留工作，不绕过登录或 main 保护。验证浏览器为 Chromium；真实触摸设备手势不在本轮范围。
