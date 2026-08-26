/**
 * 浏览器入口：组装 QueryClient + react-router（root loader 先行），挂到 #root。
 * Hub 同源部署，不配置代理；开发时可经 Vite 反代到 Hub（P1-13 组合时接线）。
 */
import { QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from 'react-router'
import { makeQueryClient } from './app/query-client.js'
import { createAppRouter } from './app/router.js'
import './styles/global.css'

const queryClient = makeQueryClient()
const router = createAppRouter(queryClient)

const rootElement = document.getElementById('root')
if (rootElement === null) throw new Error('missing #root element')

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
)
