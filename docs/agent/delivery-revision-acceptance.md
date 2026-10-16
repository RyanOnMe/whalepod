# 意见修订与真人验收闭环（#327）

## 路径与边界

已发布意见可选择“根据意见修订”。进入统一执行区后保留草稿，来源先留空，用户手动选择产出会话并看到Agent/版本/环境；也可明确选择新执行，再重新选产出Agent。不自动使用最近Reviewer、不自动发送，意见材料只固定在本次新Run。旧会话可能已有旧材料，不把本次清单等同全部上下文。来源不属于本任务、非终态、旧责任人、无会话或归档Agent时按事实阻塞；设备/工作区由原生产守卫处理，不扩大协作者私有读取权。

交付区根据真实状态指出拥有者检查候选/发布、可选复核、责任人提交验收与真人确认完成。候选不能直接转复核/修订；复核不新增强制闸门、不自动done。修订从in_review启动复用run_started回到in_progress，产出重新检查发布并提交。确认期间条件/状态/权限失效关闭旧确认并保留草稿。

## 六原语

- 驱动：真实页面动作与原HTTP/协议/生产Hub、Node、Runtime；无新增后台业务近道。
- 观测：web.delivery.revision、Run来源与固定manifest、任务状态、发布身份、Node输入与Runtime事实，两个浏览器分别证明私有候选和公开完成。
- 判定：先红50a85c3四失败+六复核正控；最近Reviewer也不默认选来源，新执行必须重新选Agent；草稿与反馈保留、旧完成/完全权限确认失效、候选先发布。Q5完整串起意见发布→手动返回Builder→审批→修订候选→重新发布→提交验收→确认完成，旧Reviewer清单始终不变。
- 归因：来源/草稿/确认查web.execution；Run血缘/Task迁移查hub.run；材料查固定manifest与node.artifact；发布查artifact.store。
- 取证：artifacts/evidence/delivery-revision与operation-flow-batch3/revision-loop；截图辅助，JSON与HTTP/协议事实判定；不记录会话正文、秘密或本机路径。
- 发现：本页、README、evidence-map与第三批路线登记。

## 复跑

pnpm build、pnpm check；Web delivery-review/execution-composer/instruction-composer/action-conditions/approval-policy；隔离playwright.operations.config.ts下完整p1-19（14项）及其余八项目，不能与用户日常服务共端口；最终CI check/integration。协议/migration部分按约定先经独立评审再合入：三项已合入 main（PR #328/#329/#330，2026-10-15，各有 2–4 条评审记录）——**「本批保持 Draft」的口径自合入起已过期**。真实模型意见质量和真人理解成本仍需用户试用。

评审回归：发送期间连续选择复核/修订，只保留最后一次意图；双向顺序在真实页面与挂起的 HTTP 响应中验证，发送完成后不自动发送第二条指令。任务切换同时清空本地待处理意图。
