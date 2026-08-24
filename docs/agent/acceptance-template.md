# 验收文档模板

> 用法：复制本文件为 `docs/agent/<链路或场景>-acceptance.md`，填完后登记进 [README 索引](./README.md)。
> 写得好的验收文档说得清：验的是用户哪条路径（不是哪个函数）、怎么触发、成功长什么样、日志和数据在哪、哪些边界没验到、下次怎么复跑。

# <场景名> 验收

- 对应场景/门禁：G?-?? / R? / Q?（见 04-验收矩阵与测试策略.md）
- 对应 Issue：P1-??
- 上次验证：<日期> · <commit> · 结果 PASS/FAIL

## 验的是哪条用户路径

<从用户动作描述，例如「Bob 在 Task Room 点击批准，DSH 工具继续执行」。不是「测某个函数」。>

## 驱动（怎么触发）

<命令或脚本；必须走真人同一条处理路径。>

```bash
# 示例：pnpm phase1:drive -- --scenario g5-approval-allow
```

## 观测（看什么）

<结构化事件/查询，写明 component 层与关键字段。>

## 判定（成功长什么样）

<可证伪的断言。没数据、缺一环必须 FAIL；禁止「没报错就算过」。>

## 归因（失败先看哪层）

<现象 → 层 → 日志/表，参考 evidence-map.md。>

## 取证

```bash
# 示例：pnpm phase1:evidence -- --run <id>
# 出包后：scripts/secret-scan.sh artifacts/evidence/<scenario>/<attempt>
```

## 边界与未覆盖

<哪些情况没验、为什么。>

## 复跑

<从头复跑的最短命令序列，干净环境可执行。>
