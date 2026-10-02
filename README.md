# claude-cli-server

HTTP で受けたプロンプトをサーバーの `claude` CLI(`claude -p`、サブスクリプション認証。API は使わない)で順次実行し、
案件ごとに定義した「送信スクリプト」で最後にデータを送る個人用ツール。依存パッケージなし(Node.js 20+)。

## 動作
1. `POST /projects/<案件>/run` でプロンプトを受信(Bearer 認証必須)→ `queue/<案件>/pending/<id>.md` に保存 → ワーカー起動
2. 全案件の pending が空になるまで、古い順に1件ずつ `claude -p` を実行(同時実行は1つ)。claude は案件の `workDir` で動く。
   サーバーがシステムプロンプトに**出力先 `outbox/<id>/`** を追記するので、claude は送りたいファイルをそこに出力する。
   **送信先(GitHub のリポジトリ・ブランチ・格納フォルダ)はプロンプトに書く**。claude がそれを `outbox/<id>/_target.json` に書き出す
3. 結果は `queue/<案件>/done/<id>.md|json` に保存(増え続けてよい)
4. pending が空になったら、結果のあった各プロンプトについて**送信スクリプト(finalize)を実行** → ワーカー停止(HTTP 受付は継続。次のリクエストで再起動)
   - 送信前に `outbox/<id>/` と結果を**機密情報チェック**。疑わしいものがあれば送信せず管理者にメール
   - 送信が失敗したら管理者にメールし、次回のワーカー実行時に再試行(最大3回)

呼び出し元は投げっぱなしでよい(202 が返る)。状態確認: `GET /projects/<案件>/jobs/<id>`(queued/running/done/failed)

### プロンプトの書き方の例
```
American Mahjong の 2026 年のカード(NMJL)の変更点を調べて、日本語の Markdown にまとめて。
保存先: リポジトリ owner/mahjong-data、ブランチ main、フォルダ docs/2026
```

## 失敗時の扱い
- claude の実行失敗は、間を置いて**1回だけ自動リトライ**(`maxAttempts` 既定2、`retryDelayMs` 既定60秒)。それでも失敗なら `queue/<案件>/failed/` に置き、管理者にメール。
  無制限リトライはしない(サブスクリプションの利用枠を消費し、同じ失敗を繰り返すため)。
- 手動で再実行したいとき: `failed/<id>.md` を `pending/` に移し、何かリクエストを送る(またはサービス再起動)。
- 認証切れは失敗扱いにせず、pending に残して停止(下記)。

## 案件(projects.json)
`projects.example.json` 参照。案件ごとに次を設定:
- `workDir`: claude の作業ディレクトリ / `instructions`: システムプロンプトへの追記 / `claudeArgs`: `--allowedTools` `--permission-mode` など
- `outbox`: 出力先の親フォルダ(`workDir` 相対、既定 `outbox`。実際の出力先は `outbox/<id>/`)
- `finalize.command`: 送信スクリプト(配列。シェルは介さない)。`finalize.env` で追加の環境変数。省略すると送信なし。`finalize.maxAttempts`(既定3)
  - スクリプトには `PROJECT_NAME` `PROJECT_DIR` `RESULT_ID` `OUTBOX_DIR`(=`outbox/<id>`) `DONE_DIR` が渡される。終了コード 0 で成功
  - 標準の `scripts/github-push.sh`: `_target.json` の送信先に、GitHub API でファイルをコミットする。
    **`GH_ALLOWED_REPOS`(例 `owner/*`)が必須**。プロンプトや claude が読んだ Web ページの内容で、意図しないリポジトリに送られないようにするため。トークンは `GH_TOKEN_VAR` で指定した環境変数
  - メール送信など別の処理にしたい案件は、自作スクリプトを指定する
- `timeoutMs` `maxAttempts` `retryDelayMs` `secretPatterns`(機密チェックの追加正規表現)

## claude CLI の認証監視
起動時と30分ごと(`HEALTHCHECK_INTERVAL_MS`、0で無効)に最小のプロンプトを実行して確認します。
- 異常になったら `ADMIN_EMAIL` にメール(続く間は24時間ごとに再通知)、復旧したら復旧メール
- 認証切れの間はワーカーを止め、プロンプトは pending に残す(復旧を検知したら自動で再開)
- 復旧には管理者が `claude setup-token` / `claude auth login` をやり直す必要がある(docs/SETUP.md)

## 認証・セキュリティ
- `/healthz` 以外は `Authorization: Bearer $API_TOKEN` 必須(定数時間比較)。`API_TOKEN` 未設定では起動しない
- 公開時は HTTPS 必須(docs/SETUP.md)。トークンが平文で流れると、誰でもサーバー上で claude を動かせてしまう
- claude には最小限の環境変数しか渡さない(API_TOKEN・SMTP・GitHub トークンなどは見えない)。`ANTHROPIC_API_KEY` も渡さない
- claude の権限(`--allowedTools` / `--permission-mode`)は案件ごとに必要最小限にする
- **public リポジトリへ送るため、機密チェックと `GH_ALLOWED_REPOS` が最後の砦**。トークンは送信先リポジトリだけに絞った fine-grained PAT にする

## 死活監視
`GET /healthz`(認証不要・HEAD 可)が 200 を返せば稼働中。`/healthz?strict=1` は claude の認証が異常のとき 503。UptimeRobot 等に登録する。

## 設定・環境変数
`PORT` `QUEUE_DIR` `PROJECTS_FILE` `CLAUDE_TIMEOUT_MS`、メール: `ADMIN_EMAIL` `MAIL_FROM` `SMTP_HOST` `SMTP_PORT` `SMTP_USER` `SMTP_PASS`、
ヘルスチェック: `HEALTHCHECK_INTERVAL_MS` `HEALTHCHECK_REMIND_MS` `HEALTHCHECK_ARGS`。

## サーバー設定・自動デプロイ・呼び出し方
[docs/SETUP.md](docs/SETUP.md) を参照(Ubuntu 初期設定、`main` への push で自動デプロイ、HTTPS、メール、UptimeRobot、GitHub Actions からの呼び出し例)。
