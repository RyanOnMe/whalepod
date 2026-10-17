#!/usr/bin/env bash
# 开发机残留自检（#305）：测试为**负向判据**故意留活的探针进程、被杀一半的自家子进程，
# 不许在长期存在的开发机上累积（CI 是一次性 runner，进程随 job 消失——「CI 全绿」不是
# 这类泄漏的反证，本机 ps 才是）。#305 起 recovery.spec 的负向用例自回收；本脚本是
# 可复跑的自检面：跑完 Q0/Q6（或任一 unit/resilience 面）后跑它，应零残留。
#
# 判定分两档（诚实分界，避免把"开发机上正常在跑的东西"当残留）：
#   1. **测试探针**（argv 形如 `-e 'setInterval(...)' -- --run-id <id> --nonce <id>` 或
#      `--run-id` 探针）——只可能来自测试驱动，命中即 FAIL（退出码 1）；
#   2. 其余自家进程（whalepod-node / whalepod-runtime / e2e-serve 等）——可能正在被
#      开发者正常使用（例如手工跑的 Node + 正在执行的 Run），只**列出**为提示，
#      非零退出由 `--strict` 触发（发布前清理用）。
#
# 用法：
#   scripts/check-stray-runtimes.sh              # 实扫：探针残留即非零退出
#   scripts/check-stray-runtimes.sh --strict     # 再把自家进程也当残留（发布前清单）
#   scripts/check-stray-runtimes.sh --self-test  # 判定力自检：造一个假探针必须判中
set -uo pipefail

# 探针判据：测试驱动的进程形状（argv 带 --run-id/--nonce 且是 -e 脚本或 whalepod 入口）。
probe_re='-e setInterval.*--run-id|---run-id.*--nonce'
# 自家进程（提示面）：Node CLI 与 Runtime 子进程、E2E 服务。
self_re='whalepod-node|whalepod-runtime|apps/node/src/cli\.ts|apps/hub/src/server\.ts|apps/runtime/(src|dist)/bin\.(ts|js)|scripts/e2e-serve\.mts'

scan() {
  # 输出命中的进程行（无命中即空）。用 ps 全量 argv（-ww 防截断），排除本脚本自身与 grep。
  ps -eo pid=,command= 2>/dev/null \
    | grep -Ev "check-stray-runtimes|grep -" \
    | grep -E "$1" || true
}

self_test() {
  # 判定力自检：先造一个与 recovery.spec 同形的假探针（真进程），必须判中；清掉后必须判空。
  local fake_pid out rc=0
  node -e 'setInterval(() => {}, 1000)' -- --run-id r-self-test --nonce nonce-self-test &
  fake_pid=$!
  sleep 0.3
  out="$(scan "$probe_re")"
  if ! printf '%s' "$out" | grep -q "r-self-test"; then
    echo "FAIL  自检：造的假探针未被判中（判定力退化）：${out:-（空）}" >&2
    rc=1
  fi
  kill "$fake_pid" 2>/dev/null
  wait "$fake_pid" 2>/dev/null
  if printf '%s' "$(scan "$probe_re")" | grep -q "r-self-test"; then
    echo "FAIL  自检：假探针回收后仍被列出（收尾失效）" >&2
    rc=1
  fi
  if [ "$rc" -eq 0 ]; then
    echo "PASS  check-stray-runtimes 自检：假探针判中、回收后判空"
  else
    echo "FAIL  check-stray-runtimes 自检：判定力退化，禁止当作收尾判据" >&2
  fi
  exit "$rc"
}

[ "${1:-}" = "--self-test" ] && self_test

strict=0
[ "${1:-}" = "--strict" ] && strict=1

fail=0
probes="$(scan "$probe_re")"
if [ -n "$probes" ]; then
  echo "FAIL  发现测试探针残留（#305：负向用例必须自回收）："
  printf '%s\n' "$probes" | sed 's/^/      /'
  fail=1
else
  echo "OK    无测试探针残留"
fi

others="$(scan "$self_re")"
if [ -n "$others" ]; then
  if [ "$strict" -eq 1 ]; then
    echo "FAIL  发现自家 Node/Runtime/E2E 进程（--strict）："
    fail=1
  else
    echo "INFO  以下自家进程在跑（可能是你在用的实例；发布前清理用 --strict 复核）："
  fi
  printf '%s\n' "$others" | sed 's/^/      /'
else
  echo "OK    无自家 Node/Runtime/E2E 进程"
fi

exit "$fail"
