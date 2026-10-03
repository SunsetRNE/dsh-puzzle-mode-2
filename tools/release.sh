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
#   bash tools/release.sh v0.8.1 --skip-tests    # 跳过测试门禁（**只在测试本身坏了时用**）
#
# ## 测试门禁（v0.19.8 加）
#
# 建 Release **之前**先跑 `npm test`，红就直接退出、不建 Release。
# 为什么加：v0.19.7 的 tag 是在测试全红的状态下打出来的——测试长期红着，
# 红成了常态，于是没人再看它。门禁把「红」变成**发不出去**，红一次就会被看见。
# 逃生口是 `--skip-tests`，但**必须显式写出来**（默认跑），不给自己留静默通道。
set -euo pipefail

TAG="${1:-}"
NOTES="${2:-}"
TOKEN_FILE="${GITHUB_TOKEN_FILE:-$HOME/.dsh/.github-token}"
REPO="${RELEASE_REPO:-liancha22/dsh-puzzle-mode}"
SKIP_TESTS=0
if [ "$NOTES" = "--skip-tests" ]; then
  SKIP_TESTS=1
  NOTES=""
fi
for arg in "$@"; do
  [ "$arg" = "--skip-tests" ] && SKIP_TESTS=1
done

if [ -z "$TAG" ]; then
  echo "用法: bash tools/release.sh <tag> [正文文件|--check|--skip-tests]" >&2
  exit 2
fi

# ---- 测试门禁：在**碰网络之前**跑，红就退出 ----
if [ "$NOTES" != "--check" ] && [ "$SKIP_TESTS" != "1" ]; then
  if [ ! -f package.json ]; then
    echo "找不到 package.json —— 请在仓库根目录跑本脚本" >&2
    exit 2
  fi
  echo "== 发版门禁：先跑 npm test =="
  if ! npm test --silent; then
    echo "" >&2
    echo "✗ 测试没过，**不建 Release**。" >&2
    echo "  → 先修红（或修测试本身）；确实要跳过就用 --skip-tests（会在输出里留痕）。" >&2
    exit 1
  fi
  echo "✓ 测试全绿，继续发版"
fi
if [ "$SKIP_TESTS" = "1" ] && [ "$NOTES" != "--check" ]; then
  echo "⚠ --skip-tests：本次**跳过测试门禁**，Release 是在未验证状态下建的。" >&2
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
