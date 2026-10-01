# claude-cli-server

HTTP で受け取ったプロンプトをサーバーの `claude` CLI(`claude -p`)で順次実行し、結果をファイルに保存、GitHub API(Contents API)でコミットする。依存パッケージなし(Node.js 20+)。

## 動作
1. `POST /run` でプロンプト受信(Bearer 認証必須)→ `queue/pending/<id>.md` に格納
2. ワーカーが pending を古い順に1件ずつ実行
3. 結果を `queue/done/<id>.md|json` に保存し pending から除去、GitHub に push(結果は `queue/done/<id>.meta.json`)
4. pending が空になったらワーカーは停止(HTTP 受付は継続。次のリクエストか再起動時に pending があれば再開)
- 実行失敗したものは `queue/failed/` へ(自動リトライしない)

## 認証
全エンドポイント(`/healthz` 除く)で `Authorization: Bearer $API_TOKEN` が必須。不一致は 401。トークンは定数時間比較。`API_TOKEN` 未設定では起動しない。

## API
```
curl -X POST localhost:3000/run -H "Authorization: Bearer $API_TOKEN" \
  -H 'Content-Type: application/json' -d '{"prompt":"README を要約して"}'
curl localhost:3000/jobs/<id> -H "Authorization: Bearer $API_TOKEN"   # queued/running/done/failed
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
sudo cp deploy/claude-cli-server.service /etc/systemd/system/
sudo systemctl enable --now claude-cli-server
```
任意の環境変数: `PORT` `WORK_DIR` `QUEUE_DIR` `CLAUDE_ARGS` `CLAUDE_TIMEOUT_MS` `GITHUB_RESULTS_DIR`

## セキュリティ注意
- 公開時は nginx/Caddy 等で TLS 終端すること(Bearer トークンが平文で流れるため)。
- claude はサーバー上で任意操作できる。専用ユーザー・専用 `WORK_DIR` で動かし、`CLAUDE_ARGS` の権限モードは最小限に。
- `GITHUB_TOKEN` は対象リポジトリのみ `contents:write` の fine-grained PAT を推奨。
