# P1-437 潮汐蓝主题验收

产品已确认主色 `#195BDD` 与青绿点缀 `#13B8A6`。WhalePod 的品牌色属于应用层；DSH 复制资产、原始色值与许可记录保持原样。ReactBits 组件继续消费宿主语义，不复制另一套裸色进编译包。

| Before | After | Why |
| --- | --- | --- |
| 品牌、主按钮和导航主要呈黑白 | 品牌 W、主操作与发送用潮汐蓝；导航选中、资源/文件图标与抽屉标题使用蓝色浅面 | 品牌在主要路径上实际可见 |
| 强调色与上游白名单绑在一起 | 应用 `--brand-*` 层与上游 `--dsw-*` 来源分开核验 | 允许产品拥有自己的视觉，同时保持复制品可核 |
| 深色仅重绑上游变量 | `body[data-ds-dark-theme]` 显式重绑应用语义，同色族状态标签改用可读亮档 | 避免继承已解析的浅色别名；红/琥珀/绿含义不变 |
| 焦点串在根节点提前解析 | 唯一 `--focus-ring` 声明移至 body，保留 2px/4px 两层 | 与真实主题变量同元素求值，浅深对比一致 |

## 色彩用途与边界

主按钮/发送的共享契约为 `--brand-primary`、`--brand-primary-hover`、`--brand-on-primary`；静止和 hover 白字分别达到 **5.86:1 / 8.20:1**，浅深一致。导航、链接、图标、提示、平台、chrome 和抽屉标题各有明确语义值，不把整页铺成高饱和底色。青绿作为品牌装饰和活动视觉，不直接做白字小按钮，也不单独承担成功/错误含义。

供 Agent 活动视觉引用的 API：

| Token | 浅色 | 深色 |
| --- | --- | --- |
| `--brand-agent-blue` | `#195BDD` | `#6E9DFF` |
| `--brand-agent-teal` | `#13B8A6` | `#35D6C1` |
| `--brand-agent-sky` | `#65A5FA` | `#3D7FE6` |
| `--brand-agent-mist` | `#9CEADD` | `#86EFDF` |

等待审批仍为琥珀、成功仍为绿、失败仍为红。深色采用同色族 100 档亮标签 / 900 档深面；危险按钮只有文字语义改为明确登记的 `--color-danger-strong`，浅色仍为原 red-900。中性按钮面、危险面、输入面、描边与胶囊几何继续由既有上游契约核验。

本轮沿用既有 `body[data-ds-dark-theme]` 属性验证深色，未新增主题切换入口。普通文字按 4.5:1，焦点按至少一条可见 2px 环带达到 3:1；不可用控件的 opacity 不作为正常操作文字配对。图形/装饰色不能据此声称满足普通文字标准。

## 驱动、观测与拒绝条件

红测提交 `04ca0da` 中主题 6/6 在旧实现失败。相关门复跑：

```bash
pnpm exec vitest run apps/web/tests/brand-theme.spec.ts apps/web/tests/theme-contrast.spec.ts apps/web/tests/control-family.spec.tsx apps/web/tests/focus-ring.spec.ts apps/web/tests/vendor-dsh-ui.spec.tsx apps/web/tests/instruction-contrast.spec.tsx --maxWorkers=1
```

源级结果：**6 文件 / 117 项通过**。`brand-theme.spec.ts` 从实际 token 与样式声明检查主按钮、发送、W、导航和卡片消费关系；32 组浅深文字配对均 ≥4.5。焦点门在 22 组浅深背景上检查双层厚度、相邻色对比、唯一声明和键盘挂载，保留原历史负例，并将历史蓝/平台面固定到未变的上游锚点，避免品牌换色篡改历史判据。

控件门继续拒绝非登记 token、裸色、错误几何、未登记 hover/disabled/媒体覆盖。新增主操作误用同值 `--brand-link`、hover 偷用亮青绿的负控；危险标签只有具名应用语义例外，危险面改红、文字改亮别名等拒绝条件仍在。

上游孤儿门登记且只登记三项因应用品牌迁移而保留的原始锚点：`--dsw-static-blue-100`、`--dsw-static-blue-600`、`--dsw-specific-sidebar-nav-item-active`。确切集合与原值受检查，active 浅色仍指 neutral-bluish-100、深色仍指 neutral-bluish-750；未知孤儿与旧 amber-500 删除负控继续拒绝。没有添加假消费或重写原始 DSH 色。

## 取证与归因

源级机器报告位于 `artifacts/evidence/tidal-brand-theme/437-source/contrast.json`，标记 `sourceOnly: true`。其中 32 组文字和 22 组焦点背景由实际 CSS 及共享对比度算法计算；源级报告不能替代浏览器成品验收。

| 配对 | 浅色 | 深色 |
| --- | --- | --- |
| 主操作白字 / 默认蓝底 | 5.86 | 5.86 |
| 主操作白字 / hover 蓝底 | 8.20 | 8.20 |
| 链接 / 卡片面 | 5.86 | 6.61 |
| 选中文字 / 选中面 | 8.82 | 7.81 |
| 提示文字 / 提示面 | 6.87 | 8.09 |
| 成功标签 / 成功面 | 10.98 | 10.98 |
| 警告标签 / 警告面 | 14.30 | 14.30 |
| 危险标签 / 危险面 | 11.75 | 11.75 |
| 危险操作文字 / hover 控件面 | 12.90 | 9.90 |

