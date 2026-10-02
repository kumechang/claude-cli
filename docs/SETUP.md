# サーバー初期設定・運用ガイド

想定: Kagoya VPS(最安プラン: 1コア / 1GB / 100GB)、Ubuntu 26.04 LTS、ドメインなし(IP 直接)、個人利用。

```
cron-job.org ─▶ GitHub API ─▶ GitHub Actions ─▶ POST https://<IP>.sslip.io/projects/<案件>/run ─▶ VPS(このサーバー)
GitHub main に push ─▶ Actions(テスト) ─▶ SSH で deploy.sh ─▶ 更新・再起動・ヘルスチェック(失敗時は自動ロールバック)
```

| 場所 | 内容 |
|---|---|
| `/opt/claude-cli` | コード(deploy ユーザー所有。デプロイで上書き) |
| `/etc/claude-cli-server/env` | 環境変数・秘密情報(デプロイで消えない) |
| `/etc/claude-cli-server/projects.json` | 案件定義(デプロイで消えない) |
| `/var/lib/claude-cli/queue/<案件>/` | `pending/ done/ failed/`、`finalize.log` |
| `/srv/workspace/<案件>/` | claude の作業ディレクトリ(`outbox/<id>/` に送信データが出力される) |

## 0. 1コア・1GB で claude CLI は動くか
**動く見込みだが余裕はない**、というのが正直な評価です(私の環境では実機検証できていません)。
- claude CLI は Node.js 製で、1回の実行で数百MB のメモリを使うことがあります。OS と本サーバーで約 300MB 使うため、**1GB だとほぼ余りません**。公式の動作要件はもっと大きい(4GB 以上だったと記憶。要確認)ので、軽い用途向けです。
- 対策(いずれも実装済み): ① `setup.sh` が **2GB のスワップ**を作る ② claude の**同時実行は1つだけ** ③ ヘルスチェックも同時には走らせない設計。
- 避けること: 巨大なファイルを大量に読ませる、ブラウザ自動操作(Playwright 等)を使わせる。WebSearch/WebFetch 程度なら通常は問題ありません。
- OOM で落ちた場合は失敗として `failed/` に入り、管理者にメールが飛びます(systemd が自動再起動)。**まず1〜2週間運用して判断**し、不安定なら2GB プランに上げるのが確実です。

## 1. VPS の準備(Kagoya)
- OS は Ubuntu 26.04 LTS を選択し、root または sudo ユーザーで SSH できるようにする。
- Kagoya のコントロールパネルのパケットフィルタで **22 / 80 / 443** を許可する(80/443 は手順6の HTTPS 用)。アプリの 3000 番は開けない。
- 以降の手順は `ssh root@<IP>` した状態で実行。

## 2. デプロイ用 SSH 鍵を作る(手元の PC で)
```bash
ssh-keygen -t ed25519 -N '' -C github-actions-deploy -f ./gha_deploy
# gha_deploy.pub → サーバー設定で使う / gha_deploy(秘密鍵) → GitHub Secrets に登録
```

## 3. サーバーの初期設定(VPS に root で1回だけ)
```bash
git clone https://github.com/kumechang/claude-cli.git /tmp/claude-cli && cd /tmp/claude-cli   # private なら setup.sh を scp で送ってもよい
sudo REPO=kumechang/claude-cli DEPLOY_PUBKEY="$(cat gha_deploy.pub の中身)" bash deploy/setup.sh
```
`setup.sh` がやること: スワップ作成、Node.js 20+ と claude CLI と jq のインストール、`claude`(実行用)/`deploy`(デプロイ用)ユーザー作成、`/opt/claude-cli` への clone、設定ファイルの雛形配置、systemd 登録、sudoers(`deploy` は `systemctl restart claude-cli-server` のみ可)、ufw(22/80/443)。
**private リポジトリの場合**: clone に失敗すると公開鍵が表示されます。リポジトリの *Settings → Deploy keys* に **Read-only** で登録して、同じコマンドを再実行してください。

