/**
 * Node CLI 的 workspace/secret 命令实现（P1-12；02 Task 12 Step 3）。
 *
 * `workspace add <path> --name <n>`：realpath 归一注册（G3-06 canonical 采用）；
 * `workspace list/remove`：本地映射管理；删除 registry 项不删目录。
 * `secret set <provider> <slot>`：TTY 无回显读取；本地 secrets.json 0600。
 * Hub 只见 slot 的 configured/unconfigured（inventory），永不见明文。
 */
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { WorkspaceRegistry, WorkspaceError } from './registry.js'
import { SecretError } from '../secret/store.js'
import { SecretStore } from '../secret/store.js'

/** TTY 无回显读取一行（secret 输入；非 TTY 环境退化为普通行读，供测试/管道）。 */
export async function readHiddenLine(promptText: string): Promise<string> {
  if (!stdin.isTTY) {
    const rl = createInterface({ input: stdin, output: stdout })
    const value = await rl.question(promptText)
    rl.close()
    return value.trim()
  }
  stdout.write(promptText)
  const chars: string[] = []
  const wasRaw = stdin.isRaw ?? false
  stdin.setRawMode(true)
  stdin.resume()
  await new Promise<void>((resolve) => {
    const onData = (chunk: Buffer): void => {
      for (const ch of chunk.toString('utf8')) {
        if (ch === '\r' || ch === '\n') {
          stdin.removeListener('data', onData)
          stdin.setRawMode(wasRaw)
          stdout.write('\n')
          resolve()
          return
        }
        if (ch === '\u0003') {
          // Ctrl-C：退出且不留半行。
          stdin.setRawMode(wasRaw)
          process.exit(130)
        }
        if (ch === '\u007f' || ch === '\b') {
          chars.pop()
          continue
        }
        chars.push(ch)
      }
    }
    stdin.on('data', onData)
  })
  return chars.join('')
}

export interface WorkspaceCliDeps {
  readonly registry: WorkspaceRegistry
  readonly secrets: SecretStore
  readonly write: (text: string) => void
}

export async function runWorkspaceCommand(
  deps: WorkspaceCliDeps,
  sub: string,
  args: { path?: string | undefined; name?: string | undefined; id?: string | undefined },
): Promise<void> {
  try {
    if (sub === 'add') {
      if (args.path === undefined || args.name === undefined) {
        deps.write('usage: workspace add <path> --name <name>\n')
        process.exitCode = 2
        return
      }
      const ws = await deps.registry.register(args.path, { name: args.name })
      deps.write(`registered: ${ws.id} (${ws.kind}) ${ws.name}\n`)
      return
    }
    if (sub === 'list') {
      for (const ws of await deps.registry.list()) {
        deps.write(`${ws.id}  ${ws.name}  ${ws.kind}\n`)
      }
      return
    }
    if (sub === 'remove') {
      if (args.id === undefined) {
        deps.write('usage: workspace remove <workspaceId>\n')
        process.exitCode = 2
        return
      }
      await deps.registry.remove(args.id)
      deps.write(`removed: ${args.id}\n`)
      return
    }
    deps.write(`unknown workspace subcommand: ${sub}\n`)
    process.exitCode = 2
  } catch (error) {
    if (error instanceof WorkspaceError) {
      deps.write(`${error.code}: ${error.message}\n`)
      process.exitCode = 1
      return
    }
    throw error
  }
}

export async function runSecretSet(
  deps: WorkspaceCliDeps,
  provider: string,
  slot: string,
  readHidden: (prompt: string) => Promise<string> = readHiddenLine,
): Promise<void> {
  const value = await readHidden(`secret for ${provider}/${slot} (input hidden): `)
  if (value === '') {
    deps.write('empty secret; aborted\n')
    process.exitCode = 2
    return
  }
  try {
    await deps.secrets.set(provider, slot, value)
  } catch (error) {
    // 与 workspace 分支对称：可预期的本地校验错误走人话输出，不抛栈。
    if (error instanceof SecretError) {
      deps.write(`${error.code}: ${error.message}\n`)
      process.exitCode = 1
      return
    }
    throw error
  }
  deps.write(`configured: ${provider}/${slot} (stored locally 0600; Hub only sees configured)\n`)
}
