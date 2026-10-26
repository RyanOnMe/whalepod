# ADR-0023：Office 派生预览在可验证隔离建立前暂停

- 状态：已采纳，安全评审阻塞修复（P1-441，2026-10-26）
- 承接：ADR-0021 的只读预览；不新增任务状态或修改原件权限

## 依据

独立评审以合成 DOCX 和测试目录内的 PNG 复现：OpenXML 外部 image relationship 可让真实 LibreOffice 从转换 staging 之外读取图像，并嵌入生成 PDF；不存在的目标不产生该图像。独立 UserInstallation 只隔离配置，不能限制宿主文件读取或网络。LibreOffice 还会识别扩展名不符的实际文档容器，因此仅检查 MIME、文件名、ZIP 关系或 XML 文本不能成为权限边界。

## 决定

当前默认生成器和低层转换入口在进程启动、读取源文件或创建转换 staging 前返回 `ISOLATION_REQUIRED`，不启动 LibreOffice，也不上传 PDF。生产 CLI 不注入测试转换器；安装或指定 `WHALEPOD_SOFFICE` 不会重新开放转换。

原件下载和整件批注继续工作。新的预览 PDF 上传在设备/原件归属与摘要检查后返回 409 `PREVIEW_UNAVAILABLE`，在 blob 写入和旧成功回执重放之前拒绝。失败报告仍只保存稳定、脱敏诊断。

既有预览没有可核验的隔离来源，可能已含 staging 外资料；因此拥有者和团队都暂停读取这条 PDF 通道。`preview-info` 在原件权限检查后统一返回 `failed`、当前原件摘要、`converter='unknown'`、`failureReason='ISOLATION_REQUIRED'`，内容类型、字节数、更新时间均为 NULL。`GET /preview` 返回 404 `PREVIEW_UNAVAILABLE`，不读取 blob。私有原件对他者仍返回 404 `NOT_FOUND`。

历史行、blob 和 command receipt 保留，不删除或改写旧 ready 记录。旧失败回执也不能将 ready 元数据重放到响应中。Web 明确说明隔离转换尚未开放，并保留下载原件及同页整件批注；不继续声称本轮可以自动在线转 PDF。

## 重新开放的条件

必须通过可复跑证据证明转换进程只能读本次 staging、不能读取成员其他文件、不能请求网络，并具备时间、内存、输出和解压上限。测试包含本地外链、HTTP 外链、伪装容器和畸形压缩输入。未知容器或未知隔离能力一律拒绝。未来的产物需绑定原件摘要、转换器及隔离策略版本，只有可核验来源的新预览可读；不能直接把这次暂停的全部历史 PDF 重新开放。

本决定没有声称已实现转换沙箱。前端兼容 ready 形状与纯函数的显式测试转换器，不构成生产能力或配置开关。

## 验证

默认 Node 和低层入口的外部资源/可执行程序负控、Hub 历史行/历史回执读取拒绝、真实 HTTP 的私有权限和原件下载、Web 清晰回退。详见 `docs/agent/office-preview-acceptance.md`。新增 `ISOLATION_REQUIRED` 是稳定诊断码，未知错误原文仍归一化；无新增 migration。
