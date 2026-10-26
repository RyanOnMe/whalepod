# 交付审阅的确定性模型出口

session.jsonl 通过真实 publish_artifact 分别发布新版 Markdown 与 sample.docx。新版正文和最小 Office 样本是本地前置文件，不代表模型实际编写质量。fromRequest 要求最终回复消费选定批注与方向；没有进入模型请求就不能产生匹配输出。

sample.docx 是标准 ZIP OOXML 最小包：包含 [Content_Types].xml、_rels/.rels、word/document.xml，后者源码在 source-document.xml，正文只有 WhalePod Office preview sample。ZIP 时间固定为 2026-10-26。无用户资料、宏、外链或图片。

默认交接 Q5 不要求可选的 LibreOffice；`pnpm test:e2e:delivery` 明确启用 Office 组合验证，缺转换工具或缺证据必须失败。三格式转换由 Node 现造样本检查；本浏览器路径只覆盖 DOCX 的真实转换和阅读入口，不判断复杂排版保真。
