# vendor/dsh-ui —— DSH client UI 的 vendored 副本（#138）

**这是一份复制品，不是依赖。** 代码来自上游 `github.com/deepseek-ai/deepseek-harness`
（MIT）的 `packages/client/ui-primitives` 与 `packages/client/ui-theme`，按 #138 的分层
裁决取用：L1 主题 token → L2 原语组件 → L3 运行视图；**DSH 应用壳与 RPC 永久不取**
（裁决记录在 ADR-0008）。

- 逐文件来源（上游路径 → 本仓路径 → 本仓改动）见同目录 `manifest.json`；取用时的
  上游 commit SHA 与取用命令也在那里。
- 上游版权与许可全文见同目录 `LICENSE`（MIT, Copyright (c) 2026 DeepSeek）。
- 每个 vendored 文件顶部都带一行出处注释：上游路径 + commit SHA + 本仓改动。
- **本目录不含任何 DSH 品牌资产**：上游 `ui-primitives` 的 `FishLogo.tsx` 与
  `BrandWordmark.tsx`（官方品牌图形，且上游从 `index.ts` 公开导出）**未取用**；L3 若要
  引品牌图形，必须逐资产单独过许可与商标口径，不要顺手从上游拖进来。
- 本目录里的 `cx.ts` 是**本仓新增代码**（Apache-2.0，见仓库根 LICENSE），不是上游 MIT
  代码；同步上游时不要把它当上游文件覆盖。
- 本目录整体被 `oxfmt` 忽略（见根 `.oxfmtrc.json`）：vendored 副本要保持与上游逐字节
  可比，不按本仓格式化口径重排。

## 怎么改

- **别顺手改 vendored 文件**：视觉/行为应与上游保持一致，否则下次同步上游时无法比对
  差异。需要偏离上游时，在文件顶部注释里写清「本仓改动 + 为什么」——出处注释按
  **①工程口径**（`clsx` → `./cx.js`、import 后缀 `.js`）与**②功能性改动**（如 `Tag.tsx`/
  `StateDot.tsx` 为可测性新增的 `data-vendored` / 可覆写 `data-testid`）分类写明，同步
  上游时②必须保留，别把它当格式差异抹掉。
- 运行时依赖：**不得新增**任何第三方依赖，也不得出现 `@deepseek-ai/*` 或
  `@whalepod/*` 说明符。
- 新增文件（哪怕只多取一个图标）必须登记进 `manifest.json`。
- 样式变量只吃 `--dsw-*`（L1 白名单在 `apps/web/src/styles/dsw-tokens.css`）——唯一的
  **已知例外**是 `DisclosureRow.module.css` 引用的两个上游 body 发布变量
  `--dsh-content-font-size-secondary` 与 `--dsh-content-font-delta`（每处引用都带
  fallback：13px / 0px，L1 不提供也能正确降级）；`StateDot.module.css` 另有一个文件内
  自定义、自给自用的局部变量 `--dsh-state-ongoing`。除此之外不要在 vendored CSS 里写死
  颜色或引用本仓 `--color-*` token。