## 4. 設定を編集
`sudo nano /etc/claude-cli-server/env`
```
API_TOKEN=<長いランダム文字列>        # openssl rand -hex 32
CLAUDE_CODE_OAUTH_TOKEN=<手順5>
GITHUB_TOKEN_MAHJONG=<fine-grained PAT: 送信先リポジトリのみ / Contents: Read and write>
ADMIN_EMAIL=hkumekawa@gmail.com
MAIL_FROM=hkumekawa@gmail.com
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=hkumekawa@gmail.com
SMTP_PASS=<Gmail アプリパスワード(16文字)>
```
`sudo nano /etc/claude-cli-server/projects.json` で案件を定義(README、`projects.example.json` 参照)。作業ディレクトリを作る:
```bash
sudo install -d -o claude -g claude /srv/workspace/mahjong
```

### メール(Gmail 宛て)について
VPS から Gmail 宛てに**直接送信(sendmail / port 25)すると、届かない・迷惑メールになる可能性が高い**です(VPS の IP は評判が低く、SPF/DKIM/逆引きも未設定のため。VPS 事業者が 25 番を制限していることも多い)。
そのため本サーバーは直接配送ではなく、**Gmail の SMTP サーバーにログインして送る方式**です(自分の Gmail から自分宛て)。
1. Google アカウントで **2段階認証**を有効にする
2. https://myaccount.google.com/apppasswords で**アプリパスワード**を作成(16文字)→ `SMTP_PASS` に設定
3. 受信側で迷惑メール扱いされないよう、初回に届いたら「迷惑メールではない」にしておく

SMTP の暗号化(STARTTLS)と認証の流れは、ローカルの擬似サーバーで自動テスト済みです。本物の Gmail との接続は未検証なので、設定後に必ず**テスト送信**してください:
```bash
sudo -u claude env $(sudo cat /etc/claude-cli-server/env | grep -v '^#' | xargs) node -e "require('/opt/claude-cli/src/mailer').sendMail({to:process.env.ADMIN_EMAIL,subject:'テスト',text:'届けば成功'}).then(()=>console.log('sent'),e=>console.error(e.message))"
```

## 5. claude CLI の認証(サブスクリプション)
サーバーにブラウザがないため、長期トークン方式を使います(Claude のサブスクリプションが必要。API は使いません)。
```bash
sudo -u claude -H claude setup-token     # 表示された URL を手元のブラウザで開いて承認 → トークンが出力される
```
出力されたトークンを `/etc/claude-cli-server/env` の `CLAUDE_CODE_OAUTH_TOKEN=` に設定します。
切れた場合はヘルスチェックが `ADMIN_EMAIL` に通知するので、同じ手順でトークンを作り直して `systemctl restart claude-cli-server` します。

