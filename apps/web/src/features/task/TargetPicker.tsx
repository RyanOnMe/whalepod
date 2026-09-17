/**
 * 执行目标条（切片⑥c；ADR-0010 决策 3 + ③c-2b 的三段式解析）。
 *
 * 它回答一个执行区必须回答的问题：**这句话会在哪里跑**。三种来源要分得清：
 *   沿用上一轮 —— 该 Task 上一个 Run 用过的设备/工作区（Hub 侧解析的第一优先级）；
 *   自动选     —— 责任人的最近在线设备 + 可用工作区（第二优先级）；
 *   显式指定   —— 用户在下面亲手选的（覆盖上面两级，被选中的那个会被记住）。
 * 三种都解析不到时 Hub 会**明确拒绝**（409 `DEVICE_OFFLINE`），不猜——所以这里也提供"回到自动"。
 *
 * 两条权限事实塑造了这个组件的形态（不是偷懒）：
 *   ① `GET /devices` 是 `listOwnDevices(actor.userId)`——**只列自己的设备**；而执行**永远用
 *      责任人的设备与凭据**（③c-2b 红线）。所以选择器**只对责任人呈现**；被授权成员看到的是
 *      只读说明（"执行会在责任人的设备上进行，由 Hub 自动解析"），而不是一个空下拉。
 *   ② 因此 `deviceId`/`workspaceId` 只在**显式指定**时才随指令发出；否则不发，交给 Hub 三段式解析
 *      （发了就等于把"自动"变成"钉死某台机器"）。
 */
import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { api } from '../../shared/api/client.js'
import { queryKeys } from '../../app/query-client.js'
import { SelectMenu } from '../../shared/SelectMenu.js'
import type { DeviceView, WorkspaceView } from '../../shared/api/types.js'

/** 显式目标：两个字段要么都给，要么都不给（Hub 侧 workspaceId 会推导设备，见 ③c-2b）。 */
export interface ExplicitTarget {
  deviceId: string
  workspaceId: string
}

export interface TargetPickerProps {
  /** 当前 Task 的责任人——决定"我能不能选目标"。 */
  isAssignee: boolean
  /** 显式目标；`null` 表示走自动解析。 */
  value: ExplicitTarget | null
  onChange: (next: ExplicitTarget | null) => void
  /** 名单里被授权成员的人名（只读说明里要说清"谁来跑"）。 */
  assigneeName: string
}

export function TargetPicker({
  isAssignee,
  value,
  onChange,
  assigneeName,
}: TargetPickerProps): ReactNode {
  // 只对责任人发请求：被授权成员本来就不该看到（也看不到）别人的设备。
  const devicesQuery = useQuery({
    queryKey: queryKeys.devices,
    queryFn: () => api.get<DeviceView[]>('/devices'),
    enabled: isAssignee,
  })
  const workspacesQuery = useQuery({
    queryKey: queryKeys.workspaces,
    queryFn: () => api.get<WorkspaceView[]>('/workspaces'),
    enabled: isAssignee,
  })

  if (!isAssignee) {
    return (
      <p className="target-note" data-testid="target-readonly">
        执行会在<b>{assigneeName}</b>的设备上进行，由 Hub 自动解析（沿用上一轮 → 他的在线设备）。要
        换目标请找责任人。
      </p>
    )
  }

  const devices = (devicesQuery.data ?? []).filter((device) => device.status === 'online')
  const workspaces = (workspacesQuery.data ?? []).filter(
    (ws) => ws.deviceId === (value?.deviceId ?? '') && ws.available,
  )

  if (value === null) {
    return (
      <div className="target-bar" data-testid="target-bar">
        <span className="target-mode" data-testid="target-mode">
          自动选
        </span>
        <span className="target-note">沿用上一轮的设备与工作区；没有就用你的在线设备。</span>
        <div className="target-actions">
          <SelectMenu
            id="target-device"
            label="指定设备"
            value=""
            placeholder={devices.length === 0 ? '没有在线设备' : '选择设备…'}
            options={devices.map((device) => ({
              value: device.id,
              label: device.name,
              disabled: false,
            }))}
            onChange={(deviceId) => onChange({ deviceId, workspaceId: '' })}
          />
        </div>
      </div>
    )
  }

  return (
    <div className="target-bar" data-testid="target-bar">
      <span className="target-mode target-mode-explicit" data-testid="target-mode">
        显式指定
      </span>
      <SelectMenu
        id="target-device"
        label="设备"
        value={value.deviceId}
        placeholder="选择设备…"
        options={devices.map((device) => ({
          value: device.id,
          label: device.name,
          disabled: false,
        }))}
        onChange={(deviceId) => onChange({ deviceId, workspaceId: '' })}
      />
      <SelectMenu
        id="target-workspace"
        label="工作区"
        value={value.workspaceId}
        placeholder={workspaces.length === 0 ? '这台设备没有可用工作区' : '选择工作区…'}
        options={workspaces.map((ws) => ({
          value: ws.workspaceId,
          label: ws.name,
          disabled: false,
        }))}
        onChange={(workspaceId) => onChange({ ...value, workspaceId })}
      />
      <button
        type="button"
        className="button target-reset"
        data-testid="target-reset"
        onClick={() => onChange(null)}
      >
        回到自动
      </button>
    </div>
  )
}
