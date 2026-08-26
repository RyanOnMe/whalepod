import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// apps/web 是纯浏览器 SPA：产物 dist/。Hub 同源部署时走同一
// TABTIN_PUBLIC_ORIGIN（Origin 校验由 Hub 中间件负责，03 §4）。
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
