import { describe, expect, it } from 'vitest'
import {
  coordinationSandboxCommand,
  coordinationWorkerEnvironment,
} from '../src/coordination-isolation.js'
import {
  validateCoordinationEndpoint,
  parseCoordinationModelResponse,
} from '../src/coordination-model.js'

describe('Router 的进程与 provider 边界', () => {
  it('不支持隔离的平台拒绝启动，不能降级成普通 Node 进程', () => {
    expect(() => coordinationSandboxCommand('freebsd', '/node', ['worker'])).toThrow(
      'isolation_unavailable',
    )
  })

  it('macOS 同一 worker 命令明确经过 deny-network 沙箱', () => {
    const command = coordinationSandboxCommand('darwin', '/node', ['worker'])
    expect(command.file).toBe('/usr/bin/sandbox-exec')
    expect(command.args).toContain('(version 1)(allow default)(deny network*)')
    expect(command.args.slice(-2)).toEqual(['/node', 'worker'])
  })

  it('Linux 必须通过 syscall filter wrapper 后 exec worker', () => {
    const command = coordinationSandboxCommand('linux', '/node', ['worker'])
    expect(command.file).toBe('python3')
    expect(command.args.slice(-2)).toEqual(['/node', 'worker'])
    expect(command.args.join('\n')).toContain('seccomp_load')
  })

  it('worker 不继承 provider key、Device Token、NODE_OPTIONS 或代理变量', () => {
    const env = coordinationWorkerEnvironment({
      PATH: '/usr/bin',
      LANG: 'en_US.UTF-8',
      WHALEPOD_COORDINATION_API_KEY: 'private-key',
      WHALEPOD_DEVICE_TOKEN: 'private-device',
      NODE_OPTIONS: '--import malicious-loader',
      HTTPS_PROXY: 'http://untrusted.invalid',
    })
    expect(env).toEqual({ PATH: '/usr/bin', LANG: 'en_US.UTF-8' })
  })

  it('provider 只接受明确端点，不接受用户信息、片段或远端明文 HTTP', () => {
    expect(validateCoordinationEndpoint('https://models.example/v1/chat/completions').href).toBe(
      'https://models.example/v1/chat/completions',
    )
    expect(validateCoordinationEndpoint('http://127.0.0.1:1234/v1/chat/completions').hostname).toBe(
      '127.0.0.1',
    )
    for (const endpoint of [
      'file:///private/data',
      'https://key@models.example/v1/chat/completions',
      'https://models.example/v1/chat/completions#secret',
      'http://models.example/v1/chat/completions',
    ]) {
      expect(() => validateCoordinationEndpoint(endpoint)).toThrow('invalid_provider_endpoint')
    }
  })

  it('provider 自行返回工具调用也拒绝，不把它作为可执行或合法文本结果', () => {
    expect(() =>
      parseCoordinationModelResponse({
        choices: [
          {
            finish_reason: 'tool_calls',
            message: { tool_calls: [{ function: { name: 'bash' } }] },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 2 },
      }),
    ).toThrow('unsupported_tool_call')
  })

  it('缺 usage 或截断结果不能当成成功', () => {
    expect(() =>
      parseCoordinationModelResponse({
        choices: [{ finish_reason: 'stop', message: { content: '{}' } }],
      }),
    ).toThrow('usage_missing')
    expect(() =>
      parseCoordinationModelResponse({
        choices: [{ finish_reason: 'length', message: { content: '{}' } }],
        usage: { prompt_tokens: 10, completion_tokens: 2 },
      }),
    ).toThrow('incomplete_model_result')
  })
})
