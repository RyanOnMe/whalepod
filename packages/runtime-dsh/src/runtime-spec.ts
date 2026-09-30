/**
 * RuntimeSpec —— `runtime.initialize` 命令载荷的桥内形态（03 §7.1）。
 *
 * profileDigest/pluginPackDigest 在 P1-11 仅随 wire 到达并记录；P1-17 起新增
 * `pluginPackOverlayPath`：Node preflight 为已安装 Plugin Pack 生成的 Cordis
 * overlay yml 绝对路径（本地 wire 专用，红线同 workspacePath——不进 Hub、日志
 * 与 evidence），RuntimeBridge.start 把它作为最后一层 patch 挂进 boot 栈
 * （bridge.ts）。pack 为 core-empty 时不携带（wire optional）。
 */
import type { RuntimeArtifactInput, RuntimeCommand } from '@whalepod/protocol'

export interface RuntimeSpec {
  readonly runId: string
  readonly workspacePath: string
  readonly dshHomePath: string
  readonly profileDigest: string
  readonly pluginPackDigest: string
  /** 本 Run 的 Plugin Pack overlay yml 绝对路径；core-empty pack / 契约探针缺省。 */
  readonly pluginPackOverlayPath?: string
  readonly provider: string
  readonly model: string
  readonly maxTokens?: number
  readonly persona: string
  /**
   * P1-15：Reviewer Run 的只读 Artifact 输入清单（03 §7.1 扩展）。
   * 清单与 `artifactInputsDir`（Node 下载副本目录，本地 wire 绝对路径——红线
   * 同 workspacePath）必须成对出现；Builder Run（无输入）两者缺省。
   */
  readonly artifactInputs?: readonly RuntimeArtifactInput[]
  readonly artifactInputsDir?: string
  /**
   * ADR-0009 切片⑤（resume 续跑）的装载身份：携带时 Runtime 用
   * ctx.agents.resume 续既有会话（persisted load），而不是新建 session。
   * 它必须配合 dshHomePath 指向来源 Run 的 home（Node 侧保证）——否则存储
   * 日志不在本机，装载会退化/失败（bridge 的身份校验 fail loud）。
   */
  readonly resumeSessionId?: string
  /**
   * ADR-0009 切片⑧（审批档位，#241）：本 Run 的工具授权姿态。缺省 =
   * approval_required（ask-all，现状语义）；full_access 时 SessionOwner 的
   * pre-execute 直接放行，不发 approval.requested。值由 Hub 解析固化后经
   * initialize 下发，Runtime 不自行判断。
   */
  readonly approvalPolicy?: 'approval_required' | 'full_access'
}

type InitializeCommand = Extract<RuntimeCommand, { type: 'runtime.initialize' }>

export function runtimeSpecFromInitialize(command: InitializeCommand): RuntimeSpec {
  const {
    maxTokens,
    pluginPackOverlayPath,
    artifactInputs,
    artifactInputsDir,
    resumeSessionId,
    approvalPolicy,
    ...rest
  } = command.payload
  // exactOptionalPropertyTypes：zod 的 optional 产出 `number | undefined`，
  // 桥内形态要求键存在即有效值。
  return {
    ...rest,
    ...(maxTokens === undefined ? {} : { maxTokens }),
    ...(pluginPackOverlayPath === undefined ? {} : { pluginPackOverlayPath }),
    ...(artifactInputs === undefined ? {} : { artifactInputs }),
    ...(artifactInputsDir === undefined ? {} : { artifactInputsDir }),
    ...(resumeSessionId === undefined ? {} : { resumeSessionId }),
    ...(approvalPolicy === undefined ? {} : { approvalPolicy }),
  }
}

/** 本 Run 的 DSH Session 身份：`runId + dshSessionId` 关联的桥侧锚点（03 §8）。 */
export function dshSessionIdOf(spec: RuntimeSpec): string {
  return `whalepod-run-${spec.runId}`
}
