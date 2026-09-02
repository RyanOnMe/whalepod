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
  docker ps -q --filter "label=project311.e2e-postgres=true" 2>/dev/null \
    | xargs -r docker rm -f >/dev/null 2>&1 || true
}

pass=0
for i in $(seq 1 "$N"); do
  cleanup_stale
  if pnpm test:e2e > "/tmp/q5-run-$i.log" 2>&1; then
    pass=$((pass + 1))
    echo "run $i/$N: PASS"
  else
    echo "run $i/$N: FAIL —— 见 /tmp/q5-run-$i.log"
    tail -25 "/tmp/q5-run-$i.log"
    exit 1
  fi
done
echo "Q5 全绿：$pass/$N 连续通过"
