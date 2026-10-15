# ADR-0014：针对本次执行的本机准备检查

- 状态：已采纳，协议与控制面已通过两名独立评审
- 日期：2026-10-14
- Issue：#320

## 事实

node.inventory 的凭据清单仅枚举本机文件，未枚举 SecretStore 的环境变量解析来源。缺少清单项不能证明未配置；只存在清单项也不能证明文件权限正确或模型能调用。

## 决定

提供责任人专属 POST /tasks/:id/preparation-check，绑定所选不可变 Agent Revision 与生产 resolveRunTarget 解析的本人设备/Workspace。Hub 通过活跃设备连接发只读 node.preparation_check；Node 用与实际启动同源的 registry.resolve 和 SecretStore.resolve 检查，只回 Workspace/凭据状态，不回秘密、路径或文件内容，不调用 Runtime 或模型。

结果通过 node.preparation_result 与随机 requestId、Device 和**同一连接实例**关联。检查是可重试的只读请求，不入业务 Outbox、不创建 Run/消息/回执。等待有超时与全局/设备并发上限；断线、连接替换、未知旧 Node 或超时均无法确认，不把旧检查当作当前有效结果。结果不进入团队事件或投影。

网页手动发起检查；固定版本/目标变化或30秒时效到期后不再显示为当前已确认。自动目标检查成功后明示并固定为本次显式目标，不能用检查A的结果为自动解析B背书。检查本身不证明插件、模型额度或真实网络调用可用。

引导保留原草稿。选择试运行只在空草稿时填入一条简单指令，说明可能有模型费用及沿用当前审批设置；仍由用户点击现有执行入口并观察实际运行/产出。不把 Agent 指令当成工具只读安全保证。

## 保留边界

协作者不获得责任人的私有设备/Workspace/凭据探针；讨论、接受任务、已发布成果无需本人安装Node。管理员不因团队角色而有权探查成员本机。运行启动时已有 preflight仍重检，准备检查不是授权凭证。老Node超时给升级提示，不静默声称就绪；DSH与Runtime wire不改。

## 验证

协议strict schema/fixture/生成物；本地真实registry+SecretStore（文件/环境变量/权限失败）；真实HTTP+WS的身份、错设备/错连接/超时边界；生产bin Node的Q5检查与可选试运行。证据登记execution-preparation-acceptance。
