#!/usr/bin/env bash
# サーバー上で GitHub Actions から実行される(deploy ユーザー)。失敗したら直前のコミットに戻す。
set -euo pipefail
APP=/opt/claude-cli
PORT=$(grep -E '^PORT=' /etc/claude-cli-server/env 2>/dev/null | cut -d= -f2 || true)
PORT=${PORT:-3000}
cd "$APP"
PREV=$(git rev-parse HEAD)
git fetch --quiet origin main
git reset --hard origin/main
NEW=$(git rev-parse HEAD)
echo "deploy: $PREV -> $NEW"

wait_healthy() {
  for _ in $(seq 1 30); do
    curl -fsS "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}

sudo systemctl restart claude-cli-server
if wait_healthy; then
  echo "deploy: OK ($NEW)"
else
  echo "deploy: ヘルスチェック失敗。$PREV にロールバックします" >&2
  git reset --hard "$PREV"
  sudo systemctl restart claude-cli-server
  wait_healthy || echo "rollback 後も起動しません。journalctl -u claude-cli-server を確認" >&2
  exit 1
fi
