# 敏感不兼容禁启动（DSH 兼容闸与 Profile 身份对照点）验收

- 对应场景/门禁：**Q3**（`pnpm test:dsh-contract`，CI check job）+ Q1（`pnpm test:unit`）+ Q2（`pnpm test:integration`）；总纲 §工程治理「DSH 熔断」规则 3
- 对应 Issue：#288
- 上次验证：2026-10-16 · `4338604`（评审修复后的行为面；此前 `3afa4cd` 首版、`3479afe` 红测试） · **PASS**；本文件自身的后续改动不改变行为
- 全量门（同一工作树实测）：Q0（`pnpm check` 1657 passed）/ Q1 / Q2（68 文件 491 用例）/ Q3（42 用例）/ Q5（`pnpm test:e2e` 全链 exit 0）/ Q6 / Q7 全绿
- 登记处：本文是这条规则的操作面文档；覆盖状态表在 [runtime-capability-contract.md](./runtime-capability-contract.md)

## 验的是哪条用户路径

运维（或用户）把本机 DSH 升到/换到与插件包审过的版本不一致的版本之后，在同一台 Node 上发起一个
用了 Plugin Pack 的 Run——期望在**启动之前**就被明确拒绝（`PLUGIN_PACK_MISMATCH`，消息给出两侧
版本），而不是启动后在运行期出怪错误；以及 Runtime 回报的 profileDigest 与 Hub 固化的 Revision
digest 不一致时，Run 明确失败（`PROFILE_MISMATCH`）而不是带病执行。

> 对照点的**语义边界**：它覆盖 Node→Runtime→Node 的**往返一致**（回报值与固化值漂移、串扰、
> 过期进程复用会被抓）。它**不**校验 Runtime 装载内容（persona 等是明文下发），也**不**覆盖
> Hub 侧 digest↔内容绑定（未覆盖清单里）。措辞按此理解，别读成「装载身份已验」。

## 驱动（怎么触发）

```bash
pnpm -r --if-present build        # 探针走 dist 入口（生产形态），先构建
pnpm test:dsh-contract            # Q3：发行版身份 / --print-dsh-version 真 bin / ready 回声
pnpm test:unit                    # Q1：node 探针、preflight 兼容闸、run-manager 对照点
pnpm test:integration             # Q2：真 Hub+Node+Runtime 装配链上的 stub 也如实回声
```

判据文件（可点开）：

| 判据 | 文件 |
|---|---|
| 发行版身份自报 = boot 锚那棵树（报错源即红） | `packages/runtime-dsh/tests/dsh-contract/dsh-distribution.contract.spec.ts` |
| `--print-dsh-version` 真 bin：恰一行 JSON、exit 0、版本与安装树一致 | `apps/runtime/tests/dsh-contract/dsh-version-probe.contract.spec.ts` |
| ready 回声等于 initialize 携带值（换值跟随，不是常量） | `packages/runtime-dsh/tests/dsh-contract/boot.contract.spec.ts` |
| 探针 fail-closed：非 JSON/零输出/形状与版本不合法/非零退出/超时（pid 消失）→ null | `apps/node/tests/dsh-version-probe.spec.ts` |
| 兼容闸矩阵：descriptor 不符 / 版本不可知 / 本地命中改走 descriptor 复核 / 修复路径 / 旧 marker 重建 | `apps/node/tests/plugin-preflight.spec.ts` |
| 对照点：不符 → `PROFILE_MISMATCH` + 终止；一致不误杀 | `apps/node/tests/run-manager.spec.ts` |

## 观测（看什么）

- 探针：Runtime bin 的 stdout 一行 `{"dshName","dshVersion"}`（**不是协议帧**）；不可知时 stderr
  结构化日志 `runtime.bin` + exit 1。Node 侧 `node.hello` 的 `dshDistributionVersion` 现在来自它。
- 兼容闸：spawn Runtime **之前**就拒绝 Run——`command.ack accepted=false` 且 `error.code=PLUGIN_PACK_MISMATCH`，
  消息形如 `plugin <name> is reviewed for DSH <x>, local DSH is <y>` / `local DSH distribution version
  is unknown; refusing plugin pack (<name> requires <x>)`；**不下载 tarball**（拒绝发生在安装之前）。
- 对照点：`runtime.ready` 帧带 `profileDigest`；不符时 Node 合成 `runtime.fatal` →
  `run.failed`（code `PROFILE_MISMATCH`，summary 给两个 digest），并 `supervisor.cancel` 收掉 Runtime。

## 判定（成功长什么样）

1. `dshDistributionInfo()` 的 name/version/packageDir 与 `dshAnchorPath()` 指向的 package.json
   三者互证（版本过 `ExactVersionSchema`，红线：不接 range/latest）；
