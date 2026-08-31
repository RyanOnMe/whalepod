#!/usr/bin/env bash
# 敏感语料扫描（04-验收矩阵与测试策略.md §6.4）。
# 用法: scripts/secret-scan.sh [路径...]      默认扫描 artifacts/evidence/
#       scripts/secret-scan.sh --self-test    判定力自检（防模式被改坏）
# 任一模式命中即退出码 1 —— 对应 Q7 安全门的判负条件。
# 显式传入的路径不存在同样退出码 1（笔误不得报绿）；
# 默认 artifacts/evidence 尚不存在时视为「无取证包」，SKIP 放行。
#
# #73（Linux 路径红线判据）：绝对路径模式补 Linux 成员 home（/home/<u>/）与
# tmpdir 形态（macOS /[private/]var/folders/ 与本机 os.tmpdir() 锚点
# ${TMPDIR:-/tmp}），与 recorder 的 redactText 归约规则保持一致；
# --self-test 升级为逐条语料断言：每条泄漏必须单独判中、干净文本必须放行。
set -uo pipefail

patterns=(
  'Bearer [A-Za-z0-9._~+/=-]+'          # Authorization: Bearer ...
  '[A-Z0-9_]*API_KEY=[A-Za-z0-9._-]+'   # DEEPSEEK_API_KEY=sk-...
  'sk-[A-Za-z0-9]{16,}'                 # 模型密钥
  'npm_[A-Za-z0-9_]{8,}'                # npm token（含下划线；语料 npm_xxx_fake_token）
  'BEGIN [A-Z ]*PRIVATE KEY'            # PEM 私钥
  '/Users/[^/[:space:]]+/'              # 成员本机绝对路径（macOS home）
  '/home/[^/[:space:]]+/'               # 成员本机绝对路径（Linux home，#73）
  '/var/folders/[^/[:space:]]+/'        # macOS 临时目录（含 /private/ 前缀形态，#73）
  '[?&]token=[^&[:space:]]+'            # URL 查询里的 token
)

# 本机 tmpdir 锚点（#73）：与 Node os.tmpdir() 同语义——TMPDIR 覆盖，缺省 /tmp。
# 动态入列（固定串只出现在扫描语料里、不写死进仓库），并加右边界防 /tmp 误配
# /tmpfoo。扫描证据时它把 os.tmpdir() 形态的残留（如 /tmp/p311-chain-ws-*）判中。
tmp_anchor="${TMPDIR:-/tmp}"
tmp_anchor="${tmp_anchor%/}"
if [ -n "$tmp_anchor" ] && [ "$tmp_anchor" != "/" ]; then
  tmp_ere="$(printf '%s' "$tmp_anchor" | sed 's/[.[\*^$()+?{}|]/\\&/g')"
  patterns+=("${tmp_ere}([^A-Za-z0-9._-]|\$)")
fi

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
  # 逐条语料断言（#73 强化）：每条泄漏单独成文件必须判中——模式被改坏/误删即红；
  # 干净文件必须放行——模式过宽即红。语料含 Linux home、macOS tmpdir 与本机
  # os.tmpdir() 锚点形态（Linux CI 上即 /tmp/…）。
  local tmp ok=0 line n=0 out leaks
  tmp="$(mktemp -d)"
  leaks="$(printf '%s\n' \
    'Authorization: Bearer test-secret-123' \
    'DEEPSEEK_API_KEY=sk-test-abcdef' \
    'sk-abcdefghijklmnop0123456789' \
    'npm_xxx_fake_token' \
    '-----BEGIN PRIVATE KEY-----' \
    '/Users/bob/private/project' \
    'https://example.com/path?token=secret#fragment' \
    '/home/alice/workspace/project311/.deploy.env' \
    '/var/folders/9g/abc123def456789ghi012345jkl6/T/p311-chain-ws-x7/secret.md' \
    '/private/var/folders/9g/abc123def456789ghi012345jkl6/T/tsx-1000/ipc.sock' \
    "${tmp_anchor}/p311-selftest-leak.txt")"
  while IFS= read -r line; do
    n=$((n + 1))
    printf '%s\n' "$line" > "$tmp/line.txt"
    out="$(scan_paths "$tmp/line.txt")"
    if [ "$?" -eq 0 ]; then
      echo "FAIL  自检语料第 ${n} 条未被判中（判定力退化）: ${line:0:28}…" >&2
      ok=1
    fi
  done <<< "$leaks"

  echo 'clean file, nothing sensitive' > "$tmp/clean.txt"
  if ! scan_paths "$tmp/clean.txt" >/dev/null; then
    echo "FAIL  自检：干净文件被误判命中" >&2
    ok=1
  fi
  # tmpdir 锚点边界自查：/tmpfoo（Linux 缺省锚 /tmp）与 <tmp>/<home> 标记不得误伤。
  printf '%s\n' 'mentions /tmpfoo-like words and <tmp>/p311-chain markers only' > "$tmp/clean2.txt"
  if ! scan_paths "$tmp/clean2.txt" >/dev/null; then
    echo "FAIL  自检：tmpdir 锚点过宽误伤（边界退化）" >&2
    ok=1
  fi

  rm -rf "$tmp"
  if [ "$ok" -eq 0 ]; then
    echo "PASS  secret-scan 自检：${n} 条语料逐条判中（含 /home 与 tmpdir 形态）、干净文本放行"
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
