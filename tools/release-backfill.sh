#!/usr/bin/env bash
# 一次性补历史 Release 页面（v0.1.1 ~ v0.8.0）。
# 正文由各 tag 的提交历史生成，写入 .github/release-<tag>.md 后逐个 POST。
set -euo pipefail

cd "$(dirname "$0")/.."
TOKEN="$(tr -d '\r\n' < "$HOME/.dsh/.github-token")"
REPO="liancha22/dsh-puzzle-mode"

CODE="$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" https://api.github.com/user)"
if [ "$CODE" != "200" ]; then
  echo "token 无效（HTTP $CODE）" >&2
  exit 1
fi

for TAG in v0.1.1 v0.2.0 v0.3.0 v0.4.0 v0.5.0 v0.6.0 v0.7.0 v0.8.0; do
  NOTES=".github/release-$TAG.md"
  if [ ! -f "$NOTES" ]; then
    echo "跳过 $TAG：没有 $NOTES" >&2
    continue
  fi
  # 已存在就跳过（重跑安全）。
  EXIST="$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" \
    "https://api.github.com/repos/$REPO/releases/tags/$TAG")"
  if [ "$EXIST" = "200" ]; then
    echo "已存在，跳过 $TAG"
    continue
  fi
  python3 - "$TAG" "$NOTES" <<'PY' > /tmp/gh-rel.json
import json, sys
tag, notes = sys.argv[1], sys.argv[2]
print(json.dumps({"tag_name": tag, "name": tag,
                  "body": open(notes, encoding="utf-8").read()}, ensure_ascii=False))
PY
  CODE="$(curl -s -o /tmp/gh-rel-out.json -w '%{http_code}' -X POST \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    --data-binary @/tmp/gh-rel.json "https://api.github.com/repos/$REPO/releases")"
  if [ "$CODE" = "201" ]; then
    URL="$(python3 -c "import json;print(json.load(open('/tmp/gh-rel-out.json'))['html_url'])")"
    echo "✓ $TAG → $URL"
  else
    echo "✗ $TAG 失败（HTTP $CODE）：$(head -c 160 /tmp/gh-rel-out.json)" >&2
  fi
  sleep 1
done
