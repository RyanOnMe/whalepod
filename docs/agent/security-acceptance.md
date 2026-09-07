# Q7 安全门验收登记

- 对应门禁：Q7（04 §6.1 威胁模型）；门命令 `pnpm test:security`
- 对应 Issue：#106（首个用例族）；Q7 工程面随 P1-20（#24）建立
- 状态：生效中（首族绿于 #106 分支）

## 门形状（三半边，一条命令）
1. `vitest --project security`：命名即归属——`*.security.spec.ts` 只进本 project
   （unit 的 exclude 明确剔除，**不双跑**）；DB 依赖经 `with-test-postgres`。
2. `scripts/secret-scan.sh --self-test`：判定力自检（防模式被改坏后假绿）。
3. `scripts/secret-scan.sh`：实扫 evidence 输出面（04 §6.4）。

## 用例族清单
| 用例 | 断言 | 来源 |
|---|---|---|
| 域层界值 | 11 码点拒 / 12 过；空/单字符拒；**码点**计数（emoji 代理对不劈半） | #106 |
| Setup HTTP 半边 | 11 字符真请求 400 `VALIDATION_FAILED`；同实例 12 字符 201（政策不吞合法路径）；登录不受政策约束 | #106 |

## 发现账（本门首案即立威的实录）
- 全仓曾无口令强度政策：`PasswordSchema=z.string().min(1)`，域层/hub 无 policy 层
  ⟹ 1 字符密码可建 Owner（#106 立契）。Argon2 参数只防离线爆破，不拦弱口令本体。
- 04 §6.1 的 dummy-hash 防枚举**当时是真的做到了**（登录耗时一致）——防住了
  用户名枚举却没防弱口令：两案互不覆盖，威胁模型逐条要有对应用例，"看起来有
  防护"不是"该条有判据"。

## 待补（按 04 §6.1 逐条挂用例，不烂尾）
- Cookie Secure 分支与 LAN http 失效形态（#105 裁决后补对应用例）
- 令牌/secret 在投影与日志的脱敏断言（既有代码有规则，缺 security project 用例锁）
- CSRF Origin 逐字节（既有 integration 已覆盖主案，迁名挂族即可）

## 复跑
```bash
pnpm test:security                                   # 三门半边（本地 Docker）
```
