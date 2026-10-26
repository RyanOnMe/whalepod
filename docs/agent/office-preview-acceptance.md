# Office 预览安全回退（P1-441；ADR-0023）验收

当前能力：Office 原件照常交付、下载与整件批注；自动转换及所有未经可核验隔离生成的派生 PDF 读取暂停。拥有者和团队同样受暂停策略约束，历史数据保留。

## 用户路径

Agent 发布 DOCX/XLSX/PPTX 原件 → Node 默认只报告 `ISOLATION_REQUIRED` → 拥有者检查或发布后其他成员看到“Office 隔离转换尚未开放，请下载原件查看并批注” → 原件下载和审阅页整件批注继续工作。

早期只验证 PDF 签名/字节的三格式转换与阅读检查没有覆盖外部资源边界，不能作为当前版本可安全在线转 PDF 的证据。独立审查用受控外链图像实测发现宿主文件读取，因此按 ADR-0023 收窄范围；不是增加一个未经验证的 ZIP/XML 净化器来替代权限隔离。

## 驱动

```bash
pnpm exec vitest run --project unit \
  apps/node/tests/artifact-preview-isolation.spec.ts \
  apps/node/tests/artifact-preview.spec.ts \
  apps/node/tests/artifact-preview-upload-client.spec.ts \
  apps/node/tests/artifact-collect.spec.ts \
  packages/protocol/tests/artifact-preview.spec.ts \
  apps/hub/tests/artifact-preview-projection.spec.ts

pnpm exec tsx scripts/with-test-postgres.mts vitest run --project integration \
  apps/hub/tests/artifact-preview.integration.spec.ts

pnpm exec vitest run --project web \
  apps/web/tests/office-preview.spec.tsx \
  apps/web/tests/office-preview-entry.spec.tsx \
  apps/web/tests/artifact-review.spec.tsx \
  apps/web/tests/delivery-review.spec.tsx
```

Node 负控使用自建最小 DOCX、测试目录内 PNG、本地 HTTP 图片监听器和只写测试标记的可执行程序；不读取真实用户资料，不把绝对路径、端口、原始进程 stderr 归档。未知字节、HTML/flat XML 假装成 Office，同样在转换器启动前失败。安装 LibreOffice 或传入转换器路径不会绕过拒绝；默认生产路径不依赖机器是否安装工具，因此无需因缺少 soffice 跳过安全检查。

## 观测与判定

- 默认 Node 无 PDF 上传；失败原因 `ISOLATION_REQUIRED`；不创建转换 staging 或启动可执行程序。低层 `convertOfficeToPdf` 也直接拒绝，不能被生产误用。
- `GET preview-info` 在原件权限检查后返回 `{status:'failed',sourceSha256:原件摘要,converter:'unknown',mediaType:null,byteSize:null,failureReason:'ISOLATION_REQUIRED',updatedAt:null}`；不读取旧 preview 行作公开投影。
- `GET preview` 对可读原件者返回 404 `PREVIEW_UNAVAILABLE`，既不返回旧 PDF，也不调用 blob 读取。非拥有者访问私有原件的三条读取仍是 404 `NOT_FOUND`。
- 产出设备的 `PUT preview` 返回 409 `PREVIEW_UNAVAILABLE`，无 blob 或 preview 行；旧成功回执同样不可重放。未知设备、摘要不符、超限元数据仍先走既有守卫。
- 失败上报只存稳定码和受控转换器名；同 key 不改写首次诊断；返回结果一律重新构建安全回退，历史 receipt 的 ready 字段或原文不会再下发。
- 历史 ready 行保持原状，不被新的失败上报降级；原件状态和摘要不变。旧行/旧回执只在 repository seam 模拟，不为历史预览测试往真实运行时业务表注入状态。
- 已发布原件的真实 HTTP 下载内容、摘要保持一致；Web 仍可按原件做整件批注，失败状态不请求 PDF，不展示 ready 按钮或 iframe。
- 任一隐私、请求、标记文件、存储副作用或原件可用性断言不符即失败；未安装转换器不能把此安全检查判为通过旧正向烟测。

## 归因与证据

- 默认转换/意外进程启动：`node.artifact` → `apps/node/src/artifact/preview.ts` 的默认拒绝与 CLI 装配。
- 历史 PDF 可读或上传仍落盘：`hub.artifact` → `modules/artifact/preview.ts` 的原件授权、暂停判定及回执处理。
- 隔离原因被误显示为未知/缺组件：`web.office-preview` 与稳定协议枚举。
- 初始回归提交 `9a5af53`（9 failed / 9 passed）；修复后结果归档 `artifacts/evidence/office-preview-isolation/summary.json`。
- 修复后 Node 24：Unit 6 文件/41 例、Web 4 文件/37 例、真实 Q2 1 文件/9 例通过；构建、全仓类型检查、定向 lint/格式/边界/生成协议/敏感扫描通过。
- 此切片按 Node 24 运行定向检查；真实生产装配 Q5 的安全回退由 P1-442 在最终整合树登记，不能复用早期开放预览的 PASS。

## 保留边界

没有声称已有可靠转换沙箱、复杂排版保真、浏览器三格式在线转换或历史预览回填。未来重新开放必须按 ADR-0023 补隔离权限、资源上限、恶意容器和新预览来源验证。现有组件的 ready 分支与显式注入的测试 converter 只验证兼容逻辑，不是本版生产开关。
