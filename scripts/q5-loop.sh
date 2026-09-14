#!/usr/bin/env bash
# Q5 浏览器门（P1-19 / Issue #23）：连续 N（默认 20）次完整 `pnpm test:e2e`。
# 04 矩阵口径「连续 20 次无偶发」。注意：Playwright `--repeat-each` 会在同一
# 环境里多副本重放，而本环境是「一个 Hub 一个团队一次 Setup」的产品模型（不可
# 多团队），副本互踩属架构不兼容——循环整跑（每次冷启新 Postgres/Hub/vite）才
# 是诚实口径，且每轮还多验一次环境冷启动路径。
#
# 用法：bash scripts/q5-loop.sh [次数]；fail-fast：任何一轮红即退出非零。
set -u
N="${1:-20}"
cd "$(dirname "$0")/.."

cleanup_stale() {
  # 上一轮异常中断的残留（精确判据 kill；绝不用 pkill -f——会误杀携带路径字样的父 shell）。
  for p in $(pgrep -f "scripts/e2e-serve.mts" 2>/dev/null || true); do
    args=$(ps -p "$p" -o args= 2>/dev/null || true)
    case "$args" in
      *node*"--import tsx scripts/e2e-serve.mts"*) kill -9 "$p" 2>/dev/null || true ;;
    esac
  done
  for p in $(pgrep -f "scripts/e2e-node.mts" 2>/dev/null || true); do
    args=$(ps -p "$p" -o args= 2>/dev/null || true)
    case "$args" in
      *node*"scripts/e2e-node.mts"*) kill -9 "$p" 2>/dev/null || true ;;
    esac
  done
  # `-v` 必带（#188）：postgres 镜像声明了匿名 VOLUME（PG18 起挂在 /var/lib/postgresql），
  # `docker rm -f` 默认不回收它，每次残留就是永久 ~40 MB。Q5 x20 是历史上 1332 个孤儿卷的主产地。
  #
  # `status=exited` 也是必须的（#188 评审 B1）：本脚本按**共用标签**筛（算不出别的 worktree
  # 的 scope 哈希），不加这条会把**兄弟 worktree 正在用**的活容器连同匿名卷一起删掉
  #（评审逐字复刻验证过）。只清已退出的残留；仍在跑的残留由各运行自己的 pid 感知清扫负责。
  docker ps -q --filter "label=whalepod.e2e-postgres=true" --filter "status=exited" 2>/dev/null \
    | xargs -r docker rm -f -v >/dev/null 2>&1 || true
}

mkdir -p artifacts/q5
pass=0
for i in $(seq 1 "$N"); do
  cleanup_stale
  if pnpm test:e2e > "artifacts/q5/run-$i.log" 2>&1; then
    pass=$((pass + 1))
    echo "run $i/$N: PASS"
  else
    echo "run $i/$N: FAIL —— 见 artifacts/q5/run-$i.log"
    tail -25 "artifacts/q5/run-$i.log"
    exit 1
  fi
done
echo "Q5 全绿：$pass/$N 连续通过"
