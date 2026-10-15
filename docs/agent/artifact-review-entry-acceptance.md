# 产出发起复核验收（#326）

已发布产出可转到统一执行入口的复核设置，显式选择最多64项材料并手动选Agent。已有草稿保留，不自动发送；后续发布显示为未勾选。活跃执行、无权、终态、未接受或材料失效时阻塞并说明下一步，不改投追问。

材料副本只读不代表Agent工具只读，当前审批仍有效；完全权限经过现有确认，权限/条件失效后关闭过期确认。复核启动使用责任人环境与凭据，协作者不读取私有设备清单。候选不能从此入口复核。

历史执行通过独立固定清单接口展示身份/来源运行/摘要/大小；旧NULL说明历史未知而非无材料，当前Task发布列表不能补成过去输入。

- 驱动：真实页面产出按钮、执行设置、草稿、Agent、确认与历史清单；生产Hub/Node/Runtime的P1-19 G6-07改走新入口。
- 观测：web.delivery.review、Node输入观测缝与HTTP固定manifest，按artifactId而非同内容hash偷换对象。
- 判定：先红249caef六项页面检查；材料不自动扩大、草稿不丢、权限/活跃不改投、完全权限先确认、历史清单不随当前列表改变。
- 归因：页面入口/草稿查web.execution；创建拒绝查hub.run；Node下载比对node.artifact；旧未知见ADR-0016。
- 取证：artifacts/evidence/delivery-review与operation-flow-batch3/review-entry，截图仅人工辅助，JSON与HTTP/协议事实决定成功。
- 发现：本页、evidence-map与第三批实施方案登记。

复跑pnpm check；Web delivery-review/artifact-list/execution-composer/approval-policy；pnpm build后隔离Q5的p1-19（本包聚焦4项，最终组合跑完整链）。最终组合全量Q5按第三批方案执行。真实用户理解与远端模型质量不由replay替代。

评审回归：最近任务在两个已缓存房间间往返导航，选中执行、展开输入与待处理意图按任务隔离；新房间不得显示旧任务材料，清单渲染再次校验任务归属。`delivery-review.spec.tsx` 的缓存导航用例走真实 Router 与 QueryClient。
