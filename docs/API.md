# API リファレンス

claude-cli-server の HTTP API の使い方とアクセス方法。

- ベース URL: `https://133-18-253-149.sslip.io`(HTTPS のみ。アプリ本体は `127.0.0.1:3000` で待ち受け、外部には Caddy が公開している)
- 形式: リクエスト・レスポンスともに JSON(UTF-8)
- 認証: `/healthz` 以外は Bearer トークン必須

## 概要

プロンプトを送ると、サーバー上の claude CLI(`claude -p`)が非対話で実行し、結果を GitHub に push します。
**投げっぱなし**で使う設計です。`POST` は受付だけして `202` をすぐ返し、実行は非同期に行われます。

```
POST /projects/<案件>/run  ─▶ 202 + id(受付完了)
                              └▶ キューに保存 ─▶ 1件ずつ claude 実行 ─▶ 全部終わったら GitHub に push
GET  /projects/<案件>/jobs/<id>  ─▶ 状態(queued / running / done / failed)
```

## 認証

`Authorization: Bearer <API_TOKEN>` ヘッダーを付けます。`API_TOKEN` はサーバーの `/etc/claude-cli-server/env` に設定した値です。

```
Authorization: Bearer <API_TOKEN>
```

- 不一致・未指定は `401 {"error":"unauthorized"}`。
- **案件専用トークン**: 案件に `tokenEnv` を設定すると、その案件専用のトークンを発行できます(サーバーの `env` に 32 文字以上の値を設定)。
  専用トークンは**その案件の API だけ**で使えます(他の案件は 401)。全体の `API_TOKEN` は全案件で使えます。
  外部システムには専用トークンを渡し、漏洩したときの影響範囲をその案件に限定します。
  存在しない案件名でも、トークンが違えば 401 を返します(案件の有無は分かりません)。
- トークンは**HTTPS 経由でのみ**送ること(平文の HTTP は使わない)。
- トークンを知っている人は、サーバー上で claude を動かせます。ログ・リポジトリ・チャットに貼らないでください(GitHub Actions では Secrets に入れる)。

## エンドポイント一覧

| メソッド | パス | 認証 | 用途 |
|---|---|---|---|
| `POST` | `/projects/<案件>/run` | 必要 | プロンプトを送信(キューに追加) |
| `GET` | `/projects/<案件>/jobs/<id>` | 必要 | 送信したプロンプトの状態を確認 |
| `GET` / `HEAD` | `/healthz` | **不要** | 死活監視 |

`<案件>` は、サーバーの `projects.json` に定義した案件名です(現在は `mahjong`)。小文字英数字・`-`・`_` のみ。未定義の名前は `404`。

---

## `POST /projects/<案件>/run`

プロンプトを受け付けて、キューに追加します。

### リクエスト

| ヘッダー | 値 |
|---|---|
| `Authorization` | `Bearer <API_TOKEN>` |
| `Content-Type` | `application/json` |

ボディ:

```json
{ "prompt": "American Mahjong の最新ルール変更を調べて Markdown にまとめて。保存先: リポジトリ kumechang/mahjong-data、ブランチ main、フォルダ news" }
```

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| `prompt` | string | 必須 | claude に実行させるプロンプト。空文字・空白のみは不可。最大 1MB |

### レスポンス

`202 Accepted`

```json
{
  "project": "mahjong",
  "id": "2026-10-05T11-12-48-731Z-8fd79f",
  "status": "queued",
  "statusUrl": "/projects/mahjong/jobs/2026-10-05T11-12-48-731Z-8fd79f"
}
```

`id` は受付時刻(UTC)を含む一意の ID です。処理は `id`(=受付順)の古いものから順に行われます。

### エラー

| ステータス | 内容 |
|---|---|
| `400` | JSON が不正 / `prompt` が文字列でない・空 |
| `401` | 認証エラー |
| `404` | 案件が未定義 |
| `413` | ボディが 1MB を超えた(接続が切れる場合もある) |
| `500` | サーバー内部エラー |

### curl の例

プロンプトに引用符や改行が入っても壊れないよう、`jq` で JSON を組み立てるのがおすすめです。

