# 下拉迁移（原生 `<select>` → vendored `Menu`）验收

- 对应场景/门禁：Q5（浏览器门）· Issue #158（#138 L2 落页第一片）
- 对应 Issue：P1-158
- 上次验证：2026-09-11 · `061c470`(+ 本轮 Q5 修复) · **PASS（5 个既有 project + 本次新增的 p1-158 全绿，17 个用例）**

## 验的是哪条用户路径

真人在**七个落页点**用键盘或鼠标选一个值，而且这一步在桌面与 390×844 两档都成立：

| # | 落页点 | id | 用户动作 |
|---|---|---|---|
| 1 | Agent 页 · 新建 Agent | `#agent-plugin-pack` | 选 Plugin Pack → 建 Agent |
| 2 | Agent 页 · 新建 Revision | `#revision-plugin-pack` | 选 Plugin Pack → 建 Revision |
| 3 | 成员页 · 邀请 | `#invite-role` | 选角色 → 生成邀请链接 |
| 4 | 项目页 · 创建任务 | `#task-assignee-<projectId>` | 选责任人 → 建任务 |
| 5 | Task Room · 启动 Run | `#run-agent` | 选 Agent |
| 6 | Task Room · 启动 Run | `#run-revision` | 选 Revision（选定即快照） |
| 7 | Task Room · 启动 Run | `#run-device` / `#run-workspace` | 选设备 → 选 Workspace |

不是「测某个组件」：判据落在**真人路径能完成选择**，且**页面里确实不再有原生 `<select>`**。

## 驱动（怎么触发）

```bash
# 逐个 project 串行冷启（全机同一时刻只允许一套栈：5173/18080）
pnpm exec playwright test --project=p1-07    # Task Room 双上下文主链（含 #158 的指派键盘路径）
pnpm exec playwright test --project=p1-19    # 全链：Run → 审批 → Artifact（覆盖运行期四处下拉）
pnpm exec playwright test --project=p1-140   # 实时观察（同一套栈里的第三个界面状态）
pnpm exec playwright test --project=p1-141   # 邀请链（#invite-role 的真人路径）
pnpm exec playwright test --project=p1-142   # 设备配对 UI（起真 node，才有设备/Workspace 选项）
pnpm exec playwright test --project=p1-158   # 本 Issue 自己的两档截图与定位审计（#158 新增）
```

`p1-158` 是 #158 新增的 project（`apps/web/tests/e2e/select-menu-audit.spec.ts`）：它要真跑到
四个界面全部渲染、还要起真 node 才有设备与 Workspace 可选项，所以**独占一套冷启环境**，
不塞进 `p1-140`（那套的判据是「对端零操作」，混进来会弄脏语义）。

## 观测（看什么）

| 观测面 | 怎么读 | 判据 |
|---|---|---|
| 控件类型 | `assertNotNativeSelect(control, scope, name)`（`tests/e2e/helpers.ts`） | `tagName !== 'SELECT'`、`role=button`、`aria-haspopup="menu"`、可访问名不变、**作用域内 `select` 计数 0** |
| 展开语义 | `selectFromMenu(trigger, option)` 的三段断言 | 点前 `aria-expanded=false` → 点后 `true` → 选中后回 `false` |
| 真实样式 | `assertMenuTriggerTokens(trigger)`（`getComputedStyle`） | 背景/描边最终值 == `:root` 上该 token 的解析值；圆角 8px |
| 窄屏定位 | `auditMenuAt(...)` 的几何断言（390 档） | 列表不越出视口左右边界；页面 `scrollWidth <= clientWidth + 1` |
| 回焦 | `expect(trigger).toBeFocused()` | 选中后焦点回到触发器（真实浏览器落点） |
| 对比度 | `expectNoContrastOffenders(page)`（#159 的门） | 正文 ≥4.5:1；门扫到的元素数 > 0（防假绿） |
| 截图（给人复核的取证） | `artifacts/evidence/select-menu/<viewport>/<落页点>.png` | 7 落页点 × 2 档 |

**判定不靠截图**（红线）：截图是取证，判据是上面那些能写成断言的检查。

## 判定（成功长什么样）

1. 六个 project 全绿，且 `p1-158` 的两档几何断言全过；
2. `apps/web/tests/select-menu.spec.tsx`（Q0，19+ 条）全绿——它管的是**源码文本判据**：
   全树无 `<select` 开标签、CSS 规则按契约常量吃 token、探针不许退回 `raw*` 形态；
3. 变异验证：把任一处改回原生 `<select>` → 相关断言变红（见「迁移注意」第 3 条）。

## 归因（失败先看哪层）

