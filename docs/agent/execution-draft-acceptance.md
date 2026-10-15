# 当前登录会话的执行草稿验收（#337）

## 用户路径

在任务编写指令、选择Agent/不可变Revision及本人的设备/Workspace，离开去设备页或另一任务，再从最近任务返回。保留编辑意图，不恢复权限、准备快照、确认弹窗或自动执行。草稿只在AppShell内存、当前userId/taskId范围存在；刷新、登出、会话过期或换人丢弃。显示保留边界并提供清除入口。

## 实现边界

执行方式、指定来源、复核/修订材料和固定设置属于草稿；当前责任人不同于草稿绑定责任人时阻塞，正文保留，由用户明确重选。来源结束或材料失效沿原条件拒绝，不静默切换新执行/其他Run。所有发送仍是生产HTTP命令，服务端守卫不变。未落库，不写浏览器Storage/URL/团队投影。

请求待返回状态与该载荷幂等键跨路由保留；返回不重发或解除锁定。受理后才清正文，失败/拒绝保留，含义不明的相同请求重试沿原键。用户离开TaskA时的响应只更新A的编辑状态，不修改当前TaskB或下一登录会话。准备检查、已批准的full_access对话框等瞬时结果不保留。

## 六原语与判据

真实Router/AppShell与QueryClient，HTTP边界模拟公开接口（不直写运行投影）。execution-composer.spec.tsx按用户点击导航、输入、选择和发送；观测实际文本/固定字段、请求数量/幂等键、禁用状态和登录跳转。无数据或任一边界缺失必须失败。初始五条回归先红，覆盖丢稿、跨任务、待发、重试与责任变化；后续覆盖两身份、登出、刷新、过期、来源结束和不可变版本。

组件边界不声称真实Provider已可调用。往返的生产Hub/Node/Runtime证据及全量Q5由#339组合验收补齐；真实用户试用仍未执行。

## 复跑与取证

pnpm exec vitest run --project web apps/web/tests/execution-composer.spec.tsx；pnpm check。隐私看web.execution.draft的actor/task作用域和AppShell卸载；误投看mode/source/owner绑定；重复请求看payload与idempotency-key及pending锁定。仅保存脱敏判据，不记录正文、凭据或本机路径。证据入artifacts/evidence/operation-flow-batch5/draft，出包secret-scan；索引与evidence-map同步。
