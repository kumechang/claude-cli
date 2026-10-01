#!/usr/bin/env bash
# Ubuntu サーバーの初期設定(root で1回だけ実行。再実行しても安全)。
#   sudo REPO=owner/repo DEPLOY_PUBKEY="ssh-ed25519 AAAA... gha" bash setup.sh
set -euo pipefail
: "${REPO:?REPO=owner/repo を指定してください}"
: "${DEPLOY_PUBKEY:?DEPLOY_PUBKEY (GitHub Actions が使う SSH 公開鍵) を指定してください}"
APP=/opt/claude-cli
CONF=/etc/claude-cli-server

[ "$(id -u)" = 0 ] || { echo "root で実行してください"; exit 1; }
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y git curl ca-certificates ufw

# Node.js 20+ (apt の版が古ければ NodeSource 22 にフォールバック)
node_major() { node -v 2>/dev/null | sed 's/^v//; s/\..*//' || echo 0; }
if [ "$(node_major || echo 0)" -lt 20 ] 2>/dev/null; then
  apt-get install -y nodejs npm || true
fi
if [ "$(node_major || echo 0)" -lt 20 ] 2>/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
[ "$(node_major)" -ge 20 ] || { echo "Node.js 20+ のインストールに失敗"; exit 1; }
command -v claude >/dev/null || npm install -g @anthropic-ai/claude-code

# ユーザー: claude(サービス実行用・ログイン不可) / deploy(GitHub Actions 用 SSH ユーザー)
id claude >/dev/null 2>&1 || useradd -m -s /bin/bash claude
id deploy >/dev/null 2>&1 || useradd -m -s /bin/bash deploy
install -d -m700 -o deploy -g deploy /home/deploy/.ssh
grep -qxF "$DEPLOY_PUBKEY" /home/deploy/.ssh/authorized_keys 2>/dev/null || echo "$DEPLOY_PUBKEY" >> /home/deploy/.ssh/authorized_keys
chown deploy:deploy /home/deploy/.ssh/authorized_keys; chmod 600 /home/deploy/.ssh/authorized_keys

# deploy が systemctl restart だけ sudo できるようにする
cat > /etc/sudoers.d/claude-cli-deploy <<SUDO
deploy ALL=(root) NOPASSWD: /usr/bin/systemctl restart claude-cli-server, /usr/bin/systemctl is-active claude-cli-server
SUDO
chmod 440 /etc/sudoers.d/claude-cli-deploy
visudo -cf /etc/sudoers.d/claude-cli-deploy

# リポジトリ取得用の読み取り専用 Deploy Key(private リポジトリ用)
if [ ! -f /home/deploy/.ssh/id_ed25519 ]; then
  sudo -u deploy ssh-keygen -t ed25519 -N '' -C "deploy@$(hostname)" -f /home/deploy/.ssh/id_ed25519
fi
sudo -u deploy ssh-keyscan -t ed25519 github.com >> /home/deploy/.ssh/known_hosts 2>/dev/null || true

# コード・設定・データ
install -d -o deploy -g deploy "$APP"
install -d -m750 -o root -g claude "$CONF"
install -d -o claude -g claude /var/lib/claude-cli/queue /srv/workspace
if [ ! -d "$APP/.git" ]; then
  sudo -u deploy git clone "git@github.com:${REPO}.git" "$APP" || {
    echo
    echo "clone に失敗。リポジトリの Settings > Deploy keys に次の公開鍵(Read-only)を登録して再実行してください:"
    cat /home/deploy/.ssh/id_ed25519.pub
    exit 1
  }
fi
[ -f "$CONF/env" ] || install -m640 -o root -g claude "$APP/.env.example" "$CONF/env"
[ -f "$CONF/projects.json" ] || install -m640 -o root -g claude "$APP/projects.example.json" "$CONF/projects.json"
grep -q '^QUEUE_DIR=' "$CONF/env" || echo "QUEUE_DIR=/var/lib/claude-cli/queue" >> "$CONF/env"
grep -q '^PROJECTS_FILE=' "$CONF/env" || echo "PROJECTS_FILE=$CONF/projects.json" >> "$CONF/env"

install -m644 "$APP/deploy/claude-cli-server.service" /etc/systemd/system/claude-cli-server.service
systemctl daemon-reload
systemctl enable claude-cli-server

# ファイアウォール(SSH のみ許可。HTTP を公開する場合は TLS 用の 443 を別途許可)
ufw allow OpenSSH >/dev/null
ufw --force enable >/dev/null

cat <<MSG

== 初期設定完了 (まだサービスは起動していません) ==
次の作業(詳細: docs/SETUP.md):
  1. $CONF/env を編集 (API_TOKEN, SMTP, ADMIN_EMAIL, GitHub トークン)
  2. $CONF/projects.json を編集
  3. claude の認証: sudo -u claude -H claude setup-token  → 出力トークンを env の CLAUDE_CODE_OAUTH_TOKEN に設定
  4. sudo systemctl start claude-cli-server
MSG
