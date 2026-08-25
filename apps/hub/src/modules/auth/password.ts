import { hash, verify } from '@node-rs/argon2'

// Argon2id 参数以 02 Task 5 Step 4 为准（m=19_456, t=2, p=1）。
// @node-rs/argon2 的 Algorithm 是 ambient const enum，与 verbatimModuleSyntax 冲突；
// 其默认算法即 Argon2id，由单元测试断言 PHC 前缀 $argon2id$ 钉死该行为。
export async function hashPassword(password: string): Promise<string> {
  return hash(password, {
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
  })
}

/** PHC 串损坏等异常一律视为不匹配，不向调用方泄露细节。 */
export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password)
  } catch {
    return false
  }
}

let dummyHashPromise: Promise<string> | undefined

/**
 * 登录对不存在用户也执行一次 Argon2 校验，拉平「用户不存在」与「口令错误」的
 * 耗时差，避免用户名枚举（04 §6.1：猜测形态必须一致）。
 */
export function dummyPasswordHash(): Promise<string> {
  dummyHashPromise ??= hashPassword('dummy-password-for-timing')
  return dummyHashPromise
}
