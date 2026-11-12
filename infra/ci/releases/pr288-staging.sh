#!/usr/bin/env bash
# 在仓库根运行。这个文件首次进入 main 的 push 选择本次发布。
set -eu
base=${1:?缺少事件的基线提交}
marker=infra/ci/releases/pr288-staging.sh
previous=22e8a2d5b7c5ce8a1e9ac5ee739db6ce6c822f97
if [[ ! "$base" =~ ^[0-9a-f]{40}$ ]] ||
  [[ "$(git diff --diff-filter=A --name-only "$base" HEAD -- "$marker")" != "$marker" ]]; then
  echo '本次事件没有新增 #288 的发布选择文件' >&2
  exit 1
fi
git merge-base --is-ancestor "$previous" HEAD
printf '%s\n' "$previous"
