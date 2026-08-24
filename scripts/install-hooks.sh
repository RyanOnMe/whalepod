#!/usr/bin/env bash
# 启用本仓库的 git hooks。clone 后运行一次：
#   scripts/install-hooks.sh
set -euo pipefail
cd "$(dirname "$0")/.."

git config core.hooksPath .githooks
chmod +x .githooks/* scripts/*.sh

echo "已启用 .githooks（core.hooksPath=.githooks）。"
echo "  commit-msg: 强制 DCO sign-off（git commit -s）"
echo "  pre-push:   拦截直接推 main 与非快进（force）推送"
