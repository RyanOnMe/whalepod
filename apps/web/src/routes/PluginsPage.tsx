/**
 * 插件管理入口（02 Task 17 Step 7）：Admin Plugin Settings（curated catalog /
 * 安装）+ Plugin Pack 组装。权限呈现由两个特性组件按 session.role 区分
 * （Owner/Admin 可操作，Member 只读），页面本身不重复判断。
 */
import type { ReactNode } from 'react'
import { useSession } from '../app/session.js'
import { PluginSettings } from '../features/plugin/PluginSettings.js'
import { PluginPackEditor } from '../features/plugin/PluginPackEditor.js'

export function PluginsPage(): ReactNode {
  const session = useSession()
  return (
    <div className="plugins-page">
      <h1>插件管理</h1>
      <PluginSettings session={session} />
      <PluginPackEditor session={session} />
    </div>
  )
}
