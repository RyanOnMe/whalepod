# DSH 回滚演练验收（升级失败 → 回滚固定版）

- 对应场景/门禁：**Q3**（`pnpm test:dsh-contract`，CI check job）；总纲 §工程治理「DSH 熔断」规则 4
- 对应 Issue：#290
- 判定文件：`packages/runtime-dsh/tests/dsh-contract/rollback-drill.contract.spec.ts`（10 用例）
  + 共享检查 `packages/runtime-dsh/tests/dsh-contract/helpers/lock-drift.ts`
- 上次验证：2026-10-16 · `1ec5df8` 内容 · **PASS**（红 `bb7d2f7` → 绿 `eaa57fa`；评审修复 `484a797`；**Q0/Q3 在修复后内容上复跑**，Q2/Q5/Q6/Q7/Q9 在 `3f927f4` 内容上实测——本 PR 不改生产代码，不涉那些项目）
- 全量门（同一工作树实测）：Q0（1662 passed + 7 expected fail，含本文件登记的契约表漂移哨兵）/Q2（68 文件 491 用例）/Q3（16 spec 63 用例）/Q5（`pnpm test:e2e` 1 passed 30.5s exit 0）/Q6（32 用例）/Q7（18 用例 + secret-scan + 许可门）/Q9（`pnpm test:compose-smoke` PASS total=64.5s）全绿
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
2. **部分升级必红**（三种顺序各一条）：lock + catalog 升了、pnpm-lock 漏改 → `lockfile-version-mismatch`；
   只改了 catalog（锁与 pnpm-lock 没动）→ `catalog-version-mismatch`；catalog 行被删 → `catalog-missing`；
   pnpm-lock 整条 resolution 消失 → `lockfile-missing`（登记项缺失是红，不是"跳过"）。
3. **装错包必红**：三处版本一起换新但 lockfile 的 integrity 还是旧包的 → `lockfile-integrity-mismatch`。
4. **catalog 姿态必红**：`latest` / range → `catalog-not-exact`；依赖不再是 `catalog:` → `dependency-not-catalog`。
5. **空清单必红**：`packages` 清空 → `manifest-empty`（否则逐包检查会空转成绿）。
6. **单包三处自洽升级 → 门不红**（门判的是一致性，不是"必须是旧版"；见边界节的
   「没有 lockstep 语义」）；随后**回滚 = 还原锁定副本 → 门绿且四份文件与仓库逐字节相同**
   （本段的判别力在"回滚实现是 no-op / 少还原一份文件"；"哪一版才是固定版"的权威是人工门
   的 `git checkout <pin>`，本探针不重复判）。
7. 锁 ↔ 实际安装树一致：**十项直接依赖**的安装版本（`require.resolve('<pkg>/package.json')`）都必须等于
   `dsh.lock.json` 登记版本；`@deepseek-ai/dsh` 另走一遍生产自报路径（`dshDistributionInfo()`，#288，与 boot
   锚同源，也是 Q9 设备视图判据的本机版）。在干净 CI 上这主要由「node_modules 从同一份 lockfile 冻结安装」
   保证（近重言）；**有牙的是本机残留场景**（锁回旧版、`.pnpm` 还留新版）。
8. **判据有牙的变异自证**（实测，七条单点削弱各自点亮对应用例）：
   `resolution.version !== locked.version` → `false` ⇒ 漏改 pnpm-lock 用例红；
   `resolution.integrity !== locked.integrity` → `false` ⇒ integrity 用例红；
   `EXACT_VERSION.test(catalog)` 校验移除 ⇒ catalog 姿势用例红；
   `manifest-empty` 守卫移除 ⇒ 空清单用例红；
   `catalog !== locked.version` 比对 → `false` ⇒ 只改 catalog 用例红（评审 A 指出此前**零覆盖**，
   已补用例）；
   `catalog === undefined` 分支 → `false` ⇒ catalog 缺行用例红；`resolution === undefined` 分支 → `false`
   ⇒ lockfile 缺条用例红（同上，两条均为此轮补的覆盖）；
   **另一条是"世界变异"而非单点**：把 `dsh.lock.json` 的 `dsh-tools` 版本改成假值、安装树不动
   ⇒ 安装树用例红并点名该包（实测连带 5 条红：drift 的全局与 dsh-tools 行、演练基线、
   单包回滚用例、安装树用例——锁与树同时不一致，连带是预期的，别按"单点"读）。

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
  「装另一个 DSH 版本 → 触发一次已知不兼容 → 回滚安装树」需要 registry/网络与真安装
  （registry 拉包）+ rebuild，**不在 CI 判据内**。步骤与预期输出写在
  `.agents/skills/dsh-upgrade` 的「回滚」节，按人工门执行。
- **回滚语料的"哪一版是固定版"不在本探针内**：逐字节相同那段的判别力在「回滚实现是 no-op /
  少还原一份文件」；「固定版」的权威是人工门里的 `git checkout <pin>`。
- **没有十包版本联动（lockstep）语义**：本检查只判逐包三方一致，升级时各包是否必须同版本走
  由升级流程（skill 步骤）约束，不由锁一致性判——别把"一包升、九包留旧"读成已验。
- **跨版本会话日志兼容性**：判据 7 只判"锁 = 树"；「旧版 Runtime 能否读新版写出的会话
  日志」需要两个版本同时在手，属上面人工门的一部分（回滚后对既有 Workspace 起一次 Run
  并核对历史投影），这里不假装覆盖。
- integrity 的语义边界：检查判的是 lock 与 pnpm-lock 的**登记一致**，不向 registry 复核
  tarball 内容（那是安装期的事；`pnpm install --frozen-lockfile` 才会真正按 integrity 拉包）。
- 演练副本的编辑用窄正则（只认 `'name@version':` 键与紧跟的 integrity 行），pnpm-lock
  格式若大改（例如去掉引号）需要同步——它同时会打红本演练的注入断言，属 fail-closed 方向。

## 与「换版归因」的关系（#356）

回滚在**真实运行面**上的收尾（正在跑的 Runtime 不恢复、用户显式重跑）在 #356 后有了专用归因：
重启后的 Node 在孤儿恢复时比对 spawn 时记录的版本与本次启动探针版本，**两者都是字符串、
不一致、且孤儿经三重匹配确认仍存活**才报 `lost(RUNTIME_VERSION_CHANGED)`（早死/版本未知退回
`RUNTIME_LOST`）。本文件判的是**锁定态**（锁/catalog/lockfile/安装树），两者互补：锁回滚对了
（本文件）→ 版本串真的换了 → 运行面用专用码如实归因（#356）。**注意可见性边界**：真实回滚流程
停机分钟级，超过 Hub 租约（30s）时终态先被 reconciler 的 `RUNTIME_LOST` 收敛，专用码只在
秒级重启时可见——所以本文件（锁定态）与 #356（运行面）的判据不能互相替代。见
[runtime-version-change-acceptance](./runtime-version-change-acceptance.md)。

## 复跑

```bash
pnpm test:dsh-contract   # Q3：16 spec / 63 用例（含 apps/runtime 两文件 5 条）
```
