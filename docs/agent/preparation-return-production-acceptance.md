# 首次准备往返生产验收（#339）

## 驱动与范围

p1-315的双用户浏览器场景走已构建Hub/Node/Runtime包、真实HTTP/WS与DSH replay。真人路径创建团队/成员/Agent/项目/Task、接受任务、配对Node、检查准备。节点检查绑定具体Device/Workspace与不可变Revision；真实等待30秒过期后重查。编辑合成指令，点“安装并配对执行服务”进入设备页，再点“返回任务继续准备”，实际焦点落task-execution。没有测试专用执行近道，也不写运行投影表。

浏览器断言原正文、执行方式和四项设置文案不变；读取新事实完成后才允许发送。返回准备状态必须未确认，请求计数证明导航没有发指令和没有再探查Node。用户手工检查的请求必须带返回前相同四项身份；用户明确开始后只有一个指令请求，载荷正文和固定设置仍相同。等待真实Runtime的首次Run完成，从正式Run接口读取的Agent/Revision/Device/Workspace必须逐项等于保存和提交的设置，再继续走原授权撤销/审批/显式续跑主链。此场景不声称生产驱动了全部竞争分支；登出/换人/过期/缓存延迟/离线/归档/读失败由前两切片页面HTTP边界检查覆盖。

## 观测、判定、归因

结构化component=web.preparation.return，source=production-http-ws-node-runtime；只记不透明身份、前后设置、请求计数、焦点、状态、布尔判据和时间，不记录正文、路径、凭据或dshSessionId。浏览器驱动beforeAll在浏览器fixture与业务步骤之前删除本场景上次result.json，所有关键断言通过后才写新文件。本次准备/导航/发送失败不能留下上次成功结果；独立判定对缺文件或不完整事实必须失败。

脚本scripts/verify-preparation-return-evidence.mts独立读取JSON。字段缺失、身份无效、固定设置变化、焦点错误、导航发指令/自动检查、重复发送、准备结果复用、Run未完成及冒充真人结论都FAIL并exit 2；PASS exit 0。单元负向逐字段删除，并检验错误状态/计数/选择；先红提交保留完整事实尚不通过的失败。验收器不是证据真实性签名，机器事实来自上述生产驱动，不接受人工写一份JSON替代浏览器。

web.route归因返回上下文/焦点，web.execution归因编辑意图与发送，hub.instruction归因命令授权与受理，node.preparation归因现场检查，runtime.bridge归因实际Run终态。排查细项沿evidence-map，不能用截图代替命令与Run事实。

## 复跑与取证

1. pnpm check；pnpm build。
2. pnpm exec playwright test --config playwright.operations.config.ts --project p1-315。
3. pnpm exec tsx scripts/verify-preparation-return-evidence.mts artifacts/evidence/preparation-return/result.json。
4. 对空文件路径/空对象/删除selectionAfter/增导航计数分别运行判定，须exit 2。不要在正式证据原件上改写。 另外在刚成功生成真实证据后运行pnpm exec tsx scripts/check-preparation-return-failed-attempt.mts：它先确认旧证据有效，再让同一p1-315真实浏览器驱动在入口导航失败（仅负向配置指向不可用地址，不启动Hub/Node，不发业务命令）。从Playwright JSON结果确认实际到达page.goto且失败，再检查旧文件消失、独立CLI为FAIL/exit 2；整个负向控制为PASS。缺前置成功证据、浏览器未启动、配置错误或失败未到指定步骤都不能当作通过。此操作故意留下无当前成功文件，随后必须重跑第2/3步生成新的本次成功证据，不恢复旧文件。
5. 共用任务执行入口变化，隔离端口依次冷启动运行全部Q5九项目：p1-19、p1-07、p1-140、p1-141、p1-142、p1-158、p1-314、p1-315、p1-306。不得把不同项目合跑到已完成setup的同一Hub。
6. 源码与脱敏证据运行secret-scan，原件和判定结果入artifacts/evidence/operation-flow-batch5/production。先红/绿、Q0、构建与各Q5日志同包；不能只留临时目录。

使用18183/5313独立服务，不占用18080/5173真人现场。人类试用与真实Provider均未测；replay只证明装配/协议/状态链。真实试用情境与空表见operation-flow-usability-trial及operation-flow-trial-template。
