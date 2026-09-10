/**
 * Device 状态入口（02 Task 7 Step 5）：Task 9 之前显示「尚未配对」空态与
 * CLI 安装说明。不请求 /devices（配对路由属 P1-09），也不伪造 online 设备。
 */
import type { ReactNode } from 'react'

export function DevicesPage(): ReactNode {
  return (
    <div className="devices-page">
      <h1>设备</h1>
      <section className="card devices-empty" aria-labelledby="devices-empty-heading">
        <h2 id="devices-empty-heading">尚未配对任何设备</h2>
        <p className="empty-state">
          成员在本机运行 whalepod-node 完成配对后，设备会出现在这里（配对流程随后续版本提供）。
        </p>
        <h3>CLI 安装与配对</h3>
        <ol className="cli-steps">
          <li>
            在成员本机安装 CLI：
            <pre>
              <code>npm install -g whalepod-node</code>
            </pre>
          </li>
          <li>
            在团队 Hub 上生成一次性配对码（后续版本提供）后：
            <pre>
              <code>whalepod-node pair --hub &lt;hub-url&gt; --code &lt;code&gt;</code>
            </pre>
          </li>
          <li>
            启动节点守护进程：
            <pre>
              <code>whalepod-node start</code>
            </pre>
          </li>
        </ol>
        <p className="field-hint">配对码 10 分钟过期且只能使用一次；设备凭据只保存在成员本机。</p>
      </section>
    </div>
  )
}
