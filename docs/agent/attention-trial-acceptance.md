# 个人行动入口组合验收与试用边界

Issue #333；Q0/Q5，生产装配沿P1-19。2026-10-15，机器结果归档artifacts/evidence/operation-flow-batch4/trial-validation；真人试用尚未执行。

## 驱动

pnpm build后，pnpm exec playwright test --config playwright.operations.config.ts --project p1-19。

追加的“个人行动入口”serial场景沿原P1-19团队、真设备配对、真Hub/Node/Runtime与DSH replay；用公开HTTP创建任务，用真实页面接受、拒绝、改派、发起运行、审批、预览、发布、提交验收与确认完成。没有新建运行时状态的写库近道；环境控制面仅沿现有装配读脱敏Run事实。独立18183/5313端口，不占用开发服务。

## 观测与机器判据

结构化component=web.attention结果包含五类事项的task/object身份、真实前后状态、实际聚焦目标，以及导航前后POST计数；导航不得发出命令。打开的另一方首页通过真实WS收到待接受/改派/审批变化，最近任务无需刷新出现新任务。非拥有者个人投影不含审批动作或候选身份。完成后队列无该任务事项。屏幕内容仅辅助，判定来自DOM焦点、网络请求、HTTP与脱敏运行事实。

产出artifacts/evidence/personal-attention/result.json。独立重判：pnpm exec tsx scripts/verify-attention-evidence.mts artifacts/evidence/personal-attention/result.json。输入缺失、格式错误、少动作、重复动作、身份错误、焦点错误、状态不变、导航发命令、私有身份泄漏、运行未完成或最终队列有残留，都必须FAIL，退出2。scripts/lib/attention-evidence.spec.ts含正向与断层负向控制，先红后绿；其合成单元数据不是生产/真人证据。

## 全量质量门与取证

pnpm check；pnpm build；共享P1-19变动需逐项目冷启动全量Q5：p1-19、p1-07、p1-140、p1-141、p1-142、p1-158、p1-314、p1-315、p1-306。不在同一Hub复用多个需要首次Setup的项目。

生产事实不齐看hub.task/approval/artifact及runtime.bridge；列表变化缺失看web.realtime→event-router→query；导航发POST看web.attention→原Task确认控件；焦点失败看对象锚点与异步审批到达。取证沿evidence-map，出包脱敏与secret-scan，原始登录/配对秘密不归档。

## 人工部分

operation-flow-usability-trial.md是一份可脱离本地路径交接的试用脚本，operation-flow-trial-template.json是空记录表。明确对照A/B版本、顺序平衡、四条用户情境、安装与模型等待的独立计时及决策标准。当前status=not_run；不得把自动Q5、截图或回放当成真人可理解性、真实Provider质量/延迟的结论。协议/隐私变化仍需双人独立评审后才能合入。
