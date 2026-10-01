# claude-cli-server

HTTP で受け取ったプロンプトをサーバーの `claude` CLI(`claude -p`)で順次実行し、結果をファイルに保存、GitHub API(Contents API)でコミットする。依存パッケージなし(Node.js 20+)。

## 動作
1. `POST /projects/<案件>/run` でプロンプト受信(Bearer 認証必須)→ `queue/<案件>/pending/<id>.md` に格納
2. ワーカーが全案件の pending を古い順に1件ずつ実行(`claude` の同時実行は1つ)
3. 結果を `queue/<案件>/done/<id>.md|json` に保存し pending から除去、その案件に設定された**結果ハンドラ**を実行(結果は `<id>.meta.json`)
4. 全案件の pending が空になったらワーカーは停止(HTTP 受付は継続。次のリクエストか再起動時に pending があれば再開)
- 実行失敗したものは `queue/<案件>/failed/` へ(自動リトライしない)

## 案件と結果ハンドラ
案件は `projects.json`(`projects.example.json` 参照)で定義。案件ごとに `workDir`・`claudeArgs`・`timeoutMs`・`handlers` を持ちます。
`handlers` は配列で、複数指定すると順に実行され、1つが失敗しても他と実行結果には影響しません(エラーは meta に記録)。未定義の案件名は 404。

- 組み込み: `github`(`repo` `branch` `dir` `tokenEnv` — 案件ごとに別リポジトリ/別トークン可)
- 追加方法(例: メール送信): `src/handlers/email.js` に `async ({ project, id, prompt, result, markdown, options }) => meta` を作り、`src/handlers/index.js` の `registry` に1行足す。`projects.json` で `{ "type": "email", "to": "..." }` と指定。

## 認証
全エンドポイント(`/healthz` 除く)で `Authorization: Bearer $API_TOKEN` が必須。不一致は 401。トークンは定数時間比較。`API_TOKEN` 未設定では起動しない。

## API
```
curl -X POST localhost:3000/projects/alpha/run -H "Authorization: Bearer $API_TOKEN" \
  -H 'Content-Type: application/json' -d '{"prompt":"README を要約して"}'
curl localhost:3000/projects/alpha/jobs/<id> -H "Authorization: Bearer $API_TOKEN"   # queued/running/done/failed
```

## Ubuntu (26.04 LTS 想定) セットアップ
```bash
sudo apt update && sudo apt install -y nodejs npm git   # node -v で 20+ を確認
sudo npm install -g @anthropic-ai/claude-code
sudo useradd -m -s /usr/sbin/nologin claude
sudo -u claude -H claude                                # 初回ログイン、または env に ANTHROPIC_API_KEY
sudo git clone <this repo> /opt/claude-cli
sudo mkdir -p /opt/claude-cli/queue /srv/workspace && sudo chown -R claude: /opt/claude-cli/queue /srv/workspace
sudo install -m600 .env.example /etc/claude-cli-server.env   # 値を編集
sudo cp projects.example.json /opt/claude-cli/projects.json   # 案件を編集
sudo cp deploy/claude-cli-server.service /etc/systemd/system/
sudo systemctl enable --now claude-cli-server
```
任意の環境変数: `PORT` `QUEUE_DIR` `PROJECTS_FILE` `CLAUDE_TIMEOUT_MS`

## セキュリティ注意
- 公開時は nginx/Caddy 等で TLS 終端すること(Bearer トークンが平文で流れるため)。
- claude はサーバー上で任意操作できる。専用ユーザー・専用 `WORK_DIR` で動かし、`CLAUDE_ARGS` の権限モードは最小限に。
- GitHub トークンは案件ごとに対象リポジトリのみ `contents:write` の fine-grained PAT を推奨。
