/**
 * #183 判据：`@whalepod/hub/testing` 在 vitest 面必须解析到 **hub 的 src**。
 *
 * 为什么这条契约对 node 是硬需求：node 的 integration spec 里同时存在 hub src 的
 * 深模块相对 import（`vi.spyOn(nodeConnections, 'attach')` 观测的就是那个实例），
 * 而 app 由 `createTestApp` 建。若本子路径退回 `dist`，同进程会出现**两套 hub 模块
 * 实例**（src 一份、dist 一份）——评审实测：去掉 `development` 条件后
 * `cli-hello-refresh` 的组合根用例以 30s 超时红（spy 盯 src 实例、派发落在 dist
 * 实例上），恢复后 1.1s 绿。
 *
 * 放在 apps/node 而不是 scripts/tests：这条契约的消费者就是本应用（scripts/ 未声明
 * `@whalepod/hub`，从那里解析不到；`@whalepod/hub/testing` 的类型面来自 dist 声明、
 * 运行面来自 src，两侧绑定见 acceptance 文档的边界节）。
 */
import { describe, expect, it } from 'vitest'

describe('#183 hub 测试脚手架的解析面（dist/src 双实例是硬伤）', () => {
  it('@whalepod/hub/testing 解析到 src，且真实可加载（createTestApp 在）', async () => {
    const resolved = import.meta.resolve('@whalepod/hub/testing')
    expect(resolved, resolved).toMatch(/\/apps\/hub\/src\/testing\/index\.ts$/)
    const hubTesting = (await import('@whalepod/hub/testing')) as { createTestApp?: unknown }
    expect(typeof hubTesting.createTestApp).toBe('function')
  })
})
