# Web 生产镜像（P1-20 / Q9）：vite build 产物 + nginx。
# 单源拓扑（03 §4：Origin 逐字节相等 + Cookie Secure 分支）与 E2E 装配同形——
# 浏览器只见一个 origin；/api/v1 与 /ws/v1 由 nginx 反代到 hub（配置见 deploy/nginx.conf）。
FROM node:24-bookworm-slim AS build
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@11.7.0 --activate
COPY . .
RUN pnpm install --frozen-lockfile && pnpm --filter @project311/web... --if-present build

# stable 滚动大版本（非数字 pin：本项目把 nginx 当纯静态+反代基座，无特性依赖；
# stable 镜像自带 curl，healthcheck 直接用，不引入 busybox wget 分支）。
FROM nginx:stable
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
# 无自有 HEALTHCHECK：/healthz 经本容器反代到 hub——探针从浏览器视角走，
# 一条路径同时验「nginx 活着 + 反代配置对 + hub 活着」三件事。
