/**
 * Workspace path-policy 单测（P1-12；G3-06 后半、02 Task 12 Step 1）。
 *
 * 判定基线：工具可操作的路径必须落在 workspace canonical 路径内；
 * 越界（../ 逃逸、绝对路径越界、symlink 归一后越界）一律拒绝，不泄露外部路径。
 */
import { describe, expect, it } from 'vitest'
import { isInsideWorkspace } from '../src/workspace/path-policy.js'

const ROOT = '/private/tmp/wp-ws/project'

describe('isInsideWorkspace', () => {
  it('canonical 路径内的相对候选通过', () => {
    expect(isInsideWorkspace(ROOT, 'src/index.ts')).toBe(true)
    expect(isInsideWorkspace(ROOT, '.')).toBe(true)
    expect(isInsideWorkspace(ROOT, 'a/b/c.txt')).toBe(true)
  })

  it('.. 逃逸被拒绝', () => {
    expect(isInsideWorkspace(ROOT, '../outside.txt')).toBe(false)
    expect(isInsideWorkspace(ROOT, 'a/../../outside.txt')).toBe(false)
  })

  it('绝对路径越界被拒绝；恰好等于根或根内绝对路径通过', () => {
    expect(isInsideWorkspace(ROOT, '/etc/passwd')).toBe(false)
    expect(isInsideWorkspace(ROOT, '/private/tmp/wp-ws/other/file')).toBe(false)
    expect(isInsideWorkspace(ROOT, '/private/tmp/wp-ws/project/file')).toBe(true)
  })

  it('前缀相似但非同目录被拒绝（/project-evil 不算 /project 内）', () => {
    expect(isInsideWorkspace(ROOT, '/private/tmp/wp-ws/project-evil/file')).toBe(false)
  })

  it('symlink 归一后越界被拒绝（策略输入已是 realpath）', () => {
    // 调用方约定：候选路径先过 realpath 再进策略；策略只做边界判定。
    expect(isInsideWorkspace(ROOT, '/private/other/place')).toBe(false)
  })
})
