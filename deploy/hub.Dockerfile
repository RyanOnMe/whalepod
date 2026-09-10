# Hub 生产镜像（P1-20 / Q9）。
# 设计约束（每条都有本轮的实测事故为证）：
# 1. monorepo 产物必须自足：workspace 包经 `pnpm deploy --legacy --prod` 实体化。
#    不用 inject-workspace-packages 全局改法（会伤开发期符号链接热链）。
# 2. **migrations 必须由镜像显式拷入**：packages/db 的 `files=['dist']` 把
#    `migrations/*.sql` 剪掉，而 migrate.ts 以 `dist/../migrations` 解析——
#    deploy 预检实测产物里零 .sql（#97 同族：workspace 内成立 ≠ 打包后成立）。
#    不改 db 包的 files（发布面声明不是部署面的应急通道）。
# 3. 入口是构建产物 dist/server.js（#95 教训：入口必须被生产方式执行，compose
#    就是它的组合根；server 启动自带迁移应用，见 server-coldboot 测）。
# 4. 非 root 运行；可写面只有 /data（setup token + artifact store 卷）。
FROM node:24-bookworm-slim AS build
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@11.7.0 --activate
COPY . .
RUN pnpm install --frozen-lockfile && pnpm -r --if-present build
RUN pnpm deploy --legacy --filter @whalepod/hub --prod /deploy/hub

FROM node:24-bookworm-slim
RUN useradd -r -u 10001 whalepod
WORKDIR /app
COPY --from=build --chown=whalepod:whalepod /deploy/hub /app
# 见头部约束 2：迁移目录实体随镜像走（路径必须落在 @whalepod/db 的 dist 同级）。
COPY --from=build --chown=whalepod:whalepod /repo/packages/db/migrations /app/node_modules/@whalepod/db/migrations
# curated 插件 catalog（只读随镜像；缺目录 = 安装面关闭 + 启动告警，见 app.ts）。
COPY --from=build /repo/plugins /app/plugins
RUN mkdir -p /data && chown whalepod:whalepod /data
USER whalepod
ENV NODE_ENV=production \
    WHALEPOD_SETUP_TOKEN_PATH=/data/setup-token \
    WHALEPOD_ARTIFACT_STORE_DIR=/data/artifact-store \
    WHALEPOD_PLUGIN_CATALOG_DIR=/app/plugins/catalog \
    HOST=0.0.0.0 PORT=8080
EXPOSE 8080
# 无 HEALTHCHECK：编排层（compose）经 nginx 从浏览器视角探活，探针单一来源 /healthz。
CMD ["node", "dist/server.js"]