| 现象 | 先看 |
|---|---|
| 找不到控件 / 控件被禁用 | `SelectMenu` 的 `disabled` 与宿主表单守卫（PackSelect 的空列表、RunLauncher 的 `ready`） |
| 菜单开了但项不对 | `items` 映射（项文案是否与原来的 `<option>` 一致；placeholder 是**禁用项**） |
| 窄屏溢出 / 页面横向滚动 | `.select-menu` 的 `width:100%` 与 vendored `.list` 的 `min-width: 218px`（`portal` 未接线时才可能） |
| 对比度不达标 | `global.css` 的 `.select-menu` 段（**尤其别给 `:disabled` 加 `opacity`**，见下） |

## 本轮实测记录（2026-09-11，逐个冷启，跑完确认 5173 释放再起下一个）

| 顺序 | project | 结果 | 用例数 | 耗时（playwright 自报 / 含冷启） | 说明 |
|---|---|---|---|---|---|
| 1 | `p1-07` | ✅ | 1 passed | 18.5s | 3 轮：前两轮红→修好→复绿（见「迁移注意」1、2 条） |
| 2 | `p1-19` | ✅ | 13 passed | 2.9m（172s 含冷启） | 全链：G5 审批（含拒绝）/ G6 Artifact / Reviewer / 两浏览器 diff / R1·R4·R5·R7·R8·R9 恢复 / G7 取消·重跑。首轮红：按 UUID 匹配 Pack 菜单项（见第 4 条） |
| 3 | `p1-140` | ✅ | 1 passed | 20.2s | 同组成员零操作实时可见 |
| 4 | `p1-141` | ✅ | 1 passed | 26.5s | 邀请链：**`#invite-role` 的真人路径**（点开 → 点选项）+ 与徽标同一套措辞 |
| 5 | `p1-142` | ✅ | 2 passed | 28.5s | 设备配对 UI；第二条是 390×844 无横向溢出 + 折叠菜单键盘可达 |
| 6 | `p1-158`（本次新增） | ✅ | 1 passed | 24.3s | 7 落页点 × 两档截图 + **390 档菜单定位当场判** + S3 真实浏览器回焦 + 对比度扫描 |

合计：`p1-07` 1 + `p1-19` 13 + `p1-140` 1 + `p1-141` 1 + `p1-142` 2 + `p1-158` 1
= **19 条用例通过，0 失败**；总耗时约 **5 分钟**（各 project 冷启 20–30s，`p1-19` 因含恢复场景最长）。

**两档截图**：`artifacts/evidence/select-menu/<viewport>/<落页点>.png`，实测 **16 张**
（8 个控件位 × 2 档；RunLauncher 的 Revision 在 Agent 未选时不可用，故 7 个落页点展开成
8 个控件位：`invite-role` / `task-assignee` / `agent-plugin-pack` / `revision-plugin-pack` /
`run-agent` / `run-revision` / `run-device` / `run-workspace`）。
尺寸实测：桌面 1280×720、移动 390×844（`file` 复核）。

**自审结论（看图看到的，不是判据）**：
- 触发器在四个界面里与既有控件同族：白底、0.5px 细描边、8px 圆角、右侧 chevron、文案过长时省略号；
- 390 档下菜单贴着触发器左缘展开、右侧留白充足，**没有横向滚动条**（这两条另有独立几何断言）；
- 菜单里选中项带尾随 check，禁用 placeholder 无 check 且是灰字。

**残留物检查（评审要求）**：`docker ps -a` 过滤 `whalepod.e2e-postgres` 与
`project311.e2e-postgres` 两个标签**都是空**——本轮 6 次冷启（含 3 次失败轮）的一次性 PG 全部
被 `e2e-serve` 回收，无孤儿容器；5173/18080 跑完均释放。现存的 `whalepod-shots-db-1` /
`whalepod-demo-db-1`（healthy，3–4 小时）是**常驻 demo/截图库**，不属 e2e 一次性栈。

## 迁移注意（本轮实测踩到的坑，给后续迁移切片）

1. **菜单首项可能是禁用 placeholder，`menuitem.first()` 往往不是"首项"**。
   `SelectMenu` 把 placeholder 渲染成 `disabled` 的菜单项且排在 index 0；vendored `Menu` 的
   `autoFocus` 聚焦的是**第一个可用项**（`button:not(:disabled)`）＝ index 1。
   实测（p1-07 首轮）：按 `first()` 断言焦点，拿到的是禁用项，报 `Received: inactive`。
   正确写法：`items.first()).toBeDisabled()` + `nth(1)` 聚焦 + 方向键到 `nth(2)`。
