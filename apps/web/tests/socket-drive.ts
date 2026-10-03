/**
 * 帧推手（#261 抽自 connection-banner.spec.tsx 的局部写法）：替换 socket 工厂、
 * 捕获 RealtimeBridge 组装的回调，让用例能手动推真实帧。
 *
 * **必须在 render 之前调用**：bridge 的连接只在挂载时建一次，render 之后再换
 * 工厂拿不到回调。返回的代理在 bridge 尚未挂载时直接抛错，用例不会静默推给空气。
 */
import { setRealtimeSocketFactoryForTest } from '../src/app/realtime.js'
import type { TeamEventSocketCallbacks } from '../src/shared/realtime/socket.js'

export function installFrameSink(): TeamEventSocketCallbacks {
  let captured: TeamEventSocketCallbacks | undefined
  setRealtimeSocketFactoryForTest((_url, _cursorStore, callbacks) => {
    captured = callbacks
    return { connect: () => undefined, close: () => undefined }
  })
  return new Proxy({} as TeamEventSocketCallbacks, {
    get: (_target, prop: string) => {
      const sink = captured
      if (sink === undefined) throw new Error('RealtimeBridge 尚未挂载，没有回调可推')
      return sink[prop as keyof TeamEventSocketCallbacks]
    },
  })
}
