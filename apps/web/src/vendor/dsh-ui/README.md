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
  差异。需要偏离上游时，在文件顶部注释里写清「本仓改动 + 为什么」。
- 本仓只允许两类改动：①工程口径（`clsx` → `./cx.js`、import 后缀 `.js`、oxfmt 格式）；
  ②**不得新增**任何运行时依赖，也不得出现 `@deepseek-ai/*` 或 `@whalepod/*` 说明符。
- 新增文件（哪怕只多取一个图标）必须登记进 `manifest.json`。
- 样式只吃 `--dsw-*` 变量（L1 白名单在 `apps/web/src/styles/dsw-tokens.css`），
  不要在 vendored CSS 里写死颜色或引用本仓 `--color-*` token。