```bash
export API_TOKEN=...   # 画面やログに出さない
PROMPT='American Mahjong の最新情報を調べて Markdown にまとめて。保存先: リポジトリ kumechang/mahjong-data、ブランチ main、フォルダ news'

jq -n --arg p "$PROMPT" '{prompt:$p}' | curl -fsS -X POST https://133-18-253-149.sslip.io/projects/mahjong/run \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary @-
```

ファイルのプロンプトを送る場合:

```bash
jq -Rs '{prompt: .}' prompt.md | curl -fsS -X POST https://133-18-253-149.sslip.io/projects/mahjong/run \
  -H "Authorization: Bearer $API_TOKEN" -H "Content-Type: application/json" --data-binary @-
```

---

## `GET /projects/<案件>/jobs/<id>`

送信したプロンプトの状態を返します。

### レスポンス

`200 OK`

```json
{ "project": "mahjong", "id": "2026-10-05T11-12-48-731Z-8fd79f", "status": "done" }
```

| `status` | 意味 |
|---|---|
| `queued` | 実行待ち |
| `running` | claude が実行中 |
| `done` | claude の実行が完了(結果は保存済み)。送信処理(GitHub への push)がある案件は、その案件の未実施がなくなってから行われる |
| `failed` | 実行に失敗(リトライ上限まで失敗、またはタイムアウト)。`error` に理由が入る |

`done` / `failed` の応答には `finishedAt`(完了時刻。ISO 8601・UTC。例: `2026-10-08T03:21:42.000Z`)が付きます。

**案件の設定 `returnResult` によって、`done` / `failed` の形が変わります。**

| | `returnResult` なし(`mahjong` など。従来どおり) | `returnResult: true`(`x-growth`) |
|---|---|---|
| `done` | `{project, id, status, finishedAt}` | `{project, id, status, result: {text}, finishedAt}` |
| `failed` | `{project, id, status, error: "文字列", finishedAt}` | `{project, id, status, error: {message}, finishedAt}` |

`failed` の例(従来の案件):

```json
{ "project": "mahjong", "id": "...", "status": "failed", "error": "claude が終了コード 1 で失敗: ...", "finishedAt": "2026-10-08T03:21:42.000Z" }
```

### エラー

`401`(認証)/ `404`(案件が未定義、または id が存在しない)

### curl の例

```bash
curl -fsS https://133-18-253-149.sslip.io/projects/mahjong/jobs/<id> -H "Authorization: Bearer $API_TOKEN"
```

> `done` は「claude の実行が済んだ」という意味で、GitHub への push の成否は含みません。
> push の結果は、サーバー上の `queue/<案件>/finalize.log` と、失敗時の管理者宛てメールで確認します。

---

## `GET /healthz`(死活監視)

認証不要。`HEAD` も使えます(UptimeRobot などの監視用)。

```bash
curl https://133-18-253-149.sslip.io/healthz
```

```json
{ "ok": true, "workerRunning": false, "claude": { "ok": true, "kind": null, "checkedAt": "2026-10-05T08:32:48.544Z" } }
```

| フィールド | 意味 |
|---|---|
| `ok` | サーバーが稼働中(常に `true`) |
| `workerRunning` | プロンプトを処理中か(未実施がなければ `false`) |
| `claude.ok` | claude CLI の認証・動作が正常か(30分ごとに実際に実行して確認) |
| `claude.kind` | 異常時の種別。`auth`(認証切れ)/ `error`(その他) |
| `claude.checkedAt` | 最後に確認した時刻(UTC) |

`/healthz?strict=1` は、`claude.ok` が `false` のとき `503` を返します(claude の認証切れまで監視したい場合に使う)。
エラー詳細は含みません(認証不要のため)。

---

## 結果を応答で返す案件(`x-growth`)

GitHub に送らず、生成テキストを API の応答で受け取る案件です(Web アプリなどの呼び出し元が、ポーリングで結果を取得する用途)。