颜色未加载/浅深不翻先归因 `web.theme.cascade`；不达标查 `web.theme.contrast`；主操作/危险标签误用查 `web.theme.controls`；复制品源值、保留锚点或 manifest 问题查 `web.theme.source`。真实品牌控件、窄屏任务页和活动视觉已由 P1-437 生产浏览器驱动完成验收，最终 DOM 结果见下节；源级与浏览器证据分别保存。


## 深色指令局部覆盖回归

第一轮 32 组根语义配对没有覆盖元素自己重绑状态变量的情况。真实深色任务页随后发现“已受理”仍被 `.instruction-state-accepted` 的 green-900 覆盖，尽管 body 的成功语义已经改成亮档。根 token 对比度通过不能推导全部 UI 通过。

本轮为待受理、已受理、已排队、已拒绝、拒绝理由、流读取不完整、自动目标、显式目标、运行事件读取告警 **9 处**增加 `body[data-ds-dark-theme]` 限定的同族局部重绑；原 light 900 声明不改。运行事件告警的实际正文在 `.run-events-alert p` 使用中性正文色，判据按真实正文色与警告混合背景分别计算，没有把它伪装成同色 chip。

`instruction-contrast.spec.tsx` 原 7 个 `it.fails` 深色已知缺口转为正常通过门。精确选择器读取继续拒绝重复规则块/重复属性，避免将 dark 后缀误当 light 本体、或只读第一条覆盖。真实局部字色、背景混合比例和重绑值在三种深色容器底上复算，共 **27 组**：已受理最低 **7.77:1**，最小配对为排队/自动目标的 **4.75:1**，均 ≥4.5。

六类变异负控分别拒绝旧 900 局部覆盖、错误语义家族、错误实际字色、90% 过浅混合底、重复覆盖，以及“局部语义名正确但 body 把成功色改回暗档”。相关六文件最终 **117 项通过，无预期失败**。新增源级证据 `artifacts/evidence/tidal-brand-theme/437-source/instruction-dark.json` 标记 `sourceOnly: true`；该源级报告与最终真实 dark 文案扫描、实拍分开保留，最终 DOM 结果见下节。


## 真实 DOM 最终结果

最终生产装配证据为 `artifacts/evidence/tidal-brand-theme/f4fcc587/`，不沿用早期 `0836af5d` 的结果作为 GPU 完成边界证明。浏览器驱动 **1 项通过**（测试约 1.6 分钟，含服务装配约 2.2 分钟）；独立复判输出 **2000 项检查 / 3 次运行 / 6 档布局 / 32 组文字配对 / 22 组焦点背景**，`ok: true`、浏览器错误为空。

```bash
pnpm exec playwright test --config=playwright.agent-brand.config.ts
node --import tsx scripts/verify-agent-brand-evidence.mts artifacts/evidence/tidal-brand-theme/f4fcc587
```

1440、390、320 三档各测浅色和深色。项目创建主按钮与任务发送按钮的真实默认背景均为 `rgb(25, 91, 221)`、hover 为 `rgb(18, 71, 177)`，前景均为白色；真实配对分别达到 **5.86:1 / 8.20:1**。六档导航选中态均匹配品牌浅深面与文字；桌面 W 为白字潮汐蓝底，保留 `rgb(19, 184, 166)` 青绿细节。390/320 使用移动导航，布局中没有 W 入口，记录为 `null`，没有把它计为测试成功。

浅深各 16 组 DOM 文字配对共 **32 组**，最低为浅色提示文字 / 页面底的 **5.37:1**；22 组实际焦点背景均存在至少一条可见 2px 环带达到 3:1，最小有效承载比为深色主按钮上的 **5.61:1**。这两个最低值仅对应各自登记矩阵，不冒称全部可见文字的最小值。

六次运行中任务页可见文字扫描分别检查 **43、43、32、32、31、31 项，共 212 项**，`offenders` 与 `undecidable` 全部为空。三档真实“已受理”标签在浅色合成背景上为 **9.67:1**，深色为 **7.77:1**，与根语义成功徽标的 10.98:1 分开记录。可见性探针证明关闭的 details 后代不参与扫描；展开外层/内层后，故意构造的白底白字分别被检出，重新关闭外层后被排除；关闭 summary 自己的故意低对比文字仍正确判负。

六档 `document.scrollWidth` 均等于视口宽度。历史完成态保持静止且没有 canvas；只读品牌检查 `readOnlyPosts: 0`。思考、审批、完成的实拍和 `agent-brand-preview.webm` 存于最终目录，录屏开始于认证之后；深色通过既有 body 属性激活，没有新增用户入口。

最终目录也包含两条真实故障执行：`completion-loss.json` 在完成收束期间成功触发 WebGL 上下文丢失；`lost-before-completion.json` 在思考中丢失并保持不恢复后再完成。两条最终均为静态、可见的完成标记，无 `data-completing`、无运行中 CSS 动画、canvas 数为 0。主题结果与这两条完成资源边界的独立事实一起通过最终判定。

本地相关主题门 **117 项通过**，Q0 静态项通过。最近一轮全量 unit/web 为 **2081 项，其中 2079 项通过、2 项未改动的 Hub 导入/构建超时**；定向复跑一项恢复，另一项仍在 5 秒导入阶段超时，因此不登记“2081 项全过”。该全仓结果与已经通过的主题门、生产 Q5 分开报告，最终全仓判定以本 PR 的 CI 记录为准。
