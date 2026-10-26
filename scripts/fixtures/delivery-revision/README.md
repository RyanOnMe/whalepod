# 交付审阅的确定性模型出口

session.jsonl 通过真实 publish_artifact 分别发布新版 Markdown 与 sample.docx。新版正文和最小 Office 样本是本地前置文件，不代表模型实际编写质量。fromRequest 要求最终回复消费选定批注与方向；没有进入模型请求就不能产生匹配输出。

sample.docx 是标准 ZIP OOXML 最小包：包含 [Content_Types].xml、_rels/.rels、word/document.xml，后者源码在 source-document.xml，正文只有 WhalePod Office preview sample。ZIP 时间固定为 2026-10-26。无用户资料、宏、外链或图片。

`pnpm test:e2e:delivery` 明确启用 Office 安全回退验证：不启动未隔离转换进程，不提供新旧预览字节，保留原件发布、下载及批注。缺拒绝证据必须失败。正向转换已因外链越界读取风险撤回，未来需经可验证隔离后单独开放。
