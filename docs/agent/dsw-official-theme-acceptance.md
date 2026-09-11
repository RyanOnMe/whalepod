# DSH Web 官方形态迁移（#173）验收

- 对应场景/门禁：Q0（web/unit 两 project 的 token/控件族/主题门）+ Q5（六 project 全量，含 AA 扫描与窄屏导航）
- 对应 Issue：#173
- 上次验证：2026-09-11 · 本分支 HEAD · 结果 PASS（Q0：87 文件 / 1119 用例；Q5：6 project / 20 用例 0 失败）

## 验的是哪条用户路径

用户打开 WhalePod 的每一页：登录/初始化页（灰平台上的白色对话卡）、登录后宽屏（左侧栏 +
白色应用卡浮在灰平台上）、窄屏（顶栏 + 折叠菜单）。目标观感 = 真实 DSH Web GUI
（用户提供的 127.0.0.1:3080 截图）：浅色 chrome、胶囊按钮、发丝描边、白底卡片。

## 与 #138–#172 的关系

此前的 UI 批次把**控件度量**对齐到 DSH 族（#168/#171），但整体形态仍是「深色顶栏通用后台」，
token 层是手工近似的 dsw 子集。#173 把**形态**换掉：

1. **壳**：深色顶栏 → 浅色侧栏（宽屏 ≥1024px）/ 白色窄顶栏 + 折叠菜单（窄屏）。侧栏度量
   （面板 padding、导航项 h40/r12/hover/active 两档填充、品牌行 h60/18px 600）取自上游
   `dsh-client-ui-sidebar` 与 `dsh-client-ui-settings-general` 的 navCell，逐值照抄。
   断点 1024 = 上游 `dsh-client-ui-layout` 的 `SIDEBAR_AUTO_COLLAPSE`。
2. **应用卡**：桌面档灰平台（`--dsw-alias-bg-module-platform`）+ 白卡（r20 +
   `--dsw-elevation-soft`），窄屏全幅直角。
3. **按钮**：从 8px 方角改为 vendored `Button.module.css` 的**胶囊族**（r18，描边取
   `.outline` 变体的 0.5px l3；primary = `.primary` 黑底白字；quiet = `.ghost` 无边透明）。
4. **token 层**：L1 白名单扩 13 个声明（侧栏 specific 族、elevated/floating 按钮面、
   字体栈、elevation-soft），取值逐字来自上游 design-platform.css / gradient-shadow-text.css
   （见 `dsw-tokens.css` 文件头与台账 §3.1 的 #173 条）。
5. **代码块/配对码**：黑块反白 → 浅底代码片（sunken 面 + 发丝描边 + r12，对齐上游
   `--dsl-code-block` 一族）。
6. **导航当前页**：`Link` → `NavLink`，`aria-current="page"` 第一次真实生效
   （此前 CSS 里那条 `[aria-current]` 选择器从未命中过任何东西）。

## 驱动（怎么触发）

```bash
pnpm check                 # Q0：token/控件族/主题/焦点环/文案判据（源码层）
pnpm test:e2e              # Q5：真实浏览器六 project（含 1280 与 390 两档 AA 扫描）
```

观感复核（生产形态镜像）：

```bash
docker compose -p whalepod-shots --env-file ~/.whalepod-shots/.env -f deploy/compose.yml build web
docker compose -p whalepod-shots --env-file ~/.whalepod-shots/.env -f deploy/compose.yml up -d web
npx tsx .dsh/shots4.mts <user>   # 截图到 ~/.whalepod-work/shots6（脚本 gitignored）
```

## 观测与判定

- **Q0 机器判据**（全部在源码文本层，改坏任一处必红）：
  - `control-family.spec.tsx`：按钮族度量现场读 vendored `Button.module.css`（新增
    `parseVendorButtonMetrics`，与 Input 族分轴）；期望表逐条钉 token；22 条变异验证
    （含「quiet 的 transparent 被偷换成有色描边」「顶栏形状规则塞 color」两条新变异）。
  - `theme-contrast.spec.ts`：深色顶栏两对配对退役，换成侧栏真实配对
    （侧栏文字 18.08:1、选中导航 16.24:1；输出表逐行打印）。
  - `vendor-dsh-ui.spec.tsx`：孤儿门禁动态计数（新增 13 个声明全部有消费者）。
  - `layout-container.spec.tsx`：宽屏壳只有一份主导航、折叠菜单不渲染（互斥渲染，不是藏）。
- **Q5 实测**：`pairing-ui` 的 390 档：顶栏 ≤64px（现为 `.app-topbar`）、折叠菜单键盘可达、
  换页自动收起、主按钮中心点命中 BUTTON；五页 AA 扫描（两档视口）零违规。
  `task-room` / `pairing-ui` 的 `assertControlTokens` 按钮族参照（`family: 'button'`）。
- **截图自审**：`shots6/` 13 张（桌面 1440 五页 + 登录 + Task Room，移动 390 五张），
  逐张对照用户提供的 DSH Web 参考图：灰平台/白卡/侧栏胶囊/黑胶囊主按钮/浅底代码片一致。

## 归因（失败先看哪层）

- 侧栏/顶栏不出现或双份出现 → `session.tsx` 的 `useWideLayout`（jsdom 无 matchMedia 时
  回落宽屏档）；Q5 窄屏用例覆盖 390 真实分支。
- 控件度量红 → `control-family.spec.tsx` 失败信息指到规则；先对
  `vendor/dsh-ui/Button.module.css`（按钮）与 `Input.module.css`（输入）的当前度量。
- 对比度红 → Q5 `contrast-sweep` 输出给元素路径与合成色值；先查该元素所在容器是不是
  新加的非白底（侧栏 fill / sunken 面都在扫描算法里会被正确合成）。

## 取证

- 截图：`~/.whalepod-work/shots6/`（本机，gitignored；复跑命令见上）。
- Q5 输出：`/tmp/q5.log` 末段（六段 passed）。

## 边界与未覆盖

- **深色主题**：token 层（含本批 5 个深色重写）随上游备好但仍无切换入口，深色 chrome
  未在真实界面渲染验证（与 #173 之前状态相同，没有回退）。
- **Firefox/Safari**：侧栏互斥渲染用 matchMedia（标准 API），但只在 Chromium 实测。
- **jsdom 窄屏**：单测里 `useWideLayout` 恒为宽屏档；窄屏折叠菜单由 Q5 的 390 用例覆盖，
  单测层没有窄屏用例（matchMedia stub 的价值低，刻意不加）。
- 成员页/Task Room 的**列表项分隔线**仍是 `1px solid var(--color-line)` 细线（内容分隔，
  非控件族），与卡片的 0.5px 发丝不是同一档——视觉上可接受，未强制统一。

## 复跑

```bash
git checkout <本 PR 合并后的 main>
pnpm check && pnpm test:e2e
```
