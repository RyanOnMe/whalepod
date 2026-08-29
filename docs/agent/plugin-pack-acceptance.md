# Curated Plugin Pack 与未修改插件验收

- 对应场景/门禁：G1-05（插件安装权限）、04 §6.5（插件攻击矩阵）、Q3（DSH 契约）
- 对应 Issue：P1-17（GitHub #21）
- 上次验证：2026-08-29 · feat/p1-17-curated-plugin-pack 工作树 · 结果 PASS

## 验的是哪条用户路径

Admin 在「插件管理」看到 curated catalog 的审核信息（精确版本、integrity 短摘要、license、review commit、声明能力）→ 安装 reviewed 插件（不影响任何已有 Agent Revision）→ 勾选已安装插件组装不可变 Pack → 在 Agent 管理新建 Revision 引用该 Pack → 新 Run 派发到 Node：preflight 按 packDigest 拉 descriptor、校验、安装、生成 Cordis overlay → Runtime 原样加载未修改插件 → 模型调用 `fixed_time` → 审批放行 → 返回固定时间 `2030-01-02T03:04:05.000Z`。

反向路径：Member 调安装接口被拒（G1-05）；catalog/lock/SRI/pack digest 任一处漂移被拒；插件崩溃只毁掉自己的 Runtime，Hub/Node 不动。

## 驱动（怎么触发）

分层各有可复跑入口，全部走真人路径（HTTP API / wire 命令 / 真实 DSH boot），无测试专用近道：

```bash
# Hub 层（真实 postgres，docker 一次性容器）
pnpm exec tsx scripts/with-test-postgres.mts vitest run --project integration \
  apps/hub/tests/plugin-catalog.integration.spec.ts apps/hub/tests/plugin-pack.integration.spec.ts

# Node 层（内存 fetch 注入 descriptor/tarball，真 installer/真 overlay 渲染）
pnpm exec vitest run --project unit \
  apps/node/tests/plugin-installer.spec.ts apps/node/tests/plugin-installer-limits.spec.ts \
  apps/node/tests/tar-pax.spec.ts apps/node/tests/runtime-config.spec.ts \
  apps/node/tests/plugin-preflight.spec.ts apps/node/tests/plugin-fixture.spec.ts

# Runtime 层（真 DSH boot + replay LLM 出口，工具真实执行）
pnpm test:dsh-contract -- unmodified-plugin

# fixture 数据树完整性（tarball 字节确定性 + digest 三阶段锚）
pnpm check:plugin-fixture
```

## 观测（看什么）

- Hub：`plugin.install` / `plugin.pack` audit 事件（success/denied）；`plugin_installation` / `plugin_pack` 表行（pack_digest 确定性）。
- Node：`command.ack` 的 `accepted` 与 wire 失败码（`PLUGIN_PACK_MISMATCH` / `PLUGIN_UNREVIEWED` / `RUNTIME_START_FAILED`…）；`runtime.initialize` 是否携带 `pluginPackOverlayPath`；`node.hello.pluginPackDigests`。
- Runtime：`session.event` 投影里的 `tool/call`（name=fixed_time）与 `tool/result`（含定值、无 isError）；崩溃场景下 `RuntimeBridge.start` 的归因错误。

## 判定（成功长什么样）

