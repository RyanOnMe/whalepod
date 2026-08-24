#!/usr/bin/env bash
# 基线核验（07-资料与版本基线.md §6）。
# 新机器或仓库初始化时运行；输出可贴进 PR 描述。
# node/pnpm 与基线不符时退出码为 1，其余工具缺失只告警。
set -uo pipefail

fail=0

check() { # check <名称> <实际版本> <期望前缀>
  local name="$1" actual="$2" expect="$3"
  if [ -z "$actual" ]; then
    echo "MISS  $name: 未安装"
    fail=1
  elif [[ "$actual" == "$expect"* ]]; then
    echo "OK    $name: ${actual}（基线 ${expect}）"
  else
    echo "FAIL  $name: ${actual}（基线要求 ${expect}）"
    fail=1
  fi
}

node_v="$(node --version 2>/dev/null || true)"
check "node" "$node_v" "v24."

pnpm_v="$(corepack pnpm --version 2>/dev/null || pnpm --version 2>/dev/null || true)"
check "pnpm" "$pnpm_v" "11.7."

echo "---"
echo "registry 当前版本（只读参考；安装仍按 07 文档的精确版本）："
for pkg in @deepseek-ai/dsh fastify react; do
  v="$(npm view "$pkg" version 2>/dev/null || echo '查询失败')"
  echo "      $pkg: $v"
done

echo "---"
docker_v="$(docker version --format '{{.Server.Version}}' 2>/dev/null || true)"
compose_v="$(docker compose version --short 2>/dev/null || true)"
[ -n "$docker_v" ] && echo "OK    docker: $docker_v" || echo "WARN  docker: 未运行（Q9 安装门需要）"
[ -n "$compose_v" ] && echo "OK    docker compose: $compose_v" || echo "WARN  docker compose: 不可用（Q9 安装门需要）"

exit "$fail"
