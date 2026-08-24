#!/usr/bin/env bash
# 敏感语料扫描（04-验收矩阵与测试策略.md §6.4）。
# 用法: scripts/secret-scan.sh [路径...]   默认扫描 artifacts/evidence/
# 任一模式命中即退出码 1 —— 对应 Q7 安全门的判负条件。
set -uo pipefail

paths=("$@")
if [ ${#paths[@]} -eq 0 ]; then
  paths=("artifacts/evidence")
fi

patterns=(
  'Bearer [A-Za-z0-9._~+/=-]+'          # Authorization: Bearer ...
  '[A-Z0-9_]*API_KEY=[A-Za-z0-9._-]+'   # DEEPSEEK_API_KEY=sk-...
  'sk-[A-Za-z0-9]{16,}'                 # 模型密钥
  'npm_[A-Za-z0-9]{20,}'                # npm token
  'BEGIN [A-Z ]*PRIVATE KEY'            # PEM 私钥
  '/Users/[^/[:space:]]+/'              # 成员本机绝对路径
  '[?&]token=[^&[:space:]]+'            # URL 查询里的 token
)

found=0
for p in "${paths[@]}"; do
  [ -e "$p" ] || continue
  for pat in "${patterns[@]}"; do
    if grep -rEnI -- "$pat" "$p" >/dev/null 2>&1; then
      echo "HIT   $p 命中模式: $pat"
      grep -rEnIl -- "$pat" "$p" | sed 's/^/      /'
      found=1
    fi
  done
done

if [ "$found" -eq 0 ]; then
  echo "OK    未命中敏感语料（${paths[*]}）"
fi
exit "$found"
