---
status: accepted
---

# 0007 Run 状态机越边：终态裁决开边，冲突惩罚从连接级降到 Run 级

## 背景

Hub 对 Node 上行帧的处理错误共用一个 catch-all：`socket.close(4003)` 断开整条设备连接。Run 处于 `waiting_approval` 时 Runtime 上报终态（`run.completed`/`run.failed`）撞 `RUN_NEXT` 表外边抛 `INVALID_RUN_TRANSITION`，且留证与迁移在同一事务——抛错回滚连事件行都不留下。Node 重连补发同一帧再撞同一边，形成无限毒帧循环：该 Run 永不收敛，R1 断线补发的可靠性承诺被架空，并殃连同连接上其它活跃 Run。同类越边在 `cancel_requested`（完成/取消竞态、Runtime 崩溃）与 `approval.decided` 引用缺失行处同样可达，是一个类而非孤例。§11 连接级 fail-closed 的初衷是不给「半解析数据」留通道，射程是结构坏、版本不符与越权；而越边帧结构合法、归属合法、seq 连续，可疑的只是单个 Run 的账本解释。系统内已有多处宽宥先例（§11 未知 event 记录并 ack、`run.snapshot` 非法边静默跳过、Node 层 Runtime 协议违例只杀当前 Run），唯独 `run.event` 通道维持连接级死刑。

## 决策（#52 拍板：方向 3 —— 加边 + 留证降级并用）

1. **领域加边**：`RUN_NEXT.waiting_approval` 接受 `completed`/`failed`。语义：审批的执行闸门在 Runtime 路径（ask-all 阻塞），不是 Hub 侧的终态前置条件；Runtime 在悬置审批下报出终态是对该 Run 的最终裁决（与过期等价拒绝 G5-05、取消联动折叠 G5-07 同族）。落终态的同事务把 pending Approval 折叠为 `cancelled` 并广播 `approval.changed`（payload 标 `cause=run_terminal_fold`）——不得记 `rejected`/`expired`（伪造决定/伪造计时）。`cancel_requested` 仍不收终态裁决边：取消的收敛由确认/强杀/租约负责。
2. **Hub 降级**：4003 收窄至通道不可信类（`parseNodeFrame` 失败、JSON 坏、deviceId/heartbeat 越权）。`run.event` 通道上表外越边与引用缺失（`INVALID_RUN_TRANSITION`、`approval.decided` 的 `NOT_FOUND` 近亲）降级为：事件行留证（与收敛同事务提交，不再随迁移失败回滚）→ 非终态 Run 收敛 `failed(INVALID_RUN_TRANSITION)` → 连接保留 → 结构化 warn（`component=hub.run` 分层）。failure_code 复用 wire 既有码 `INVALID_RUN_TRANSITION`（§10/ErrorCodeSchema 零变更）。
3. **不变项**：终态禁复活（违例后到的真终态事实只留证不动状态）；状态迁移仅 owner 行驱动；ack 连续水位语义不变；HTTP 写路径（取消等）的非法边照旧 409。
4. **正典回填**：03 §3.2 状态图与特殊规则、04 新增 G5-08。

## 后果

- 正向：毒帧循环对一切表外边永久绝迹，R1/R6 承诺恢复；`waiting_approval` 的裁决语义与过期/取消折叠规则一致；Hub↔Node 与 Node↔Runtime 两层的惩罚粒度哲学统一。
- 代价与风险：连接级安全网消失后，真实乱序/坏实现从「断连报警」变为「Run 收敛 failed」，依赖结构化违例 warn 与后续告警计数兜住（违例计数器无既有模式，留 follow-up）；表内新边使 replay overlay 与生产 ask-all 的行为分叉更显性，由 Q3 契约探针保留阻塞语义用例（G5-03 全链路）对冲；用户侧出现「审批未答 Run 即完成」的观感，折叠事件即时收卡（`cause` 字段供文案区分）。
- 弃选：仅加边（追不完竞态类，`cancel_requested` 一族仍毒通道）；仅降级（把真完成记成 failed，违反 R1「Run 误终态」判据）；新造 `PROTOCOL_VIOLATION` 码（§10 SSoT + protocol 枚举 + 对齐门三处变更，收益仅措辞）。
