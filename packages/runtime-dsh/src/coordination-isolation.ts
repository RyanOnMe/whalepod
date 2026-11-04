/** Router worker has no socket capability. The trusted broker owns provider I/O. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

const LINUX_FILTER = `import ctypes, ctypes.util, errno, os, sys
try:
    lib = ctypes.CDLL(ctypes.util.find_library('seccomp') or 'libseccomp.so.2', use_errno=True)
    lib.seccomp_init.argtypes = [ctypes.c_uint32]
    lib.seccomp_init.restype = ctypes.c_void_p
    lib.seccomp_syscall_resolve_name.argtypes = [ctypes.c_char_p]
    lib.seccomp_syscall_resolve_name.restype = ctypes.c_int
    lib.seccomp_rule_add.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int, ctypes.c_uint]
    lib.seccomp_load.argtypes = [ctypes.c_void_p]
    lib.seccomp_release.argtypes = [ctypes.c_void_p]
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(38, 1, 0, 0, 0) != 0:
        raise RuntimeError('no_new_privs')
    ctx = lib.seccomp_init(0x7fff0000)
    if not ctx:
        raise RuntimeError('seccomp_init')
    for name in [b'socket', b'socketpair']:
        syscall = lib.seccomp_syscall_resolve_name(name)
        if syscall < 0 or lib.seccomp_rule_add(ctx, 0x00050000 | errno.EPERM, syscall, 0) != 0:
            raise RuntimeError('seccomp_rule')
    if lib.seccomp_load(ctx) != 0:
        raise RuntimeError('seccomp_load')
    lib.seccomp_release(ctx)
    os.execv(sys.argv[1], sys.argv[1:])
except Exception:
    sys.stderr.write('coordination isolation_unavailable\\n')
    sys.exit(126)
`

export function coordinationSandboxCommand(
  platform: NodeJS.Platform,
  nodeExecutable: string,
  args: readonly string[],
): { file: string; args: string[] } {
  if (platform === 'darwin') {
    return {
      file: '/usr/bin/sandbox-exec',
      args: ['-p', '(version 1)(allow default)(deny network*)', nodeExecutable, ...args],
    }
  }
  if (platform === 'linux') {
    return { file: 'python3', args: ['-c', LINUX_FILTER, nodeExecutable, ...args] }
  }
  throw new Error('isolation_unavailable')
}

export function coordinationWorkerEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {}
  for (const name of ['PATH', 'LANG', 'LC_ALL'] as const) {
    if (source[name] !== undefined) environment[name] = source[name]
  }
  return environment
}

export function spawnCoordinationWorker(
  args: readonly string[],
  sourceEnvironment: NodeJS.ProcessEnv = process.env,
  cwd?: string,
): ChildProcessWithoutNullStreams {
  const command = coordinationSandboxCommand(process.platform, process.execPath, args)
  return spawn(command.file, command.args, {
    env: coordinationWorkerEnvironment(sourceEnvironment),
    ...(cwd === undefined ? {} : { cwd }),
    stdio: ['pipe', 'pipe', 'pipe'],
  })
}

/** Same kernel policy as the real worker; ECONNREFUSED is deliberately not proof. */
export async function probeCoordinationIsolation(): Promise<boolean> {
  const probe = `const net=require('node:net');
let remaining=2, denied=0;
for(const host of ['127.0.0.1','::1']) {
 const socket=net.connect({host,port:9});
 socket.once('error',error=>{if(['EPERM','EACCES'].includes(error.code)) denied++; if(--remaining===0) process.exit(denied===2?0:1)});
 socket.once('connect',()=>process.exit(1));
}
setTimeout(()=>process.exit(1),1500);`
  try {
    const child = spawnCoordinationWorker(['--no-warnings', '--permission', '-e', probe])
    return await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        resolve(false)
      }, 3000)
      child.stdout.resume()
      child.stderr.resume()
      child.once('error', () => {
        clearTimeout(timer)
        resolve(false)
      })
      child.once('close', (code) => {
        clearTimeout(timer)
        resolve(code === 0)
      })
      child.stdin.end()
    })
  } catch {
    return false
  }
}