2. **别给禁用触发器加 `opacity`——它会踩 #159 的对比度门，而且这是真问题不是门过严**。
   实测：`.select-menu-trigger:disabled { opacity: 0.55 }` 让占位文字
   （`#run-revision-value`「先选 Agent…」/ `#run-workspace-value`「先选设备…」）
   从 18.9:1 掉到 **4.17:1**（门沿祖先链累乘有效不透明度后合成再算），判 AA 不达标。
   禁用语义由 `disabled` 属性 + `cursor: not-allowed` + 点击无效承担即可；要视觉变淡请用
   **前景色**（`color-mix` 合成成不透明色），不要用 opacity。
3. **这条门在迁移前扫不到这些文字**：原生 `<select>` 的文字由系统渲染、没有 TEXT_NODE 子节点，
   #159 的扫描器只能跳过它（该盲区在 `contrast-sweep.ts` 文件头有登记）。**迁移成 DSH Menu
   之后触发器变成普通按钮，门第一次能扫到**——上面那条 4.17:1 就是它抓到的第一个真问题。
   换句话说：#158 的可测性收益不只是"七个下拉长得一样"，还包括**让一整类问题进入门的射程**。
4. **选 Pack 要按名字点，不能按 UUID**：菜单项文案是 `pack.name`（原生 `<option>` 时代也一样），
   而 `assertNotNativeSelect` 之外最容易写错的就是"拿 `pluginPackId.slice(0,8)` 去匹配菜单项"。
   实测（p1-19 首轮）：控制面种子包叫 `e2e-pack`（`scripts/e2e-serve.mts` 的
   `/control/plugin-pack/seed`），按 UUID 匹配永远找不到。
5. **审计/用例的时序要先想清楚"这个人在不在名册里"**：本审计首轮把"建任务并指派"写在
   "邀 Bob 入队"**之前**，于是责任人下拉里只有 Alice——`selectFromMenu(assignee, /Bob/)`
   必然找不到项（错误快照里 `menuitem` 只有 Alice 一条）。第二轮又踩到 **Agent 只能由
   Owner/Admin 建**（Bob 是 member，`/agents` 对他只渲染只读说明，`#agent-plugin-pack` 根本
   不在页面上）。两条都是**用例自身的时序错**，不是产品缺陷；写跨界面用例时先把
   "谁能看到这个控件"排一遍。
6. **两条浏览器事实（被证伪过，别再想当然）**：
   - `getComputedStyle(el).getPropertyValue('--dsw-…')` 拿到的是**解析值**不是声明原文
     （自定义属性在 computed-value 阶段就完成 `var()` 代换），所以浏览器侧**判不了**
     "用了哪个 token"——那条只能由源码文本判据钉；实测 DPR=1/2 都读到 `rgb(255,255,255)`。
   - Chrome 把 `border: 0.5px` 的 computed `border-top-width` 算成 **1px**（两个 DPR 都是），
     所以浏览器侧不比描边宽度；0.5px 这个**声明**由 CSS 文本判据钉。

## 边界与未覆盖

- 与 vendored `Input` 的**逐像素比对**没做（只判了背景/描边/圆角三条 computed style 与对比度）。
- `Menu` 的 `portal` **未接线**：`.list` 的 `min-width: 218px` 在极窄宿主里会横向溢出触发器。
  本审计判的是"不越出视口 + 页面无横向滚动"，**不判**"列表宽度等于触发器宽度"（218px 是上游设计宽度）。
- 深色一套（`body[data-ds-dark-theme]`）无入口可切，未验。
- 无障碍工具实测（axe 之类）没做；`aria-selected`/`aria-checked` 缺失、`role=menu` 用在选择器上的
  语义缺口登记在 `docs/agent/dsh-ui-vendoring-batch2.md` §6.1（G-1/G-2/G-3）。
- `--dsw-alias-border-l4` 叠白底 **1.45:1**（低于 WCAG 1.4.11 对"纯靠描边识别控件"的 3:1）：
  保持与 vendored `Input` 同值是有意的（识别靠面/chevron/hover），属已知边界。

## 复跑

```bash
# 干净环境复跑（每条命令自带一次性 PG + 真 Hub + vite 冷启）
git checkout feat/p1-158-select-menu
pnpm check                                                    # Q0（含 19 条 select-menu 源码判据）
pnpm exec playwright test --project=p1-07                     # → p1-19 → p1-140 → p1-141 → p1-142 → p1-158
# 每个 project 之间确认 5173 已释放：lsof -nP -iTCP:5173 -sTCP:LISTEN
# 跑完确认无孤儿容器：docker ps -a --filter label=whalepod.e2e-postgres=true
```
