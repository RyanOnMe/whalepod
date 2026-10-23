# Office 只读 PDF 预览（#431 后端 / ADR-0021 §2）验收记录

- 对应场景/门禁：交付物格式能力（DOCX/XLSX/PPTX 只读 PDF 预览）+ Q0/Q1/Q2
- 对应 Issue：P1-431（后端切片）
- 上次验证：2026-10-24 · feat/p1-431-office-preview · PASS

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
```

真实转换烟测在本机执行（soffice 26.8）：测试先用 soffice 现造 DOCX（HTML）、
XLSX（CSV）与 PPTX（最小 FODP）三份真实样本，再逐一调用 `convertOfficeToPdf`，
断言输出以 `%PDF-` 开头。部署侧可用
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
- 以上任一断言缺数据或形状不符即 FAIL（Zod strict + 集成断言）。

## 归因（失败先看哪层）

- 转换失败：`apps/node/src/artifact/preview.ts`（soffice 参数、独立 profile、超时、
  PDF 输出扫描）；稳定原因码 `CONVERTER_UNAVAILABLE` / `CONVERT_TIMEOUT` /
  `CONVERT_FAILED` / `PREVIEW_TOO_LARGE`。
- 上传/绑定失败：`preview-upload-client.ts`（路径、Idempotency-Key、重试）与
  `apps/hub/src/modules/artifact/preview.ts`（设备归属、source sha、ready 不降级）。
- 权限不符：`getArtifactPreviewInfo` / `readArtifactPreview` 复用
  `read_artifact_content` 判据；候选折叠为 404。
- 页面不显示：先查 `preview-info` 三态与 `artifact.changed` 的 `change='preview'`，
  再查前端接线（前端批次）。

## 取证

```bash
git diff --stat feat/p1-431-office-preview
# 上方两条命令复跑；03 §2.6/§4 与 ADR-0021 已同步
```

## 边界与未覆盖

- **区域锚点未做**：PDF 页码/归一化矩形、图片区域与 `kind='region'` 的协议扩展仍
  待前端 Agent 合并后另开批次；当前审阅页只有整件/文本批注。
- XLSX/PPTX 的真实样本由测试内现造（CSV/FODP），不落仓库二进制 fixture；
  转换质量（字体、分页、多页）仍只做了「产出可读 PDF」判定。
- 不做历史回填：本切片之前已发布的 Office Artifact 没有预览，读面显示 `none` 并
  回退下载；重新产出新版本才会生成。
- 转换是 Node 后台任务：Run 结束/进程退出时未完成的预览可能丢失（预览缺失不影响
  交付）；没有重试队列或管理端重建入口。
- 未跑生产装配 Q5（前端审阅页与真实 Node 闭环由前端批次接线后统一跑）；
  未做高并发转换/上传压测。
- LibreOffice 不是仓库依赖：部署机未安装/未配置 `WHALEPOD_SOFFICE` 时只登记失败，
  不阻断交付；转换质量（字体、分页）由实际样本决定。
- 集成用例的 Artifact 行仍走真实 Device Token 上传；没有直插业务表。

## 复跑

从干净数据库执行上方命令；Node 单测不需要 Docker，Hub 集成由
`with-test-postgres.mts` 自起临时 PostgreSQL。真实 soffice 烟测在无二进制的机器上
自动跳过，不把「没装转换器」误判成通过。
