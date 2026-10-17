#!/usr/bin/env bash
# 开发机残留自检（#305）：测试为**负向判据**故意留活的探针进程、被杀一半的自家子进程，
# 不许在长期存在的开发机上累积（CI 是一次性 runner，进程随 job 消失——「CI 全绿」不是
# 这类泄漏的反证，本机 ps 才是）。#305 起 recovery.spec 的负向用例自回收；本脚本是
# 可复跑的自检面：跑完 Q0/Q1/Q6/Q5（或任一 unit/resilience 面）后跑它，应零残留。
#
# 分类规则（先判自家、再判探针——顺序是判据的一部分）：
#   1. **自家进程**（`self_re`：apps/* 的 cli/bin、whalepod-node/runtime、e2e-serve 等）：
#      可供开发者正当使用（手工起的 Node、**正在执行的 Run**——生产 Runtime 的 argv 就是
#      `node <entry> -- --run-id <uuid> --nonce <uuid> --prompt-stdin`，与某些探针同形）。
#      默认档只列 INFO；`--strict` 才当残留（发布前清理）。
#   2. **测试探针**（带 `-e setInterval` 的探针，或带 `--run-id/--nonce` 且**不在**自家
#      入口里的进程）：只可能来自测试驱动，命中即 FAIL（退出码 1）。
#
# 用法：
#   scripts/check-stray-runtimes.sh              # 实扫：探针残留即非零退出
#   scripts/check-stray-runtimes.sh --strict     # 再把自家进程也当残留（发布前清单）
#   scripts/check-stray-runtimes.sh --self-test  # 判定力自检：假的真探针/真 Run 形状都要判对
set -uo pipefail

# 自家进程（自家入口面）。
self_re='whalepod-node|whalepod-runtime|apps/node/(src/cli\.ts|dist/cli\.js)|node_modules/@whalepod/node/dist/cli\.js|apps/hub/src/server\.ts|apps/runtime/(src|dist)/bin\.(ts|js)|scripts/e2e-serve\.mts'
# 测试探针候选（见头注：自家入口里同形 argv 由分类顺序挡掉）。
probe_re='-e setInterval.*--run-id|--run-id.*--nonce|--nonce.*--run-id'

# 单行 argv → probe | self | none（自家优先）。
classify() {
  if printf '%s' "$1" | grep -Eq -e "$self_re"; then echo self; return; fi
  if printf '%s' "$1" | grep -Eq -e "$probe_re"; then echo probe; return; fi
  echo none
}

ps_lines() {
  # `ps -ww` 拿全量 argv（防列宽截断），排除本脚本自身与 grep。
  ps -ww -eo pid=,command= 2>/dev/null | grep -Ev "check-stray-runtimes|grep -" || true
}

collect() { # collect <class>：把该类别的行打到 stdout
  local wanted="$1" line
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    [ "$(classify "$line")" = "$wanted" ] && printf '%s\n' "$line"
  done < <(ps_lines)
}

self_test() {
  # ① 分类规则的合成行断言（不依赖进程：判的是"一行 argv 该归哪档"）。
  local rc=0 line want got
  while IFS='|' read -r want line; do
    got="$(classify "$line")"
    if [ "$got" != "$want" ]; then
      echo "FAIL  自检分类：期望 ${want}、实得 ${got}：「${line}」" >&2
      rc=1
    fi
  done <<'CASES'
self|/usr/bin/node /repo/apps/runtime/dist/bin.js -- --run-id 11111111-1111-4111-8111-111111111111 --nonce n-1 --prompt-stdin
self|/usr/bin/node /repo/apps/node/src/cli.ts start
probe|/usr/bin/node -e setInterval(() => {}, 1000) -- --run-id r-st1 --nonce nonce-r-st1
probe|/usr/bin/node /tmp/whatever-entry.mjs -- --run-id r-st2 --nonce nonce-r-st2
none|/usr/bin/postgres -D /var/lib/postgresql/data
CASES
  # ② 真进程断言：两种形状的探针必须被判 probe，回收后判空。
  # 注意：这里用 bash 的 `[[ == *marker* ]]` 而不是 `collect | grep -q`——grep -q 命中即关管道，
  # collect 吃 SIGPIPE，在 pipefail 下会把管道状态判红（自检自己会假红）。
  local pid1 pid2 markers hit
  markers="r-st-live-1 r-st-live-2"
  node -e 'setInterval(() => {}, 1000)' -- --run-id r-st-live-1 --nonce nonce-r-st-live-1 &
  pid1=$!
  node -e 'setTimeout(() => {}, 60000)' -- --run-id r-st-live-2 --nonce nonce-r-st-live-2 &
  pid2=$!
  sleep 0.3
  hit="$(collect probe)"
  for marker in $markers; do
    if [[ "$hit" != *"$marker"* ]]; then
      echo "FAIL  自检：假探针 ${marker} 未被判为 probe（判定力退化）" >&2
      rc=1
    fi
  done
  kill "$pid1" "$pid2" 2>/dev/null
  wait "$pid1" "$pid2" 2>/dev/null
  hit="$(collect probe)"
  if [[ "$hit" == *"r-st-live"* ]]; then
    echo "FAIL  自检：假探针回收后仍被列出（收尾失效）" >&2
    rc=1
  fi
  if [ "$rc" -eq 0 ]; then
    echo "PASS  check-stray-runtimes 自检：分类规则（含真 Run 形状归 self）+ 两种探针形状判中、回收后判空"
  else
    echo "FAIL  check-stray-runtimes 自检：判定力退化，禁止当作收尾判据" >&2
  fi
  exit "$rc"
}

[ "${1:-}" = "--self-test" ] && self_test

strict=0
[ "${1:-}" = "--strict" ] && strict=1

fail=0
probes="$(collect probe)"
if [ -n "$probes" ]; then
  echo "FAIL  发现测试探针残留（#305：负向用例必须自回收）："
  printf '%s\n' "$probes" | sed 's/^/      /'
  fail=1
else
  echo "OK    无测试探针残留"
fi

others="$(collect self)"
if [ -n "$others" ]; then
  if [ "$strict" -eq 1 ]; then
    echo "FAIL  发现自家 Node/Runtime/E2E 进程（--strict）："
    fail=1
  else
    echo "INFO  以下自家进程在跑（可能是你在用的实例，含正在执行的 Run；发布前清理用 --strict 复核）："
  fi
  printf '%s\n' "$others" | sed 's/^/      /'
else
  echo "OK    无自家 Node/Runtime/E2E 进程"
fi

exit "$fail"