## 6. HTTPS で公開する(IP 直接 + ドメインなし)
**HTTP のままだと Bearer トークンが平文で流れ、盗まれると誰でもサーバー上で claude を動かせます。** ドメインを契約しなくても、
IP をホスト名にしてくれる無料サービス **sslip.io**(例: IP `203.0.113.5` → `203-0-113-5.sslip.io`)と Caddy で、正規の証明書(Let's Encrypt)を自動取得できます。
```bash
sudo apt install -y caddy
echo '203-0-113-5.sslip.io { reverse_proxy 127.0.0.1:3000 }' | sudo tee /etc/caddy/Caddyfile   # 自分の IP に置き換える
sudo systemctl reload caddy
curl https://203-0-113-5.sslip.io/healthz
```
- sslip.io 側の都合で証明書が発行できない場合は、無料の DDNS(DuckDNS など)のホスト名で同じことができます。
- どうしても HTTP のままにする場合は、`API_TOKEN` を使い捨て前提にして、claude の権限(`--allowedTools`)を最小にしてください(推奨しません)。

## 7. 起動と確認
```bash
sudo systemctl start claude-cli-server
sudo systemctl status claude-cli-server
journalctl -u claude-cli-server -f
curl -XPOST https://203-0-113-5.sslip.io/projects/mahjong/run -H "Authorization: Bearer $API_TOKEN" -H 'Content-Type: application/json' -d '{"prompt":"American Mahjong の最新のルール変更を調べて Markdown にまとめて。保存先: リポジトリ kumechang/mahjong-data、ブランチ main、フォルダ docs/rules"}'
ls /var/lib/claude-cli/queue/mahjong/done; cat /var/lib/claude-cli/queue/mahjong/finalize.log
```

## 8. 自動デプロイ(GitHub 側)
リポジトリの *Settings → Secrets and variables → Actions* に登録:

| Secret | 値 |
|---|---|
| `DEPLOY_HOST` | VPS の IP(**未設定だとデプロイはスキップ**) |
| `DEPLOY_SSH_KEY` | 手順2の秘密鍵 `gha_deploy` の中身 |
| `DEPLOY_KNOWN_HOSTS` | `ssh-keyscan -t ed25519 <IP>` の出力(ホスト鍵固定) |
| `DEPLOY_USER` / `DEPLOY_PORT` | 省略可(既定 `deploy` / 22) |

以降、`main` への push で自動デプロイされます。手動実行は *Actions → deploy → Run workflow*。
デプロイ(再起動)時は実行中の1件の完了を待ってから停止し(最大15分)、未実施のプロンプトは pending に残って再開されます。新バージョンが起動しなければ自動でロールバックします。

## 9. 呼び出し元(GitHub Actions)の例
cron-job.org から GitHub API(`workflow_dispatch`)を叩き、Actions 内でこのサーバーへ投げる想定。*Secrets* に `CLAUDE_SERVER_URL`(`https://203-0-113-5.sslip.io`)と `CLAUDE_SERVER_TOKEN`(= `API_TOKEN`)を登録:
```yaml
on: workflow_dispatch
jobs:
  kick:
    runs-on: ubuntu-latest
    steps:
      - run: |
          jq -n --arg p "American Mahjong の最新情報を調べて Markdown にまとめて。保存先: リポジトリ kumechang/mahjong-data、ブランチ main、フォルダ docs/news" '{prompt:$p}' |
          curl -fsS -X POST "$URL/projects/mahjong/run" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' --data-binary @-
        env:
          URL: ${{ secrets.CLAUDE_SERVER_URL }}
          TOKEN: ${{ secrets.CLAUDE_SERVER_TOKEN }}
```
投げっぱなしで構いません(202 が返れば受付完了。結果は VPS 側で処理され、失敗時はメールが届きます)。

## 10. 死活監視(UptimeRobot)
- 監視タイプ: HTTP(s)、URL: `https://203-0-113-5.sslip.io/healthz`(認証不要)。サーバーが落ちていれば通知されます。
- claude の認証切れまで UptimeRobot で検知したい場合は `https://…/healthz?strict=1`(異常時 503)を登録。(認証切れは本サーバーからもメールが届きます)

## 運用メモ
- 設定変更(env / projects.json)は `sudo systemctl restart claude-cli-server` で反映。
- ログ: `journalctl -u claude-cli-server`、送信処理のログ: `queue/<案件>/finalize.log`。
- 機密情報の疑いで送信が止まった場合はメールが届きます。`outbox/<id>/` の該当ファイルを確認・修正後、次のリクエスト(またはサービス再起動)で再チェックして送信します。
- 失敗したプロンプトの再実行: `queue/<案件>/failed/<id>.md` を `pending/` に移して、何かリクエストを送る。
- claude CLI の更新: `sudo npm update -g @anthropic-ai/claude-code`
- SSH のパスワード認証は無効化を推奨(`PasswordAuthentication no`)。
