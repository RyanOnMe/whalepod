# 交付闭环合并前独立 Agent 评审（2026-10-26）

用户明确授权“开启 review agent，通过后合入”。本记录是独立 Agent 的代码/证据审查，不代表 GitHub 人员 APPROVED，也不声称真人已经试用。初审固定 main=`118f4c5`、候选=`bb30fb8`；各修复由作者之外的两位代理交叉复审。

## 初审阻塞与处理

| 问题 | 实证与处理 | 修复 |
|---|---|---|
| P1：Office 文档外链可读取宿主文件并写入 PDF | 合成 DOCX/外链 PNG 用真实 LibreOffice 复现；暂停未隔离默认和低层转换、新 PDF 上传及缺少可信隔离来源的历史预览读取，保留原件和批注；ADR-0023 | `0344ab7`，最终445组合头 `9b84492` |
| P2：认领提交后、Run 创建前退出导致永久 starting | 认领/Run/outbox/绑定/事件/回执同事务；旧遗留状态在Task→round锁内恢复 | `a620a41`；`ff193fe`仅补故障前置说明 |
| P2：批注/回复响应丢失后重试重复保存 | 完整请求意图持有本页待定键，成功后释放 | `e967c68` |
| P2：提问失败后编辑，旧幂等回执吞掉新问题 | 版本/上下文/正文完整签名分键，A→B→A重用未知结果A | `e967c68` |
| 验收缺口：API下载成功不能证明页面下载可用 | 两侧实际点击可见链接，读取浏览器下载实文件摘要/字节并清理；独立错摘要/错路由负控 | `06c0901`及其前序红测试 |

## 交叉复审矩阵

| 修复范围 | 作者 | 独立复审通过 |
|---|---|---|
| UI重试Map，`2624a60..e967c68` | review_web_harness | review_backend、review_runtime |
| 原子启动，`005211d..a620a41` | review_backend | review_runtime、review_web_harness |
| Office安全暂停，`b1f49a8..0344ab7` | review_runtime | review_backend、review_web_harness |
| 安全回退与真实下载harness，`06c0901`代码 | root | review_backend、review_web_harness |

初始三位审查覆盖后端权限/协议/迁移/状态、Node/Runtime/转换边界、Web/待办/版本绑定与独立判定；成果依据投影没有新增阻塞。组合只保留各已审业务补丁，文档冲突保留双方有效说明；Office业务在`9b84492`与已审`0344ab7`相同。

## 检查与边界

- UI作者 Node24：33项Web、类型/静态/扫描通过；复审者独立核对完整意图和未知结果行为。
- 启动作者 Node24：25项真实Q2、5项Unit及类型/静态/扫描通过，包含写Run/outbox后异常回滚、并发同/异键、旧状态恢复和改派复验。
- Office作者 Node24：41项Unit、37项Web、9项真实Q2及构建/类型/静态/扫描通过；另外两位分别独立运行18项和11项定向检查。
- 当前harness独立负控20项通过，最新整合浏览器和远端必检结果见 delivery-loop-acceptance.md 与 artifacts/evidence/delivery-loop。
- 历史ready/旧回执由 repository seam 负控与真实HTTP整体拒绝共同证明；浏览器用新候选，不伪称构造了历史PDF。
- 当前页请求重试键不跨刷新持久化；真实模型修订质量与团队效率仍未验证。Office自动在线PDF转换不属于此次开放能力。

## 合入约束

按 #435 → #443 → #444 → #445 → #446 依赖顺序，经普通 PR squash 合入 main；检查准确head的check/integration和合并结果树，不使用admin绕过、force push或直接推main。后续PR只在其前置已进入main后切换base，避免把功能squash进临时特性分支。提交保留DCO sign-off，历史证据保留并标明失效。
