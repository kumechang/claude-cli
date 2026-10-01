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

- 組み込み: `email`(`to` `subject` — 結果をメール送信。SMTP 設定は上記)、`github`(`repo` `branch` `dir` `tokenEnv` — 案件ごとに別リポジトリ/別トークン可)
- 追加方法(独自ハンドラ): `src/handlers/<type>.js` に `async ({ project, id, prompt, result, markdown, options }) => meta` を作り、`src/handlers/index.js` の `registry` に1行足す。

## claude CLI の認証ヘルスチェック
起動時と30分ごと(`HEALTHCHECK_INTERVAL_MS`、0 で無効)に、最小のプロンプトを実際に実行して認証を確認します(`claude auth status` はローカル状態しか見ず、失効したトークンを検出できないため)。
- 異常になったら `ADMIN_EMAIL` にメール。異常が続く間は24時間ごと(`HEALTHCHECK_REMIND_MS`)に再通知、復旧したら復旧メール。
- 認証切れの間はワーカーを止め、プロンプトは `pending` に残します(失敗扱いにしない)。復旧を検知すると自動で再開します。ジョブ実行中に認証エラーを検知した場合も同様です。
- `GET /healthz`(認証不要)で `claude: {ok, kind, checkedAt}` を確認できます(エラー詳細は含みません)。
- 復旧は管理者がサーバーで `claude auth login` をやり直す必要があります(人手が必要)。`ANTHROPIC_API_KEY` での運用なら期限切れが起きにくく、安定します。
- メール送信は内蔵の SMTP クライアントを使います: `SMTP_HOST` `SMTP_PORT`(587) `SMTP_SECURE`(465 向けに true) `SMTP_USER` `SMTP_PASS` `MAIL_FROM` `ADMIN_EMAIL`(カンマ区切りで複数可)。`HEALTHCHECK_ARGS` で軽量モデル指定なども可。

## 認証
全エンドポイント(`/healthz` 除く)で `Authorization: Bearer $API_TOKEN` が必須。不一致は 401。トークンは定数時間比較。`API_TOKEN` 未設定では起動しない。

## API
```
curl -X POST localhost:3000/projects/alpha/run -H "Authorization: Bearer $API_TOKEN" \
  -H 'Content-Type: application/json' -d '{"prompt":"README を要約して"}'
curl localhost:3000/projects/alpha/jobs/<id> -H "Authorization: Bearer $API_TOKEN"   # queued/running/done/failed
```

## サーバー設定・自動デプロイ
Ubuntu への初期設定と、`main` への push で自動反映する手順は [docs/SETUP.md](docs/SETUP.md) を参照。
任意の環境変数: `PORT` `QUEUE_DIR` `PROJECTS_FILE` `CLAUDE_TIMEOUT_MS`

## セキュリティ注意
- 公開時は nginx/Caddy 等で TLS 終端すること(Bearer トークンが平文で流れるため)。
- claude はサーバー上で任意操作できる。専用ユーザー・専用 `WORK_DIR` で動かし、`CLAUDE_ARGS` の権限モードは最小限に。
- GitHub トークンは案件ごとに対象リポジトリのみ `contents:write` の fine-grained PAT を推奨。