- 案件名: `x-growth`
- 認証: 専用トークン(または全体の `API_TOKEN`)
- 使い方: `POST /projects/x-growth/run` → `id` を受け取る → `GET /projects/x-growth/jobs/<id>` を **2 秒間隔**でポーリング → `done` になったら `result.text` を取得
- 呼び出し側のタイムアウトは **3 分**を目安にしてください(サーバー側は 150 秒で `failed` にします)
- claude は**ツールなし**(ファイル操作・Web 検索なし)で、プロンプトから文章を生成するだけです。`outbox` や送信先の指示は付きません

```bash
# 送信
jq -n --arg p "$PROMPT" '{prompt:$p}' | curl -fsS -X POST https://133-18-253-149.sslip.io/projects/x-growth/run \
  -H "Authorization: Bearer $XGROWTH_API_TOKEN" -H "Content-Type: application/json" --data-binary @-
# → {"project":"x-growth","id":"2026-10-08T03-21-10-123Z-abc123","status":"queued","statusUrl":"/projects/x-growth/jobs/2026-10-08T03-21-10-123Z-abc123"}

# 結果の取得(2 秒間隔でポーリング)
curl -fsS https://133-18-253-149.sslip.io/projects/x-growth/jobs/<id> -H "Authorization: Bearer $XGROWTH_API_TOKEN"
```

完了時(`done`):

```json
{
  "project": "x-growth",
  "id": "2026-10-08T03-21-10-123Z-abc123",
  "status": "done",
  "result": { "text": "<claude の出力。加工なし>" },
  "finishedAt": "2026-10-08T03:21:42.000Z"
}
```

失敗時(`failed`):

```json
{
  "project": "x-growth",
  "id": "2026-10-08T03-21-10-123Z-abc123",
  "status": "failed",
  "error": { "message": "claude がタイムアウトしました (150000ms)" },
  "finishedAt": "2026-10-08T03:23:40.000Z"
}
```

補足:
- `result.text` は claude の出力テキストを**そのまま**(Markdown 変換・整形・前後の空白の除去なし)返します。JSON などの構造化は、プロンプトの設計で指示してください。
- `finishedAt` は ISO 8601(UTC・`:` 区切り)です。`id` に含まれる時刻は `-` 区切りの別形式なので、混同しないでください。
- `result.text` のサイズ上限はサーバー側にはありません(claude の最大出力トークンまで)。
- 結果は 3 日後に自動削除されます。取得したら呼び出し側で保存してください。
- プロンプトには個人情報などが含まれる場合があります。サーバー上のキューのファイルにも、保持期間の間は残ります。

## プロンプトの書き方(送信先の指定)

claude は、プロンプトの内容に従って調べものや文書作成を行います。結果を GitHub に送りたい場合は、**プロンプトに送信先を書きます**。

```
<依頼の内容>

保存先: リポジトリ <owner>/<repo>、ブランチ <ブランチ名>、フォルダ <フォルダ名>
```

サーバー側の処理(自動):
1. claude が成果物を `outbox/<id>/` に出力し、送信先を `_target.json` に書き出す
2. 未実施のプロンプトがなくなったら、`scripts/github-push.sh` が `_target.json` を検証して GitHub API で push する

### 送信先の動作

| プロンプトの指定 | 動作 |
|---|---|
| ブランチ `main`(または指定なし) | 今のブランチに直接コミット。PR は作らない |
| `main` 以外のブランチ(例: `inbox/2026-10-05`) | ブランチがなければ作成(ベースは既定ブランチ)→ push → **プルリクエストを自動作成**(open な PR があれば作らない) |
| 「PR だけ作って(ファイルは作らない)」+ 既存ブランチ | PR だけ作成。ブランチは作らない |
| 送信先の記載なし | 送信しない(結果はサーバー内に保存されるだけ) |

`_target.json` に claude が書くキー(プロンプトで指示すれば反映される):

| キー | 必須 | 説明 |
|---|---|---|
| `repo` | 必須 | `owner/name` |
| `branch` | 任意 | 既定 `main` |
| `dir` | 任意 | 格納フォルダ(リポジトリ内の相対パス) |
| `base` | 任意 | 新規ブランチ・PR のベース(既定はリポジトリの既定ブランチ) |
| `pr` | 任意 | `false` で PR を作らない |
| `pr_title` / `pr_body` | 任意 | PR のタイトル・本文 |

### 制限

