#!/usr/bin/env bash
# 发 GitHub Release。**需要有效的 GitHub token**（读 /root/.dsh/.github-token）。
#
# 为什么单独写个脚本：Release 页面只能走 API（`git push --tags` 只推 tag，不建页面），
# 而 API 写操作必须带凭据。旧 token（ghp_05CdLYGO…）返回 401 Bad credentials，已失效。
#
# 用法：
#   bash tools/release.sh v0.8.1                 # 用 .github/release-v0.8.1.md 当正文
#   bash tools/release.sh v0.8.1 /path/notes.md  # 指定正文
#   bash tools/release.sh v0.8.1 --check         # 只校验 token，不发
set -euo pipefail

TAG="${1:-}"
NOTES="${2:-}"
TOKEN_FILE="${GITHUB_TOKEN_FILE:-$HOME/.dsh/.github-token}"
REPO="liancha22/dsh-puzzle-mode"

if [ -z "$TAG" ]; then
  echo "用法: bash tools/release.sh <tag> [正文文件|--check]" >&2
  exit 2
fi
if [ ! -f "$TOKEN_FILE" ]; then
  echo "找不到 token 文件：$TOKEN_FILE" >&2
  exit 2
fi

TOKEN="$(tr -d '\r\n' < "$TOKEN_FILE")"

# 先验凭据：401 就直接说清，不要等 POST 失败再猜。
CODE="$(curl -s -o /tmp/gh-check.json -w '%{http_code}' \
  -H "Authorization: Bearer $TOKEN" https://api.github.com/user)"
if [ "$CODE" != "200" ]; then
  echo "token 无效（HTTP $CODE）：$(head -c 200 /tmp/gh-check.json)" >&2
  echo "→ 去 https://github.com/settings/tokens 生成带 repo 权限的新 PAT，" >&2
  echo "  写进 $TOKEN_FILE，再重跑本脚本。" >&2
  exit 1
fi
echo "token 有效（HTTP 200）"
[ "$NOTES" = "--check" ] && exit 0

if [ -z "$NOTES" ]; then
  NOTES=".github/release-$TAG.md"
fi
if [ ! -f "$NOTES" ]; then
  echo "找不到正文文件：$NOTES" >&2
  exit 2
fi

# 正文走 --data-binary 的 JSON，用 python 转义，避免 shell 引号地狱。
python3 - "$TAG" "$NOTES" <<'PY' > /tmp/gh-release.json
import json, sys
tag, notes = sys.argv[1], sys.argv[2]
print(json.dumps({
    "tag_name": tag,
    "name": tag,
    "body": open(notes, encoding="utf-8").read(),
}, ensure_ascii=False))
PY

CODE="$(curl -s -o /tmp/gh-release-out.json -w '%{http_code}' -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  --data-binary @/tmp/gh-release.json \
  "https://api.github.com/repos/$REPO/releases")"

if [ "$CODE" = "201" ]; then
  echo "Release 已创建："
  python3 -c "import json;print(json.load(open('/tmp/gh-release-out.json'))['html_url'])"
else
  echo "创建失败（HTTP $CODE）：" >&2
  head -c 400 /tmp/gh-release-out.json >&2
  echo >&2
  exit 1
fi