2. 真 bin 探针：stdout 恰一行、exit 0、版本等于 boot 锚树的 `@deepseek-ai/dsh` 版本；
3. 探针的失败形态全部返回 null（不猜）：非 JSON、零输出 + exit 0（旧 dist 形态）、形状/版本
   不合法（未过精确版本 schema 的串不许进 wire）、非零退出、超时（pid 消失自证）；
4. 逐包 `dshCompatibility` ≠ 本地版本 → `PLUGIN_PACK_MISMATCH` 且 tarball 零下载；本地版本为
   null 同样拒绝且不触网；**本地命中**路径不信任 marker 里的旧声明——不符时当本地未命中走
   descriptor 现读复核（仍拒绝则 tarball 零下载）；catalog 更新声明后同一设备重拉即可通过
   （修复路径有用例）；旧 marker（不带该字段）解析失败 → 当本地未命中重建（fail-closed 迁移）；
5. ready 回声与固化 digest 不符 → `run.failed(PROFILE_MISMATCH)` + terminate 一次；一致时
   不产生 run.failed、不 terminate；`runFacts` 缺失（不可达的兜底分支）也按违例收敛而不是放过。

反向自证：实现前同一批用例为红（`3479afe`）——probe 模块不存在、strict wire 拒多字段、
ready 无回声；实现后全绿。

## 归因（失败先看哪层）

| 现象 | 先看 |
|---|---|
| Run 被拒但消息说「local DSH ... is unknown」 | `node.plugin` 日志（启动时探针失败会打一条 warn）+ 手工跑 `node apps/runtime/dist/bin.js --print-dsh-version`——多为 dist 过期（旧产物不认识该 flag，静默 exit 0 无输出） |
| Run 被拒且给出两侧版本 | 真不兼容：更新 pack 的 `dshCompatibility` 声明（设备会重拉 descriptor 复核；`dshCompatibility` 不进 packDigest，同一 packDigest 可带新声明），或按 `dsh-upgrade` 升/回滚锁定版本；不要改闸 |
| Run 起不来且 `run.failed(PROFILE_MISMATCH)` | `runtime.ready` 帧的 profileDigest 与 Hub 固化的 Revision digest 比对（Node 侧日志 `node.run`）；先查是不是 Node 侧混了两个 Run 的 spec |
| 探针卡满 15s | 入口文件不可执行/依赖缺失：`node <entry> --print-dsh-version` 手工复现，stderr 有 `runtime.bin` 日志 |

## 取证

本链路证据是**可复跑用例本身**（Q3/Q1/Q2，无外部服务、无独立证据包）：红/绿两段提交、上面的判据
文件与 `git log` 同一位置可查。要落盘复核：

```bash
git log --oneline 3afa4cd~1..3afa4cd        # 红→绿
pnpm test:dsh-contract && pnpm test:unit
```

## 边界与未覆盖

- **探针依赖 dist 新鲜**：生产形态是 `node apps/runtime/dist/bin.js --print-dsh-version`；旧 dist
  会静默无输出 → 探针 null → 非 core-empty pack 一律拒绝。这是有意 fail-closed（未知 ≠ 兼容），
  代价是部署必须带新鲜构建（P1-20 安装门与 e2e 前的 `pnpm -r --if-present build` 已覆盖）。
- **探针在启动时只跑一次**：一次瞬时失败（慢盘/EAGAIN/旧 dist）会让本进程生命周期内所有非
  core-empty pack 被拒（fail-closed），启动日志有 warn、恢复手段是重启 Node；重试/缓存策略未做。
- **Q5 主闭环不经过这条闸**：`scripts/lib/phase1/chain.ts` 与 `scripts/e2e-node.mts` 的 RunManager
  不装配 `pluginPackPreflight`（也不经过 cli 的探针装配），所以「Q5 全链绿」不是该闸的端到端证据；
  闸的证据在 Q1/Q2 的 node 用例面 + Q3 真 bin 探针 + Q9 compose 真实 cli 路径。
- **没有装第二个 DSH 版本做端到端拒绝复现**：兼容闸的拒绝面用注入版本在 preflight 层复现
  （离线确定性）；真实「升级到不兼容版本 → 回滚」的演练归 #290。
- **Hub 侧的 digest 产出面未加独立判据**：「Hub 从 Revision 行复算出的 digest 等于存库值」需要
  先定一份独立 canonical 口径，未做；本轮的对照点只覆盖 Node↔Runtime 往返一致。
- DSH 版本在 Node **启动时探针一次**：升级 DSH 之后必须重启 Node 才生效（`dsh-upgrade` 流程
  本来就要求重启；本轮把这条前提写进了 CLI 注释）。

## 复跑

```bash
pnpm -r --if-present build
pnpm test:dsh-contract
pnpm exec vitest run --project unit apps/node/tests/dsh-version-probe.spec.ts \
  apps/node/tests/plugin-preflight.spec.ts apps/node/tests/run-manager.spec.ts
```
