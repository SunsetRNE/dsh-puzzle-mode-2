#!/usr/bin/env bash
# 把 .github/release-*.md 同步成对应 Release 的正文（含「下载安装」区）。
# 网络到 GitHub 不稳，所以逐个重试、失败不影响其它。
set -uo pipefail

cd "$(dirname "$0")/.."
TOKEN="$(tr -d '\r\n' < "$HOME/.dsh/.github-token")"
REPO="${RELEASE_REPO:-liancha22/dsh-puzzle-mode}"
API="https://api.github.com/repos/$REPO"

# 只要一个 tag 参数就只同步那一个；不给就全量。
TAGS=("$@")
if [ ${#TAGS[@]} -eq 0 ]; then
  while IFS= read -r f; do
    TAGS+=("${f#.github/release-}")
  done < <(ls .github/release-*.md | sort -V)
  # 去掉 .md 后缀
  for i in "${!TAGS[@]}"; do TAGS[$i]="${TAGS[$i]%.md}"; done
fi

ok=0; fail=0
for TAG in "${TAGS[@]}"; do
  NOTES=".github/release-$TAG.md"
  if [ ! -f "$NOTES" ]; then echo "跳过 $TAG：没有 $NOTES"; continue; fi

  # 1) 拿 release id（最多 5 次）
  RID=""
  for try in 1 2 3 4 5; do
    RID="$(curl -s --max-time 45 -H "Authorization: Bearer $TOKEN" \
      "$API/releases/tags/$TAG" | python3 -c 'import json,sys
try:
    print(json.load(sys.stdin).get("id",""))
except Exception:
    print("")' 2>/dev/null)"
    [ -n "$RID" ] && break
    sleep $((try * 2))
  done
  if [ -z "$RID" ]; then echo "✗ $TAG：拿不到 release id"; fail=$((fail+1)); continue; fi

  # 2) 用 python 生成 payload（正文里有引号/换行，不能手拼）
  python3 - "$NOTES" > /tmp/rel-payload.json <<'PY'
import json, sys
body = open(sys.argv[1], encoding='utf-8').read()
print(json.dumps({'body': body}))
PY

  # 3) PATCH（最多 5 次）
  CODE=""
  for try in 1 2 3 4 5; do
    CODE="$(curl -s -o /tmp/rel-resp.json -w '%{http_code}' --max-time 60 \
      -X PATCH -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
      --data-binary @/tmp/rel-payload.json "$API/releases/$RID")"
    [ "$CODE" = "200" ] && break
    sleep $((try * 2))
  done

  if [ "$CODE" = "200" ]; then
    LEN="$(python3 -c 'import json;print(len(json.load(open("/tmp/rel-resp.json"))["body"]))' 2>/dev/null || echo '?')"
    echo "✓ $TAG：正文 $LEN 字"
    ok=$((ok+1))
  else
    echo "✗ $TAG：PATCH HTTP $CODE"
    fail=$((fail+1))
  fi
  sleep 1
done

echo
echo "成功 $ok / 失败 $fail"
[ "$fail" -eq 0 ]
