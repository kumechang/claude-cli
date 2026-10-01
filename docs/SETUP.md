# サーバー初期設定と自動デプロイ

構成: **GitHub の `main` に push → GitHub Actions がテスト → SSH でサーバーの `deploy.sh` を実行 → 更新・再起動**

```
push main ─▶ Actions(npm test) ─▶ ssh deploy@VPS ─▶ git reset --hard origin/main
                                                  ─▶ systemctl restart (実行中ジョブの完了を待つ)
                                                  ─▶ /healthz 確認、失敗なら自動ロールバック
```

| 場所 | 内容 |
|---|---|
| `/opt/claude-cli` | コード(deploy ユーザー所有。デプロイで上書きされる) |
| `/etc/claude-cli-server/env` | 環境変数・秘密情報(デプロイで消えない) |
| `/etc/claude-cli-server/projects.json` | 案件定義(デプロイで消えない) |
| `/var/lib/claude-cli/queue` | キューと結果(claude ユーザー所有) |

## 0. VPS を借りたら
- Ubuntu 26.04 LTS、root(または sudo 可能ユーザー)で SSH ログインできる状態にする。
- 目安: 1 vCPU / 1〜2GB RAM(claude CLI は1つずつ実行するため)。
- 外部公開する場合はドメインを VPS の IP に向けておく(手順 6)。

## 1. デプロイ用 SSH 鍵を作る(手元の PC で)
```bash
ssh-keygen -t ed25519 -N '' -C github-actions-deploy -f ./gha_deploy
# gha_deploy.pub → サーバー設定で使う / gha_deploy(秘密鍵) → GitHub Secrets に登録
```

## 2. サーバーの初期設定(VPS に root で1回だけ)
```bash
git clone https://github.com/<owner>/<repo>.git /tmp/claude-cli && cd /tmp/claude-cli   # private なら ZIP 等で deploy/setup.sh だけ置いてもよい
sudo REPO=<owner>/<repo> DEPLOY_PUBKEY="$(cat gha_deploy.pub の中身)" bash deploy/setup.sh
```
`setup.sh` がやること: Node.js 20+ と claude CLI のインストール、`claude`(実行用)/`deploy`(デプロイ用)ユーザー作成、
`/opt/claude-cli` への clone、設定ファイルの雛形配置、systemd 登録、sudoers(`deploy` は `systemctl restart claude-cli-server` のみ可)、ufw(SSH のみ許可)。
**private リポジトリの場合**: clone に失敗すると公開鍵が表示されます。リポジトリの *Settings → Deploy keys* に **Read-only** で登録して、同じコマンドを再実行してください。

## 3. 設定を編集
`sudo nano /etc/claude-cli-server/env`
```
API_TOKEN=<長いランダム文字列>       # openssl rand -hex 32
ADMIN_EMAIL=...  MAIL_FROM=...  SMTP_HOST=...  SMTP_PORT=587  SMTP_USER=...  SMTP_PASS=...
GITHUB_TOKEN_ALPHA=<fine-grained PAT (対象リポジトリのみ Contents: write)>
CLAUDE_CODE_OAUTH_TOKEN=<手順 4>
```
`sudo nano /etc/claude-cli-server/projects.json` で案件を定義(README の「案件と結果ハンドラ」参照)。`workDir` は `/srv/workspace/<案件>` など(事前に `sudo install -d -o claude -g claude <dir>`)。

## 4. claude CLI の認証
サーバーにブラウザがないため、長期トークン方式を推奨します(Claude サブスクリプションが必要)。
```bash
sudo -u claude -H claude setup-token     # 表示された URL を手元のブラウザで開いて承認 → トークンが出力される
```
出力されたトークンを `/etc/claude-cli-server/env` の `CLAUDE_CODE_OAUTH_TOKEN=` に設定します。
本サーバーは Claude API は使わず、claude CLI(サブスクリプション認証)のみを使います。API キーが環境にあっても CLI に渡さない作りです。
認証が切れた場合はヘルスチェックが `ADMIN_EMAIL` に通知します。

## 5. 起動と確認
```bash
sudo systemctl start claude-cli-server
sudo systemctl status claude-cli-server
journalctl -u claude-cli-server -f
curl localhost:3000/healthz
curl -XPOST localhost:3000/projects/alpha/run -H "Authorization: Bearer $API_TOKEN" -H 'Content-Type: application/json' -d '{"prompt":"こんにちは"}'
```

## 6. HTTPS で公開する(外部から使う場合は必須)
Bearer トークンが平文で流れないよう、Caddy で TLS 終端します(証明書は自動取得)。
```bash
sudo apt install -y caddy
echo 'claude.example.com { reverse_proxy 127.0.0.1:3000 }' | sudo tee /etc/caddy/Caddyfile
sudo systemctl reload caddy && sudo ufw allow 80,443/tcp
```
アプリ(3000番)は ufw で閉じたままにします。

## 7. 自動デプロイの有効化(GitHub 側)
リポジトリの *Settings → Secrets and variables → Actions* に登録:

| Secret | 値 |
|---|---|
| `DEPLOY_HOST` | VPS の IP またはホスト名(**未設定だとデプロイはスキップ**) |
| `DEPLOY_SSH_KEY` | 手順1の秘密鍵 `gha_deploy` の中身 |
| `DEPLOY_KNOWN_HOSTS` | `ssh-keyscan -t ed25519 <host>` の出力(ホスト鍵固定) |
| `DEPLOY_USER` | 省略可(既定 `deploy`) |
| `DEPLOY_PORT` | 省略可(既定 22) |

以降、`main` への push で自動デプロイされます。手動実行は *Actions → deploy → Run workflow*。

## 運用メモ
- デプロイ(再起動)時は実行中の1ジョブの完了を待ってから停止します(最大15分)。未実施のプロンプトは `pending` に残り、起動後に再開されます。
- 新しいバージョンが起動しなければ、自動で前のコミットに戻して失敗として終了します。
- 設定変更(env / projects.json)は `sudo systemctl restart claude-cli-server` で反映。
- claude CLI の更新: `sudo npm update -g @anthropic-ai/claude-code`
- SSH はパスワード認証を無効化することを推奨(`PasswordAuthentication no`)。
