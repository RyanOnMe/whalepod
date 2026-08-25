import { defineConfig } from 'drizzle-kit'

// 迁移文件当前为手写 SQL（migrations/0001_phase1.sql），与 src/schema 保持一致；
// 演进时以 drizzle-kit generate 产 diff，再人工核对约束是否齐全。
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './migrations',
})
