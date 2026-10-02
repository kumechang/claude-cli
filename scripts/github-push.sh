#!/usr/bin/env bash
# 案件の「最後のデータ送信」用の汎用スクリプト: OUTBOX_DIR 内のファイルを GitHub API(Contents API)でコミットする。
#
#   projects.json の finalize に指定:
#     "finalize": { "command": ["/opt/claude-cli/scripts/github-push.sh", "owner/repo", "main", "data"],
#                   "env": { "GH_TOKEN_VAR": "GITHUB_TOKEN_MAHJONG" } }
#   引数: <owner/repo> <branch> <リポジトリ内の保存先ディレクトリ(省略可)>
#   env : GH_TOKEN_VAR = トークンが入った環境変数名(既定 GITHUB_TOKEN)、GITHUB_API_URL(テスト用)
#   サーバーが渡す OUTBOX_DIR / PROJECT_NAME を使う。ファイルの内容が変わっていなければコミットしない。
set -euo pipefail
REPO=${1:?owner/repo}; BRANCH=${2:?branch}; DEST=${3:-}
TOKEN_VAR=${GH_TOKEN_VAR:-GITHUB_TOKEN}
TOKEN=${!TOKEN_VAR:?環境変数 $TOKEN_VAR が未設定です}
API=${GITHUB_API_URL:-https://api.github.com}
SRC=${OUTBOX_DIR:?OUTBOX_DIR が未設定です}
[ -d "$SRC" ] || { echo "OUTBOX_DIR がありません: $SRC (送信するものなし)"; exit 0; }

api() { # api METHOD PATH [json-file]
  local method=$1 path=$2 body=${3:-}
  curl -sS -w '\n%{http_code}' -X "$method" "$API/repos/$REPO$path" \
    -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" -H "User-Agent: claude-cli-server" \
    ${body:+-H "Content-Type: application/json" --data-binary @"$body"}
}

count=0
while IFS= read -r -d '' file; do
  rel=${file#"$SRC"/}
  target=${DEST:+$DEST/}$rel
  enc=$(jq -rn --arg p "$target" '$p | split("/") | map(@uri) | join("/")')

  resp=$(api GET "/contents/$enc?ref=$BRANCH"); code=${resp##*$'\n'}; json=${resp%$'\n'*}
  sha=""
  if [ "$code" = 200 ]; then
    sha=$(jq -r .sha <<<"$json")
    # 変更なしならスキップ(git blob sha と比較)
    local_sha=$(git hash-object "$file")
    [ "$sha" = "$local_sha" ] && { echo "unchanged: $target"; continue; }
  elif [ "$code" != 404 ]; then
    echo "GET $target -> HTTP $code: $json" >&2; exit 1
  fi

  tmp=$(mktemp); trap 'rm -f "$tmp"' EXIT
  base64 -w0 "$file" | jq -Rs --arg m "claude: ${PROJECT_NAME:-project} update $target" --arg b "$BRANCH" --arg sha "$sha" \
    '{message:$m, content:., branch:$b} + (if $sha != "" then {sha:$sha} else {} end)' > "$tmp"
  resp=$(api PUT "/contents/$enc" "$tmp"); code=${resp##*$'\n'}
  case $code in 200|201) echo "pushed: $target"; count=$((count+1));; *) echo "PUT $target -> HTTP $code: ${resp%$'\n'*}" >&2; exit 1;; esac
done < <(find "$SRC" -type f -print0 | sort -z)
echo "done: $count file(s) pushed"
