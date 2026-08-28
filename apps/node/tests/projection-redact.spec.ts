/**
 * 切片 A1 —— 脱敏库（03 §9 八条规则）+ 04 §6.4 固定语料。
 *
 * 判据：语料任一原文不得出现在脱敏输出（Q7 判失败的原样条款）。
 */
import { describe, expect, it } from 'vitest'
import { redactString, redactValue, type RedactionContext } from '../src/projection/redact.js'

const CTX: RedactionContext = {
  workspaceRoot: '/Users/bob/work/team-app',
  homeDir: '/Users/bob',
}

/** 04 §6.4 固定语料（原文逐项）。 */
const SECRET_CORPUS = [
  'Authorization: Bearer test-secret-123',
  'DEEPSEEK_API_KEY=sk-test-abcdef',
  'npm_xxx_fake_token',
  '-----BEGIN PRIVATE KEY-----',
  '/Users/bob/private/project',
  'https://example.com/path?token=secret#fragment',
] as const

describe('redactString（03 §9）', () => {
  it('规则 1：canonical Workspace 根替换为 <workspace>', () => {
    expect(redactString('edited /Users/bob/work/team-app/src/a.ts', CTX)).toBe(
      'edited <workspace>/src/a.ts',
    )
  })

  it('规则 2：home 目录前缀替换为 <home>（Workspace 之外的路径）', () => {
    expect(redactString('read /Users/bob/private/project/secret.txt', CTX)).toBe(
      'read <home>/private/project/secret.txt',
    )
  })

  it('规则 1 优先于规则 2：Workspace 在 home 之下时保留 <workspace>', () => {
    const out = redactString('/Users/bob/work/team-app and /Users/bob/other', CTX)
    expect(out).toBe('<workspace> and <home>/other')
  })

  it('规则 4：Bearer 值删除', () => {
    const out = redactString('Authorization: Bearer test-secret-123', CTX)
    expect(out).not.toContain('test-secret-123')
    expect(out).toContain('Bearer')
  })

  it('规则 4：私钥头删除', () => {
    const out = redactString('-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----', CTX)
    expect(out).not.toContain('BEGIN PRIVATE KEY')
  })

  it('规则 4：npm token 格式删除', () => {
    expect(redactString('token is npm_xxx_fake_token ok', CTX)).not.toContain(
      'npm_xxx_fake_token',
    )
  })

  it('规则 4 扩展：env 风格敏感键行删除值（DEEPSEEK_API_KEY=sk-…）', () => {
    const out = redactString('export DEEPSEEK_API_KEY=sk-test-abcdef done', CTX)
    expect(out).not.toContain('sk-test-abcdef')
    expect(out).toContain('DEEPSEEK_API_KEY')
  })

  it('规则 8：URL 只保留 scheme/host/port 与前 120 字符 path，query/fragment 删除', () => {
    const out = redactString('GET https://example.com/path?token=secret#fragment done', CTX)
    expect(out).toContain('https://example.com/path')
    expect(out).not.toContain('token=secret')
    expect(out).not.toContain('fragment')
  })

  it('规则 8：超长 path 截断到 120 字符', () => {
    const longPath = `/p/${'a'.repeat(200)}`
    const out = redactString(`https://example.com${longPath}`, CTX)
    // path '/p/' + 200a 截到 120 字符 → '/p/' + 117a。
    expect(out).toContain(`https://example.com/p/${'a'.repeat(117)}`)
    expect(out).not.toContain('a'.repeat(118))
  })

  it('固定语料逐条：原文全部消失（04 §6.4 / Q7）', () => {
    for (const item of SECRET_CORPUS) {
      expect(redactString(item, CTX)).not.toContain(item)
    }
  })
})

describe('redactValue（03 §9 规则 3/5：递归 + 键名删除）', () => {
  it('键名匹配 token/secret/password/api_key/authorization/cookie 的值删除', () => {
    const out = redactValue(
      {
        token: 'tok-1',
        apiKey: 'key-1',
        Authorization: 'Bearer x',
        nested: { password: 'pw', COOKIE: 'c', ok: 'fine' },
      },
      CTX,
    ) as Record<string, unknown>
    expect(out['token']).not.toBe('tok-1')
    expect(out['apiKey']).not.toBe('key-1')
    expect(out['Authorization']).not.toBe('Bearer x')
    const nested = out['nested'] as Record<string, unknown>
    expect(nested['password']).not.toBe('pw')
    expect(nested['COOKIE']).not.toBe('c')
    expect(nested['ok']).toBe('fine')
  })

  it('数组内字符串递归脱敏', () => {
    const out = redactValue(['Bearer test-secret-123', 'plain'], CTX) as string[]
    expect(out[0]).not.toContain('test-secret-123')
    expect(out[1]).toBe('plain')
  })

  it('字符串值里的 workspace 路径也被替换', () => {
    const out = redactValue({ path: '/Users/bob/work/team-app/src/a.ts' }, CTX) as Record<
      string,
      unknown
    >
    expect(out['path']).toBe('<workspace>/src/a.ts')
  })
})
