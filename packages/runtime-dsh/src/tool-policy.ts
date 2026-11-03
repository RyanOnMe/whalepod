/**
 * ADR-0028 §7（RD-03c1）：机器 Run 的固定草稿工具面裁决。
 *
 * 纯函数（只读文件系统做 symlink 归一），便于单测逐名覆盖；SessionOwner 在
 * `tools/pre-execute` 里调用。返回 undefined = 无机器策略，交回既有
 * approval_required/full_access 语义。
 *
 * ADR §7 的四个条件必须同时成立才免逐次审批：
 *   1. 工具名在固定草稿面内（面外直接 deny，不产生 approval.requested）；
 *   2. 工具在 Mandate allowlist 内（面内未命中走现有 ask）；
 *   3. action class 由工具名固定（read/glob/grep = 读；write/edit = 草稿写；
 *      结果/材料通道 = 隐式读），面外能力没有对应工具名；
 *   4. 路径/资源范围落在授权根内（读=工作区 + 随 Run 下发的只读材料根；
 *      写=工作区内 `.whalepod/drafts/`）。越界一律 deny，不靠人审批兜底。
 *
 * 红线：拒绝理由只描述事实，不携带绝对路径（错误文本会进模型上下文与会话日志）。
 */
import { realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import {
  IMPLICIT_MACHINE_DRAFT_TOOLS,
  MACHINE_DRAFT_TOOL_SURFACE,
  type RunToolPolicy,
} from '@whalepod/protocol'

const SURFACE = new Set<string>(MACHINE_DRAFT_TOOL_SURFACE)
const IMPLICIT = new Set<string>(IMPLICIT_MACHINE_DRAFT_TOOLS)
const FILE_PATH_TOOLS = new Set(['read', 'write', 'edit'])
const SEARCH_TOOLS = new Set(['glob', 'grep'])
const DRAFT_WRITE_TOOLS = new Set(['write', 'edit'])
const SEARCH_PATH_ARG = 'path'
const FILE_PATH_ARG = 'file_path'

/** 机器 Run 唯一的免审批写入区（工作区相对路径）。 */
export const MACHINE_DRAFT_WRITE_SUBDIR = '.whalepod/drafts'

export interface MachineToolScope {
  /** Node 注册的 Workspace 根；相对路径按它解析（DSH 的 cwd 同值）。 */
  readonly workspacePath: string
  /**
   * 随 Run 下发的只读材料根（工作输入/项目上下文/Artifact 输入的本地副本）。
   * 不在工作区内，但属于本次 Run 的授权资料，可读不可写。
   */
  readonly readRoots?: readonly string[]
}

function canonicalRoot(root: string): string {
  try {
    return realpathSync(root)
  } catch {
    return resolve(root)
  }
}

/**
 * 目标路径的 canonical 形态。目标不存在时（write 新建文件），逐级向上找最近的
 * 已存在祖先做 realpath 再拼回剩余段——这样 `drafts/link/new.md` 里 link 指向
 * 工作区外时也会被判越界，而不是只在文件存在后才暴露。
 */
function canonicalTarget(target: string): string {
  let current = target
  const tail: string[] = []
  for (;;) {
    try {
      const real = realpathSync(current)
      return tail.length === 0 ? real : resolve(real, ...tail.reverse())
    } catch {
      const parent = dirname(current)
      if (parent === current) return resolve(target)
      tail.push(basename(current))
      current = parent
    }
  }
}

function isInsideRoot(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function pathArgument(toolName: string, args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined
  const key = SEARCH_TOOLS.has(toolName) ? SEARCH_PATH_ARG : FILE_PATH_ARG
  if (!FILE_PATH_TOOLS.has(toolName) && !SEARCH_TOOLS.has(toolName)) return undefined
  const value = (args as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : undefined
}

function literalEscape(value: string): boolean {
  return value.includes('\0') || /^[A-Za-z]:[\\/]/.test(value)
}

function resolveTarget(scope: MachineToolScope, value: string): string {
  return isAbsolute(value) ? resolve(value) : resolve(scope.workspacePath, value)
}

/**
 * 面内且命中 allowlist 之后的路径裁决。
 * 读工具：工作区 + 只读材料根；写工具：仅 `.whalepod/drafts/`。
 */
function pathScopeDecision(
  toolName: string,
  args: unknown,
  scope: MachineToolScope,
): PreToolDecision {
  const value = pathArgument(toolName, args)
  // read/write/edit 的参数必填；缺参说明调用形态不合法，fail closed。
  if (value === undefined) {
    if (SEARCH_TOOLS.has(toolName)) {
      // glob/grep 的 path 可选：缺省即在 DSH cwd（工作区根）内搜索。
      return { kind: 'allow' }
    }
    return {
      kind: 'deny',
      reason: `tool "${toolName}" requires a file_path argument for the draft tool policy`,
    }
  }
  if (value.trim().length === 0 || literalEscape(value)) {
    return {
      kind: 'deny',
      reason: `tool "${toolName}" path is not a valid workspace path`,
    }
  }
  const target = canonicalTarget(resolveTarget(scope, value))
  const workspaceRoot = canonicalRoot(scope.workspacePath)
  if (DRAFT_WRITE_TOOLS.has(toolName)) {
    const draftRoot = canonicalTarget(resolve(workspaceRoot, MACHINE_DRAFT_WRITE_SUBDIR))
    if (isInsideRoot(draftRoot, target)) return { kind: 'allow' }
    return {
      kind: 'deny',
      reason: `tool "${toolName}" can only write inside ${MACHINE_DRAFT_WRITE_SUBDIR}`,
    }
  }
  const readRoots = [workspaceRoot, ...(scope.readRoots ?? []).map(canonicalRoot)]
  if (readRoots.some((root) => isInsideRoot(root, target))) return { kind: 'allow' }
  return {
    kind: 'deny',
    reason: `tool "${toolName}" path is outside the authorized material scope`,
  }
}

export function machineDraftToolDecision(
  policy: RunToolPolicy | undefined,
  toolName: string,
  args: unknown,
  scope: MachineToolScope,
): PreToolDecision | undefined {
  if (policy === undefined) return undefined
  if (!SURFACE.has(toolName)) {
    return {
      kind: 'deny',
      reason: `tool "${toolName}" is outside the draft tool surface`,
    }
  }
  if (IMPLICIT.has(toolName)) return { kind: 'allow' }
  if (!policy.allowedToolNames.some((allowed) => allowed === toolName)) {
    return {
      kind: 'ask',
      reason: `Run tool call is outside the Mandate allowlist: ${toolName}`,
    }
  }
  return pathScopeDecision(toolName, args, scope)
}
