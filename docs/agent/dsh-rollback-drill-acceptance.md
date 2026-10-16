# DSH 回滚演练验收（升级失败 → 回滚固定版）

- 对应场景/门禁：**Q3**（`pnpm test:dsh-contract`，CI check job）；总纲 §工程治理「DSH 熔断」规则 4
- 对应 Issue：#290
- 判定文件：`packages/runtime-dsh/tests/dsh-contract/rollback-drill.contract.spec.ts`（8 用例）
  + 共享检查 `packages/runtime-dsh/tests/dsh-contract/helpers/lock-drift.ts`
- 上次验证：2026-10-16 · 全量门结果与 pin 见本文件末「复跑」节
- 登记处：覆盖状态列在 [runtime-capability-contract.md](./runtime-capability-contract.md)

## 验的是哪条用户路径

运维按 `dsh-upgrade` 升级 DSH，半途失败（版本升了、锁文件漏了一处、tarball 换了 integrity
没跟上、catalog 被写成 range……），要能**机器判出"现在不能跑"**，并按流程回到锁定版——回到
的必须是**固定版**（不是任意自洽态），且回到之后版本自报与锁一致（"能跑"的最低含义）。

## 驱动（怎么触发）

```bash
pnpm test:dsh-contract   # Q3：16 spec / 61 用例；回滚演练与三方漂移检查共用同一份判据实现
# 单跑演练：
pnpm exec vitest run --project dsh-contract \
  packages/runtime-dsh/tests/dsh-contract/rollback-drill.contract.spec.ts
```

演练在 **mkdtemp 临时副本**上做（只读仓库、只写副本，`afterEach` 回收）：把
`dsh.lock.json`、`pnpm-workspace.yaml`、`pnpm-lock.yaml`、`packages/runtime-dsh/package.json`
四份复制出来，用窄正则/JSON 编辑模拟升级与回滚，再对副本跑 `checkDshLockDrift`——
**与 Q3 门同一份实现**（同一函数，不复制逻辑；这也是「演练 = 门」可成立的前提）。

## 观测（看什么）

- 检查产出是结构化的 findings（`kind` + `package` + `detail`），空数组 = 一致；
  kind 含 `catalog-missing / catalog-not-exact / catalog-version-mismatch /
  dependency-not-catalog / lockfile-missing / lockfile-version-mismatch /
  lockfile-integrity-mismatch / manifest-empty`——归因能直接点到"哪一处漏改"。
- 演练各用例的预期形状：部分升级 → `['lockfile-version-mismatch']`；integrity 不匹配 →
  `['lockfile-integrity-mismatch']`；catalog 写 `latest` / `^0.1.0-rc.8` → `['catalog-not-exact']`；
  依赖写具体版本 → `['dependency-not-catalog']`；空清单 → `['manifest-empty']`。

## 判定（成功长什么样）

1. 起点基线：仓库当前锁定态在副本上 findings 为空（先立基线，避免"检查本身坏了"被当绿）。
2. **部分升级必红**：lock + catalog 升了、pnpm-lock 漏改 → findings 恰好
   `lockfile-version-mismatch`（门有牙）。
3. **装错包必红**：三处版本一起换新但 lockfile 的 integrity 还是旧包的 → `lockfile-integrity-mismatch`。
4. **catalog 姿态必红**：`latest` / range → `catalog-not-exact`；依赖不再是 `catalog:` → `dependency-not-catalog`。
5. **空清单必红**：`packages` 清空 → `manifest-empty`（否则逐包检查会空转成绿）。
6. **整体升级三处自洽 → 门不红**（门判的是一致性，不是"必须是旧版"）；随后**回滚 = 还原
   锁定副本 → 门绿且四份文件与仓库逐字节相同**（回到固定版，不是任意自洽态）。
7. 锁 ↔ 实际安装树一致：`dshDistributionInfo().version`（#288 版本自报，与 boot 锚同源）
   == `dsh.lock.json` 里 `@deepseek-ai/dsh` 的版本。
8. **判据有牙的变异自证**（实测，四条单点削弱各自点亮对应用例）：
   `resolution.version !== locked.version` → `false` ⇒ 用例 2 必红；
   `resolution.integrity !== locked.integrity` → `false` ⇒ 用例 3 必红；
   `EXACT_VERSION.test(catalog)` 校验移除 ⇒ 用例 4 必红；
   `manifest-empty` 守卫移除 ⇒ 用例 5 必红。

## 归因（失败先看哪层）

| 现象 | 先看 |
|---|---|
| Q3 的 lock-drift 红 | findings 的 `kind` + `package`：先看 dsh.lock.json 的登记，再按 kind 去对应文件（catalog 行 / pnpm-lock 的版本键与 integrity 行 / runtime-dsh 依赖声明） |
| 升级后 pack 启动即拒 | 不是本判据：那是 #288 的 `dshCompatibility` 闸；修法是更新 pack 声明（见 dsh-upgrade 步骤 7） |
| 回滚后 Run 起不来但门是绿的 | 说明问题不在锁三方，而在安装树/构建：看 `--print-dsh-version` 的自报是否等于锁定版本（本文件判据 7 的本机版）、以及 Node 是否**重启**（版本探针只在启动时跑） |
| 演练用例红了但你看不懂 | 每个用例只断言一件事；先读断言名的"预期 findings 形状" |

## 取证

本链路证据是**可复跑用例本身**（Q3，无外部服务、无网络）。变异自证的复跑方法：

```bash
# 1) 改 helpers/lock-drift.ts 里的一条比对（例如 integrity 比对改 if (false)）
# 2) pnpm exec vitest run --project dsh-contract \
#      packages/runtime-dsh/tests/dsh-contract/rollback-drill.contract.spec.ts   # 对应用例必红
# 3) git checkout -- packages/runtime-dsh/tests/dsh-contract/helpers/lock-drift.ts
```

## 边界与未覆盖（不装作已验）

- **真实安装/回滚是人工门**：本演练判的是仓库四份锁定文件的一致性与回滚语义；真实
  「装另一个 DSH 版本 → 触发一次已知不兼容 → 回滚安装树」需要 registry/网络与真
  `pnpm install` + rebuild，**不在 CI 判据内**。步骤与预期输出写在
  `.agents/skills/dsh-upgrade` 的「回滚」节，按人工门执行。
- **跨版本会话日志兼容性**：判据 7 只判"锁 = 树"；「旧版 Runtime 能否读新版写出的会话
  日志」需要两个版本同时在手，属上面人工门的一部分（回滚后对既有 Workspace 起一次 Run
  并核对历史投影），这里不假装覆盖。
- integrity 的语义边界：检查判的是 lock 与 pnpm-lock 的**登记一致**，不向 registry 复核
  tarball 内容（那是安装期的事；`pnpm install --frozen-lockfile` 才会真正按 integrity 拉包）。
- 演练副本的编辑用窄正则（只认 `'name@version':` 键与紧跟的 integrity 行），pnpm-lock
  格式若大改（例如去掉引号）需要同步——它同时会打红本演练的注入断言，属 fail-closed 方向。

## 复跑

```bash
pnpm test:dsh-contract   # Q3：16 spec / 61 用例（含 apps/runtime 两文件 5 条）
```
