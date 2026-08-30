/**
 * publish_artifact 的桥内工作区校验（P1-15；04 §6.3 路径攻击矩阵的 Runtime 半场）。
 *
 * 语义与 apps/node 采集器一致（同一条 realpath 边界规则）：先做无 IO 的字面
 * 拒绝（绝对路径、NUL、resolve 越界），再 realpath 解析 symlink 后复验边界，
 * 最后要求常规文件且不超限。拒绝时抛 ArtifactCandidateError——工具结果失败
 * 回给模型，绝不发出 artifact.candidate 帧。
 *
 * 红线：所有拒绝消息只描述事实，绝不携带 workspace 绝对路径（错误文本会进
 * 模型上下文与团队投影）；语料镜像在 packages/runtime-dsh/tests/artifact-tool.spec.ts
 * 与 apps/node/tests/artifact-collect.spec.ts，任一侧改语义两边都会红。
 */
import { realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'

/** 03 §10 目录内错误码对应的桥内拒绝原因。 */
export type ArtifactCandidateRejectReason =
  | 'path-outside-workspace'
  | 'not-a-file'
  | 'too-large'
  | 'unreadable'

export class ArtifactCandidateError extends Error {
  constructor(
    readonly reason: ArtifactCandidateRejectReason,
    message: string,
  ) {
    super(message)
    this.name = 'ArtifactCandidateError'
  }
}

/**
 * 纯边界判定：候选（相对 workspace 根或已归一绝对路径）是否落在根内。
 * 与 apps/node/src/workspace/path-policy.ts 同语义（node 包不可被本包依赖，
 * 故此判定以同语义双实现存在，测试语料镜像防漂移）。
 */
export function isInsideWorkspaceRoot(root: string, candidate: string): boolean {
  const abs = isAbsolute(candidate) ? resolve(candidate) : resolve(root, candidate)
  const rel = relative(root, abs)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** 第一阶段单文件上限（02 Global Constraints：50 MiB = 52,428,800 字节）。 */
export const ARTIFACT_MAX_BYTES = 52_428_800

function rejectLiteralEscape(root: string, relativePath: string): void {
  if (typeof relativePath !== 'string' || relativePath.length === 0) {
    throw new ArtifactCandidateError(
      'path-outside-workspace',
      'artifact relativePath must be a non-empty workspace-relative path',
    )
  }
  if (relativePath.includes('\0')) {
    throw new ArtifactCandidateError(
      'path-outside-workspace',
      'artifact relativePath contains NUL and cannot address a workspace file',
    )
  }
  // 平台 isAbsolute 之外再挡 Windows 盘符形（跨平台 Node 的字面逃逸形态）。
  if (isAbsolute(relativePath) || /^[A-Za-z]:[\\/]/.test(relativePath)) {
    throw new ArtifactCandidateError(
      'path-outside-workspace',
      'artifact relativePath must be workspace-relative, not absolute',
    )
  }
  if (!isInsideWorkspaceRoot(root, relativePath)) {
    throw new ArtifactCandidateError(
      'path-outside-workspace',
      'artifact relativePath escapes the workspace boundary',
    )
  }
}

export interface WorkspaceArtifactValidatorOptions {
  readonly workspacePath: string
  readonly maxBytes?: number
}

/** 桥内校验器（同步 fs：工具 execute 内联调用）。 */
export interface WorkspaceArtifactValidator {
  validate(candidate: { readonly relativePath: string }): void
}

export function createWorkspaceArtifactValidator(
  options: WorkspaceArtifactValidatorOptions,
): WorkspaceArtifactValidator {
  // 根先做一次 canonical（macOS /var → /private/var 类 symlink 根会让
  // 「候选 canonical 落在根内」误判越界；Node 传入的 workspacePath 通常已是
  // realpath（registry.resolve），这里兜底再归一）。根缺失时保留原值——候选
  // 校验会在 realpath 一步以 unreadable 失败。
  let root = options.workspacePath
  try {
    root = realpathSync(options.workspacePath)
  } catch {
    // 保持原路径；所有候选将在第 2 步失败（workspace 不存在=无候选可发布）。
  }
  const maxBytes = options.maxBytes ?? ARTIFACT_MAX_BYTES
  return {
    validate({ relativePath }) {
      // 1) 字面拒绝：不触 IO 就能定的越界形态。
      rejectLiteralEscape(root, relativePath)
      // 2) symlink 解析后复验边界（canonical 被采用，G3-06 同语义）。
      let canonical: string
      try {
        canonical = realpathSync(resolve(root, relativePath))
      } catch {
        throw new ArtifactCandidateError(
          'unreadable',
          'artifact candidate file does not exist inside the workspace',
        )
      }
      if (!isInsideWorkspaceRoot(root, canonical)) {
        throw new ArtifactCandidateError(
          'path-outside-workspace',
          'artifact candidate resolves outside the workspace boundary',
        )
      }
      // 3) 常规文件 + 大小上限。
      let stats: ReturnType<typeof statSync>
      try {
        stats = statSync(canonical)
      } catch {
        throw new ArtifactCandidateError('unreadable', 'artifact candidate file is not readable')
      }
      if (!stats.isFile()) {
        throw new ArtifactCandidateError('not-a-file', 'artifact candidate must be a regular file')
      }
      if (stats.size > maxBytes) {
        throw new ArtifactCandidateError(
          'too-large',
          `artifact candidate exceeds the ${maxBytes} byte limit`,
        )
      }
    },
  }
}