- 插件攻击矩阵全绿：integrity mismatch / dependency lock 漂移 / tarbomb（含 gzip bomb：压缩体内、解压超 64MiB 照拒）/ symlink escape / pax 越界（`..`、绝对路径、'g' 泄漏、畸形 size）/ 重定向出白名单 / version range / 未审核包 / pack digest 漂移各自被拒（`plugin-installer.spec.ts` + `plugin-installer-limits.spec.ts` 10 例 + `tar-pax.spec.ts` 7 例 + preflight 12 例 + hub 集成；`plugin-catalog-load.spec.ts` 8 例锚 loadPluginCatalog fail-closed）。
- 传输面两道闸：3xx 逐跳 host 白名单（初始 URL 白名单不因一次 302 失效；跳数上限 5）；body 流式截断（不收满无界 body）+ gunzip `maxOutputLength` 64MiB。
- 未修改插件端到端：overlay 挂载的 fixture 返回定值；无 overlay 反证（isError）证明是 pack 而非 harness 起作用（`unmodified-plugin.contract.spec.ts`）。
- digest 三阶段锚：catalog integrity ↔ committed tarball 字节 ↔ 安装树逐成员相等；packDigest 在 catalog / Node preflight / Runtime overlay 三处同值（`plugins/curated-pack.json` 现算复算一致）。
- 插件崩溃隔离：start 可归因失败、bridge 不可复用、进程不挂死、同进程后续 boot 正常。
- G1-05：Member POST /plugins/installations → 403 FORBIDDEN + audit denied。
- 安装/组 Pack 不自动修改已有 Agent Revision（UI 文案断言 + 无隐式写路径）。

## 归因（失败先看哪层）

- descriptor 拉取/校验失败 → Node `plugin-preflight.ts` 失败码表（消息白名单，tarball 内容不回传）。
- overlay 生成/锚目录 → Node `runtime-config.ts`（configDigest 复算漂移 = INTEGRITY_MISMATCH）。
- Runtime 挂载/执行 → `unmodified-plugin.contract.spec.ts` 场景断言 + bridge 结构化日志（只带 runId）。
- catalog/pack 装配 → Hub `modules/plugin/pack-resolver.ts`：未知 digest 与 digest 复算不一致（entrypoint 漂移）= 404 同形态，不泄露存在性；已存在 Pack 的快照字段漂移（integrity/lock digest/能力集）= 409 PLUGIN_PACK_MISMATCH 显式信号（04 §6.1 的不枚举承诺只覆盖未知 digest 探测面）。
- pack overlay 合法性 → Runtime `bridge.ts` 的 `loadPackOverlay` 两道 fail-closed 门（insert-only 形态 + insert id 不得撞 boot 栈既有 id），违约即 RUNTIME_START_FAILED（`pack-overlay-guard.contract.spec.ts`）。

## 取证

各层测试即证据；改 fixture 或 digest 算法后必须：

```bash
pnpm exec tsx scripts/build-fixture-plugin.mts   # 重生成四产物，同一提交
pnpm check:plugin-fixture                        # --check 只验不写（Q0 已挂）
```

## 边界与未覆盖

- 声明能力（workspace.read/network.egress 等）第一阶段是审核与展示契约，未实现 OS 级强隔离（02 Step 6 明示）。
- fixture 闭包为空（peer 依赖由宿主 DSH distribution 提供）；带真实依赖闭包的包未端到端验过（installer 闭包路径有合成依赖单测）。
- 插件崩溃对 Hub 的隔离由架构保证（Hub 永不加载插件，check-boundaries 强制）；Runtime 侧已验，Node supervisor 对 Runtime 崩溃的处理沿用 P1-12 既有测试。
- catalog 的 tarballUrl 是 npm 布局占位；所有测试注入 fetch，未走真网络（第一阶段无外网依赖）。
- Web 端为 jsdom 层；浏览器 e2e 门（Q5）P1-19 才生效。
- 威胁模型假设（review 登记，非缺陷）：
  - Node 本地命中（marker + store lookup）不做逐包 digest 复算——内容寻址 + 只读化保证 digest↔内容一致；残余风险是 same-uid 本地攻击者预置/篡改 store 树（storeRoot 已收紧 0o700；同 uid 攻击者本就能替换节点自身 JS，属同信任域）。
  - Node 下行帧经 `parseNodeFrame('downstream')` fail-closed 校验；该校验防的是 Hub 失陷/TLS 失效后的畸形帧，不替代 TLS 与 Device Token 认证。
  - catalog 审核（review.commit）是最终信任根：installer/preflight 的所有密码学校验都只保证「安装的 == 审过的」，不保证「审过的是良性的」。

## 复跑

```bash
pnpm check && pnpm test:integration && pnpm test:dsh-contract
# 关键提交点全绿：Q0（含 fixture 检查）764 单测、Q2 216 集成、Q3 33 契约
```
