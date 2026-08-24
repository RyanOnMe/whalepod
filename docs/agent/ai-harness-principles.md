# AI Harness 原则：把「人手验证」拆成机器能做的事

> 别再当 AI 的上下文搬运工，去当它的环境架构师。
> 能写成步骤、能跑命令、能看日志判定的，一次性做成工具；人只留下「该不该做、好不好用」这类没法写成对错题的判断。

人验一个改动，其实就六件事。每件事在这个仓库里都有（或将要有）对应物的，才算接上。

## 1. 驱动 —— 别让人去点界面

给 AI 一个程序入口，但必须走和真人同一条处理路径。另开一条「测试专用通道」，验的就是假的。

本仓库的驱动入口（按层）：

- Hub API：Fastify `inject` Adapter，与真实 HTTP 同一个 app 实例。
- 完整 HTTP/WS 契约：`/api/v1`、`/ws/v1/client`、`/ws/v1/node`，所有产品动作都有机器可驱动入口。
- Device/Runtime：`DeviceGateway` 与 `RuntimeDriver` 的 Fake Adapter 走同一接口；DSH 用官方 `dsh-llm-replay` 无密钥回放真实 Agent Loop。
- 浏览器：Playwright 两个独立 BrowserContext，禁止共享 storage state。
- 标准链路驱动器：`pnpm phase1:drive`（P1-18，触发与判定分离，可换通道单跑）。

## 2. 观测 —— 结构化事件，不爬日志

关键步骤吐结构化事件，一行一条，写明谁干的、在哪一层、什么时候。
每个请求/命令/事件至少带：`requestId / traceId / runId / commandId / eventSeq / actorId / component / outcome`。

`component` 取值固定（06 文档 §8）：

```
browser | hub.http | hub.domain | hub.db | hub.outbox | hub.ws | node.gateway |
node.workspace | node.supervisor | runtime.bridge | dsh.agent | artifact.store
```

日志只存结构化摘要；禁止直接 log request body、headers、env 或 Runtime frame。

## 3. 判定 —— 成功标准是能跑的检查

把「成功长什么样」写成能跑的检查。没数据、缺一环，必须失败；不允许「看起来没报错就算过」。

- 质量门 Q0–Q9 见 [04-验收矩阵与测试策略.md](../../04-验收矩阵与测试策略.md)。
- 标准链路的判定器：`pnpm phase1:verify`（P1-18）；自证：故意打断任一层，verify 必须 FAIL 并指明是哪层。
- 领域状态机每条合法/非法边都有测试，分支覆盖率 ≥95%。

## 4. 归因 —— 报错要说出断在哪层

事件上的 `component` 字段就是层标。报错要从「保存失败」变成「请求发出去了，Outbox 没派发」。
不知道看哪层时查 [evidence-map.md](./evidence-map.md)。

## 5. 取证 —— 按 ID 一把捞齐

- 老经验「这种现象看哪个日志」写成对照表：见 [evidence-map.md](./evidence-map.md)。
- 按 Run/场景取证：`pnpm phase1:evidence -- --run <id>`（P1-18）。
- E2E 失败自动产出 `artifacts/evidence/<scenario-id>/<attempt-id>/` 包（布局见 04 文档 §9），采集前过同一脱敏库，采完跑 `scripts/secret-scan.sh`。
- 密码、Token、绝对路径、完整 DSH JSONL、未发布 Artifact 正文不进包。

## 6. 发现 —— 登记了才算做

做了上面这些，最后要登记：验收文档放本目录并进 [README 索引](./README.md)，可复跑脚本放 `scripts/`。漏了这一步，下一个 AI 看不见，又会重造一遍。

## 踩过坑才写下的

- 必须走真人那条路，不能抄近道（比如绕过 API 直接写库）。
- 探针埋在最底下的共享包（testkit、protocol），各端一起受益。
- 触发和判定拆开，可以换通道单独跑。
- 绿一次不算稳。要留下别人改坏就会红的检查。
- 默认只在开发/测试环境生效，别动别人正在用的进程。

## 做到哪一步的自评分级

1. 还在人手点、人翻日志（最底层）
2. 有结构化事件，但还得人读
3. 人触发之后机器能判对错
4. AI 能自己触发、自己判
5. 整条链路自己跑完，还能跨层对证据
6. 失败了能自己定位甚至改

衡量一个模块的验证做没做完，就看 AI 能不能自己点、自己看、自己判。第一阶段目标：主链（Task→Run→Approval→Artifact→Reviewer）达到第 5 级（P1-18/P1-19）。
