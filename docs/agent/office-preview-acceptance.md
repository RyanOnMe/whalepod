# Office 只读 PDF 预览（#441 / ADR-0021 §2）验收记录

- 对应场景/门禁：交付物格式能力（DOCX/XLSX/PPTX 只读 PDF 预览）+ 定向 Q0/Q1/Q2
- 对应 Issue：P1-441（既有后端 + 前端阅读接线）；P1-431 保留跟踪 PDF/图片区域能力
- 上次验证：2026-10-26 · feat/p1-441-office-preview-ui · 定向检查 PASS；Q5 组合闭环未跑

## 验的是哪条用户路径

Agent 产出 `.docx/.xlsx/.pptx` → Node 采集原件并上传候选 → Node 用 LibreOffice
无头模式转 PDF → Hub 以 `sourceSha256` 把派生件绑定到不可变原件 → 拥有者检查候选
时可读 PDF → 发布后团队成员可读同一 PDF；转换失败时读面明确显示失败原因并回退
下载原件。预览不是新版本：原件字节、摘要、发布状态都不变。

## 驱动（怎么触发）

```bash
# Node：格式判定、生成器、上传客户端、真实 soffice 烟测（无 soffice 时自动跳过）
pnpm exec vitest run --project unit \
  apps/node/tests/artifact-preview.spec.ts \
  apps/node/tests/artifact-preview-upload-client.spec.ts \
  apps/node/tests/artifact-collect.spec.ts

# Hub：真实 PostgreSQL + Device Token / Session HTTP
pnpm exec tsx scripts/with-test-postgres.mts vitest run --project integration \
  apps/hub/tests/artifact-preview.integration.spec.ts

# Web：真实组件与路由，只替换 HTTP；包含既有文本/交付审阅回归
pnpm exec vitest run --project web \
  apps/web/tests/office-preview.spec.tsx \
  apps/web/tests/office-preview-entry.spec.tsx \
  apps/web/tests/artifact-review.spec.tsx \
  apps/web/tests/delivery-review.spec.tsx
pnpm --filter @whalepod/web typecheck
pnpm --filter @whalepod/web build
```

真实转换烟测在本机执行（soffice 26.8）：测试先用 soffice 现造 DOCX（HTML）、
XLSX（CSV）与 PPTX（最小 FODP）三份真实样本，再逐一调用 `convertOfficeToPdf`，
断言输出非空且以 `%PDF-` 开头；没有检查渲染后的版面或文字。部署侧可用
`WHALEPOD_SOFFICE` 指向具体二进制；缺失时报 `CONVERTER_UNAVAILABLE`。

## 观测（看什么）

- `artifact_preview`：`source_sha256 == artifact.sha256`；ready 行带
  `storage_key/sha256/byte_size/media_type='application/pdf'`，failed 行全为 NULL 且
  `failure_reason` 非空。
- `GET /artifacts/:artifactId/preview-info`：`none`（从未转换）/ `ready` / `failed`
  三态 + 失败原因；候选对非拥有者与不存在同 404 `NOT_FOUND`。
- `GET /artifacts/:artifactId/preview`：200 时 `content-type: application/pdf`、
  `content-disposition: inline`、`cache-control: private, no-store`、
  `x-content-type-options: nosniff`、`content-security-policy: sandbox`；失败/缺失
  404 `PREVIEW_UNAVAILABLE`。
- Hub 事件：仅已发布版本的预览变化发 `artifact.changed`（`change='preview'`，
  `previewStatus`），候选上传/失败不发团队事件。
- 原件不变：下载 `/content` 仍返回原始 Office 字节与同一 sha256；转换失败不改变
  Artifact 状态。
- Web：候选拥有者在文件卡检查预览，团队在已发布文件卡/独立审阅页读取；三种 Office
  类型共用 `OfficePreview`。`none` 明确说明尚无预览（历史不回填），已知失败原因翻译为
  中文，未知原因不原文显示；始终保留受控原件下载入口。
- `ready` 点击「查看 Office 预览」后才携带 Session Cookie 读取 PDF；HTTP 失败、非 PDF
  响应或版本摘要不匹配不嵌入内容。成功后使用仅本页持有的 blob URL，离开/版本变化时
  撤销；浏览器不支持内嵌 PDF 时可下载原件。尚无预览的可见页最多轮询约一分钟，也能
  手动刷新；发布后复用 `artifact.changed` 的审阅缓存失效前缀。
