/**
 * Workspace 路径边界策略（P1-12；G3-06 后半、02 Task 12 Step 1/7）。
 *
 * 约定：候选路径由调用方先做 realpath 归一（symlink 解析发生在策略之前），
 * 本模块只做边界判定——候选必须落在 workspace canonical 根内，越界一律拒绝。
 * 拒绝时不泄露外部路径细节（只返回布尔；错误信息由上层按场景构造）。
 */
import { isAbsolute, relative, resolve } from 'node:path'

/**
 * 候选路径（相对 workspace 根，或已归一的绝对路径）是否落在根内。
 * 根本身算在内（'' 相对路径）。
 */
export function isInsideWorkspace(root: string, candidate: string): boolean {
  const absolute = isAbsolute(candidate) ? resolve(candidate) : resolve(root, candidate)
  const rel = relative(root, absolute)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}
