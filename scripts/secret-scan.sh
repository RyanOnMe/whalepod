#!/usr/bin/env bash
# 敏感语料扫描（04-验收矩阵与测试策略.md §6.4）。
# 用法: scripts/secret-scan.sh [路径...]      默认扫描 artifacts/evidence/
#       scripts/secret-scan.sh --self-test    判定力自检（防模式被改坏）
# 任一模式命中即退出码 1 —— 对应 Q7 安全门的判负条件。
# 显式传入的路径不存在同样退出码 1（笔误不得报绿）；
# 默认 artifacts/evidence 尚不存在时视为「无取证包」，SKIP 放行。
set -uo pipefail

patterns=(
  'Bearer [A-Za-z0-9._~+/=-]+'          # Authorization: Bearer ...
  '[A-Z0-9_]*API_KEY=[A-Za-z0-9._-]+'   # DEEPSEEK_API_KEY=sk-...
  'sk-[A-Za-z0-9]{16,}'                 # 模型密钥
  'npm_[A-Za-z0-9_]{8,}'                # npm token（含下划线；语料 npm_xxx_fake_token）
  'BEGIN [A-Z ]*PRIVATE KEY'            # PEM 私钥
  '/Users/[^/[:space:]]+/'              # 成员本机绝对路径
  '[?&]token=[^&[:space:]]+'            # URL 查询里的 token
)

scan_paths() { # scan_paths <路径...>；命中返回 1
  local found=0 p pat
  for p in "$@"; do
    for pat in "${patterns[@]}"; do
      if grep -rEnI -- "$pat" "$p" >/dev/null 2>&1; then
        echo "HIT   $p 命中模式: $pat"
        grep -rEnIl -- "$pat" "$p" | sed 's/^/      /'
        found=1
      fi
    done
  done
  [ "$found" -eq 0 ] && echo "OK    未命中敏感语料（$*）"
  return "$found"
}

self_test() {
  local tmp out code ok=0
  tmp="$(mktemp -d)"
  printf '%s\n' \
    'Authorization: Bearer test-secret-123' \
    'DEEPSEEK_API_KEY=sk-test-abcdef' \
    'npm_xxx_fake_token' \
    '-----BEGIN PRIVATE KEY-----' \
    '/Users/bob/private/project' \
    'https://example.com/path?token=secret#fragment' \
    >"$tmp/corpus.txt"
  echo 'clean file, nothing sensitive' >"$tmp/clean.txt"

  out="$(scan_paths "$tmp/corpus.txt")"; code=$?
  [ "$code" -eq 1 ] || ok=1                     # 固定语料必须命中
  printf '%s\n' "$out" | grep -q 'npm_' || ok=1  # npm 语料曾漏报，单独盯防
  scan_paths "$tmp/clean.txt" >/dev/null || ok=1 # 干净文件必须放行
  rm -rf "$tmp"

  if [ "$ok" -eq 0 ]; then
    echo "PASS  secret-scan 自检：固定语料全命中（含 npm_）、干净文件放行"
  else
    echo "FAIL  secret-scan 自检：判定力退化，禁止合入" >&2
  fi
  exit "$ok"
}

[ "${1:-}" = "--self-test" ] && self_test

paths=("$@")
if [ ${#paths[@]} -eq 0 ]; then
  if [ ! -e artifacts/evidence ]; then
    echo "SKIP  artifacts/evidence 不存在（尚无取证包；出包后默认扫描该目录）"
    exit 0
  fi
  paths=("artifacts/evidence")
fi

for p in "${paths[@]}"; do
  if [ ! -e "$p" ]; then
    echo "MISS  $p: 路径不存在（可能是笔误；缺数据必须失败，不得报绿）" >&2
    exit 1
  fi
done

scan_paths "${paths[@]}"