- 送信を許可するリポジトリは、サーバー設定 `GH_ALLOWED_REPOS`(現在 `kumechang/*`)に含まれるものだけ。範囲外は送信されず、管理者にメールが届きます。
- `dir` に `..` や絶対パスは使えません。
- 送信前に機密情報(API キー・秘密鍵など)の簡易チェックが行われ、疑わしい場合は送信せず管理者にメールが届きます。
- GitHub のトークンには、対象リポジトリに対する Contents と Pull requests の書き込み権限が必要です(サーバー側の設定)。

---

## 動作の仕様

- **実行の順序**: 同じ案件の中は**1件ずつ(受付順)**。**案件が違えば並列**に実行します(全体で最大 `CLAUDE_MAX_CONCURRENCY` 件、既定 2)。長い案件のジョブに、短い案件が待たされません。
- **送信のタイミング**: 送信処理(finalize)がある案件は、その案件の未実施がなくなったあと、結果ごとに送信(push)されます。連続して複数送ると、まとめて処理されます。
- **タイムアウト**: 1件あたりの上限は案件の `timeoutMs`(`mahjong` は 15 分、`x-growth` は 150 秒)。超えると、すぐ `failed`(`error` に「タイムアウト」)になります。
- **保持期間**: 案件の `retentionDays` を過ぎた結果は自動で削除されます(`x-growth` は 3 日)。設定がない案件は残り続けます。
- **リトライ**: 案件の `maxAttempts`(既定 2)。既定では 60 秒後に1回だけ自動で再実行(`x-growth` は 1 =リトライなし)。それでも失敗なら `failed` になり、管理者にメールが届きます。送信(push)の失敗は最大3回まで再試行します。
- **認証切れ**: claude の認証が切れている間は、実行せず保留(`queued` のまま)。復旧すると自動で再開します(管理者にメールが届きます)。
- **使用モデル**: サーバーの設定による(`--model` で固定可能)。サブスクリプションの利用枠を消費します。

## 呼び出し元の例(GitHub Actions)

```yaml
- name: プロンプトを送信
  env:
    URL: ${{ secrets.CLAUDE_SERVER_URL }}      # https://133-18-253-149.sslip.io
    TOKEN: ${{ secrets.CLAUDE_SERVER_TOKEN }}  # API_TOKEN
  run: |
    jq -Rs '{prompt: .}' prompts/daily.md |
      curl -fsS --retry 3 --retry-delay 5 --max-time 60 -X POST "$URL/projects/mahjong/run" \
        -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --data-binary @-
```

雛形は `docs/caller/kick-claude.yml`、cron-job.org からの起動方法は `docs/SETUP.md` の「9. 呼び出し元」を参照してください。

## トラブルシューティング

| 症状 | 原因と対処 |
|---|---|
| `401 unauthorized` | トークンの不一致。`Authorization: Bearer ` の後ろの値と `env` の `API_TOKEN` を確認(空白・改行の混入、引用符崩れに注意) |
| `404 unknown project` | 案件名の誤り。`projects.json` の名前を確認 |
| `400 "prompt" (string) is required` | ボディが JSON でない、または `prompt` が空。`jq -n --arg p "$PROMPT" '{prompt:$p}'` で組み立てる |
| 接続できない・証明書エラー | URL が `https://` か確認。Caddy が動いているか(`sudo systemctl status caddy`) |
| `queued` のまま進まない | claude の認証切れの可能性。`/healthz` の `claude.ok` と、管理者宛てのメールを確認 |
| `done` なのに GitHub に反映されない | push の失敗。サーバーの `queue/<案件>/finalize.log` と通知メールを確認(PAT の権限不足・送信先が許可範囲外など) |

## サーバー上のログと結果

`/var/lib/claude-cli/queue/<案件>/` に保存されます。

| 場所 | 内容 |
|---|---|
| `pending/` | 未実施 |
| `done/<id>.md` / `.json` | 実施済み(プロンプトと結果 / 生の出力) |
| `failed/<id>.md` / `.error.txt` | 失敗したプロンプトと理由 |
| `finalize.log` | GitHub への送信(push・PR 作成)のログ |

サービスのログ: `journalctl -u claude-cli-server`
