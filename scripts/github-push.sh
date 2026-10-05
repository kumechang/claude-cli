#!/usr/bin/env bash
# 案件の「最後のデータ送信」用スクリプト: OUTBOX_DIR 内のファイルを GitHub API(Contents API)でコミットする。
# 送信先はプロンプトに書かれ、claude が OUTBOX_DIR/_target.json に書き出す:
#     {"repo":"owner/name", "branch":"main", "dir":"格納フォルダ", "base":"main"}
#     (branch 省略時 main、dir は空でも可。branch が存在しなければ base(省略時はリポジトリの既定ブランチ)から自動で作る)
#
#   projects.json の finalize に指定:
#     "finalize": { "command": ["/opt/claude-cli/scripts/github-push.sh"],
#                   "env": { "GH_TOKEN_VAR": "GITHUB_TOKEN_MAHJONG", "GH_ALLOWED_REPOS": "kumechang/*" } }
#   env: GH_TOKEN_VAR     トークンが入った環境変数名(既定 GITHUB_TOKEN)
#        GH_ALLOWED_REPOS 送信を許可するリポジトリ(カンマ区切り。"owner/repo" か "owner/*")。必須。
#                         プロンプト(や claude が読んだ Web ページ)の内容で、意図しないリポジトリへ送られないようにするため
#        GITHUB_API_URL   テスト用
#   サーバーが渡す OUTBOX_DIR / PROJECT_NAME を使う。内容が変わっていないファイルはコミットしない。
set -euo pipefail
TOKEN_VAR=${GH_TOKEN_VAR:-GITHUB_TOKEN}
TOKEN=${!TOKEN_VAR:?環境変数 $TOKEN_VAR が未設定です}
ALLOWED=${GH_ALLOWED_REPOS:?GH_ALLOWED_REPOS が未設定です(例: owner/* または owner/repo,owner/repo2)}
API=${GITHUB_API_URL:-https://api.github.com}
SRC=${OUTBOX_DIR:?OUTBOX_DIR が未設定です}
die() { echo "ERROR: $*" >&2; exit 1; }

[ -d "$SRC" ] && [ -n "$(find "$SRC" -type f ! -name _target.json -print -quit)" ] || { echo "送信するファイルなし: $SRC"; exit 0; }
[ -f "$SRC/_target.json" ] || die "$SRC/_target.json がありません(プロンプトに送信先の記載がなかった可能性)。データは $SRC に残っています"

REPO=$(jq -er '.repo' "$SRC/_target.json") || die "_target.json に repo がありません"
BRANCH=$(jq -r '.branch // "main"' "$SRC/_target.json")
DEST=$(jq -r '.dir // ""' "$SRC/_target.json")
BASE=$(jq -r '.base // ""' "$SRC/_target.json")
DEST=${DEST#./}; DEST=${DEST%/}

# 送信先の検証(プロンプト由来の値なので厳しく見る)
[[ $REPO =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]] || die "不正な repo: $REPO"
[[ $BRANCH =~ ^[A-Za-z0-9._/-]+$ && $BRANCH != *..* ]] || die "不正な branch: $BRANCH"
[[ -z $BASE || ( $BASE =~ ^[A-Za-z0-9._/-]+$ && $BASE != *..* ) ]] || die "不正な base: $BASE"
safe_path() { [[ $1 != /* && $1 != *..* && $1 != *\\* && ! $1 =~ [[:cntrl:]] ]]; }
safe_path "$DEST" || die "不正な dir: $DEST"
ok=0; IFS=',' read -ra pats <<<"$ALLOWED"
for p in "${pats[@]}"; do p=${p// /}; [[ $REPO == $p ]] && ok=1; done   # glob 比較(owner/* など)
[ $ok = 1 ] || die "repo $REPO は GH_ALLOWED_REPOS($ALLOWED) に含まれていません"

api() { # api METHOD PATH [json-file]
  local method=$1 path=$2 body=${3:-}
  curl -sS -w '\n%{http_code}' -X "$method" "$API/repos/$REPO$path" \
    -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" -H "User-Agent: claude-cli-server" \
    ${body:+-H "Content-Type: application/json" --data-binary @"$body"}
}

# ブランチが無ければ base から作る(Contents API は存在しないブランチに書けないため)
resp=$(api GET "/git/ref/heads/$BRANCH"); code=${resp##*$'\n'}
if [ "$code" = 404 ]; then
  if [ -z "$BASE" ]; then
    resp=$(api GET ""); code=${resp##*$'\n'}
    [ "$code" = 200 ] || die "リポジトリ情報の取得に失敗 (HTTP $code)"
    BASE=$(jq -r .default_branch <<<"${resp%$'\n'*}")
  fi
  resp=$(api GET "/git/ref/heads/$BASE"); code=${resp##*$'\n'}
  [ "$code" = 200 ] || die "base ブランチ $BASE が見つかりません (HTTP $code)"
  base_sha=$(jq -r .object.sha <<<"${resp%$'\n'*}")
  refbody=$(mktemp)
  jq -n --arg r "refs/heads/$BRANCH" --arg s "$base_sha" '{ref:$r, sha:$s}' > "$refbody"
  resp=$(api POST "/git/refs" "$refbody"); code=${resp##*$'\n'}; rm -f "$refbody"
  [ "$code" = 201 ] || die "ブランチ $BRANCH の作成に失敗 (HTTP $code): ${resp%$'\n'*}"
  echo "created branch: $REPO@$BRANCH (from $BASE)"
elif [ "$code" != 200 ]; then
  die "ブランチ確認に失敗 (HTTP $code): ${resp%$'\n'*}"
fi

count=0; tmp=$(mktemp); trap 'rm -f "$tmp"' EXIT
while IFS= read -r -d '' file; do
  rel=${file#"$SRC"/}
  safe_path "$rel" || die "不正なファイルパス: $rel"
  target=${DEST:+$DEST/}$rel
  enc=$(jq -rn --arg p "$target" '$p | split("/") | map(@uri) | join("/")')

  resp=$(api GET "/contents/$enc?ref=$BRANCH"); code=${resp##*$'\n'}; json=${resp%$'\n'*}
  sha=""
  if [ "$code" = 200 ]; then
    sha=$(jq -r .sha <<<"$json")
    [ "$sha" = "$(git hash-object "$file")" ] && { echo "unchanged: $REPO/$target"; continue; }
  elif [ "$code" != 404 ]; then
    die "GET $target -> HTTP $code: $json"
  fi

  base64 -w0 "$file" | jq -Rs --arg m "claude: ${PROJECT_NAME:-project} update $target" --arg b "$BRANCH" --arg sha "$sha" \
    '{message:$m, content:., branch:$b} + (if $sha != "" then {sha:$sha} else {} end)' > "$tmp"
  resp=$(api PUT "/contents/$enc" "$tmp"); code=${resp##*$'\n'}
  case $code in 200|201) echo "pushed: $REPO/$target"; count=$((count+1));; *) die "PUT $target -> HTTP $code: ${resp%$'\n'*}";; esac
done < <(find "$SRC" -type f ! -name _target.json -print0 | sort -z)
echo "done: $count file(s) pushed to $REPO@$BRANCH"
