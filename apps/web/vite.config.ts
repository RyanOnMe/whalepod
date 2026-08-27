import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// apps/web 是纯浏览器 SPA：产物 dist/。开发与 e2e 场景下 dev server 把 /api/v1
// 与 /ws/v1 反代到 Hub，浏览器侧保持同源（Cookie 与 Origin 校验由 Hub 负责，03 §4）；
// 生产部署由反向代理完成同一件事。Hub 地址经 PROJECT311_HUB_ORIGIN 注入，
// 缺省为本机 18080（scripts/e2e-serve.mts 的约定端口）。
const hubOrigin = process.env.PROJECT311_HUB_ORIGIN ?? 'http://127.0.0.1:18080'

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api/v1': { target: hubOrigin, changeOrigin: false },
      '/ws/v1': { target: hubOrigin, ws: true, changeOrigin: false },
    },
  },
})
