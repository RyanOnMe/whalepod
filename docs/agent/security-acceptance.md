# Q7 安全门验收登记

- 对应门禁：Q7（04 §6.1 威胁模型）；门命令 `pnpm test:security`
- 对应 Issue：#106（首个用例族）；Q7 工程面随 P1-20（#24）建立
- 状态：生效中（首族绿于 #106 分支）

## 门形状（四半边，一条命令）
1. `vitest --project security`：命名即归属——`*.security.spec.ts` 只进本 project
   （unit 的 exclude 明确剔除，**不双跑**）；DB 依赖经 `with-test-postgres`。
2. `scripts/secret-scan.sh --self-test`：判定力自检（防模式被改坏后假绿）。
3. `scripts/secret-scan.sh`：实扫 evidence 输出面（04 §6.4）。
4. `tsx scripts/license-check.mts`：依赖许可 gate（#24 判据落地：强 copyleft 红、
   弱 copyleft 白名单必须带 via+rationale、UNKNOWN 红；判定逻辑有红样自检
   `scripts/tests/license-check.spec.ts`）。

## 用例族清单
| 用例 | 断言 | 来源 |
|---|---|---|
| 域层界值 | 11 码点拒 / 12 过；空/单字符拒；**码点**计数（emoji 代理对不劈半） | #106 |
| Setup HTTP 半边 | 11 字符真请求 400 `VALIDATION_FAILED`；同实例 12 字符 201 且**反证 setupToken 未被 400 烧掉**（"拒绝先于副作用"不信文案信下一步） | #106 |
| Invite 接受半边（B1） | **admin 角色**邀请 11 字符 ⟹ 400 且成员未建、**同 token 换合规口令仍可 201**（拒绝先于消耗）；封"只修 setup 一腿"的半修 | #106 评审 |
| 登录豁免（正形） | DB 种 1 字符 argon2 hash（模拟历史存量，测试基建直写）⟹ login 200：政策管进门建账、不管历史口令锁死 | #106 评审 N2 |

## 发现账（本门首案即立威的实录）
- 全仓曾无口令强度政策：`PasswordSchema=z.string().min(1)`，域层/hub 无 policy 层
  ⟹ 1 字符密码可建 Owner（#106 立契）。Argon2 参数只防离线爆破，不拦弱口令本体。
- 04 §6.1 的 dummy-hash 防枚举**当时是真的做到了**（登录耗时一致）——防住了
  用户名枚举却没防弱口令：两案互不覆盖，威胁模型逐条要有对应用例，"看起来有
  防护"不是"该条有判据"。

## 待补（按 04 §6.1 逐条挂用例，不烂尾）
- security project 的 include 是位置限定（`apps|packages/*/tests/**`）而 unit 的
  exclude 是全仓 `**/*.security.spec.ts`——`scripts/` 下命名的安全用例会**全局隐身**
  （评审 N4 抓出的不对称，现无此文件）。follow-up：include 收敛为单条
  `**/*.security.spec.ts`，两个 pattern 一条 SSoT。
- Cookie Secure 分支与 LAN http 失效形态（#105 裁决后补对应用例）
- 令牌/secret 在投影与日志的脱敏断言（既有代码有规则，缺 security project 用例锁）
- CSRF Origin 逐字节（既有 integration 已覆盖主案，迁名挂族即可）

## 复跑
```bash
pnpm test:security                                   # 三门半边（本地 Docker）
```