- Node 临时目录：`artifact-previews/preview-*` 与 soffice profile 转换结束即清理；
  失败日志只带 runId/artifactId/稳定原因码，不带绝对路径。

## 判定（成功长什么样）

- 只有 DOCX/XLSX/PPTX（OpenXML 三件套）触发转换；其他媒体类型不产生派生件。
- 上传 PDF 的 hash 由 Hub 复算：声明不符 400 `ARTIFACT_HASH_MISMATCH`，无预览行、
  无临时文件残留。
- `sourceSha256` 与原件不符 → 409 `CONFLICT`；非产出设备/未知原件 → 404。
- 候选预览仅拥有者可读；发布后同一 URL 对团队成员可读——权限继承原件，预览不
  授予新权限。
- 转换失败登记 `failed` 与稳定原因码，`/preview` 返回 `PREVIEW_UNAVAILABLE`，原件
  仍可下载；后续重转换成功可覆盖 failed。
- 已 ready 的预览不会被迟到的失败上报降级；同一派生件重试/并发上传不产生第二行，
  并发时首个 ready 稳定、只发一条预览事件；同一 Idempotency-Key 重放返回首次视图。
- Node 侧转换/上传失败不抛到 Run：候选采集照常成功；同一 artifact 并发 generate
  只转换一次；上传网络故障只告警，不伪装成「转换失败」。
- 前端独立组件覆盖 none → 手动刷新 ready、缺组件/未知失败、受控按需加载与 URL
  回收、403/错误内容类型回退、摘要不符、超限、元数据拒绝、非 Office 零额外请求。
  入口覆盖拥有者候选、他人候选零查询、三格式审阅页仍可整件批注；文本阅读保持原路径。
- 以上任一断言缺数据或形状不符即 FAIL（Zod strict + 集成断言）。

## 归因（失败先看哪层）

- 转换失败：`apps/node/src/artifact/preview.ts`（soffice 参数、独立 profile、超时、
  PDF 输出扫描）；稳定原因码 `CONVERTER_UNAVAILABLE` / `CONVERT_TIMEOUT` /
  `CONVERT_FAILED` / `PREVIEW_TOO_LARGE`。
- 上传/绑定失败：`preview-upload-client.ts`（路径、Idempotency-Key、重试）与
  `apps/hub/src/modules/artifact/preview.ts`（设备归属、source sha、ready 不降级）。
- 权限不符：`getArtifactPreviewInfo` / `readArtifactPreview` 复用
  `read_artifact_content` 判据；候选折叠为 404。
- 页面不显示：先查 `preview-info` 三态、sourceSha256 与原件版本，再查
  `OfficePreview` 元数据查询/按需 PDF 读取与 `artifact.changed` 审阅前缀失效。

## 取证

```bash
git log --oneline feat/p1-441-office-preview-ui
# 上方命令复跑；先红测试提交 ea8a157，后端 619388a..d03c56d 保留
```

## 边界与未覆盖

- **区域锚点未做**：PDF 页码/归一化矩形、图片区域与 `kind='region'` 的协议扩展仍
  待前端 Agent 合并后另开批次；当前审阅页只有整件/文本批注。
- 三种真实 Office 样本由测试内现造（HTML/CSV/FODP），不落仓库二进制 fixture；
  当前仅判定 PDF 签名与非空，未验证字体、分页、多页或复杂表格/幻灯片布局。
- 不做历史回填：本切片之前已发布的 Office Artifact 没有预览，读面显示 `none` 并
  回退下载；重新产出新版本才会生成。
- 转换是 Node 后台任务：Run 结束/进程退出时未完成的预览可能丢失（预览缺失不影响
  交付）；没有重试队列或管理端重建入口。
- 前端接线已由组件/真实路由测试覆盖；未跑真浏览器 + 真 Node 的生产装配 Q5；
  未做高并发转换/上传压测。
- LibreOffice 不是仓库依赖：部署机未安装/未配置 `WHALEPOD_SOFFICE` 时只登记失败，
  不阻断交付；转换质量（字体、分页）由实际样本决定。
- 集成用例的 Artifact 行仍走真实 Device Token 上传；没有直插业务表。

## 复跑

从干净数据库执行上方命令；Node 单测不需要 Docker，Hub 集成由
`with-test-postgres.mts` 自起临时 PostgreSQL。真实 soffice 烟测在无二进制的机器上
自动跳过，不把「没装转换器」误判成通过。
