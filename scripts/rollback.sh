#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="/opt/lms-backend"
ACTIVE_FILE="$APP_DIR/active-color"
UPSTREAM_DIR="/etc/nginx/upstreams"
UPSTREAM_FILE="$UPSTREAM_DIR/lms-backend-upstream.conf"

# Prevent rollback from racing with an active deployment.
exec 9>/var/lock/lms-backend-deploy.lock
flock -n 9 || {
  echo "Another deployment or rollback is already running." >&2
  exit 1
}

if [[ ! -f "$ACTIVE_FILE" || ! -f "$UPSTREAM_FILE" ]]; then
  echo "Cannot determine the active slot or find the Nginx upstream." >&2
  exit 1
fi

ACTIVE="$(cat "$ACTIVE_FILE")"

case "$ACTIVE" in
  blue)
    PREVIOUS="green"
    PREVIOUS_PORT="3002"
    ;;
  green)
    PREVIOUS="blue"
    PREVIOUS_PORT="3001"
    ;;
  *)
    echo "Invalid active-color state: $ACTIVE" >&2
    exit 1
    ;;
esac

CONTAINER="lms-backend-$PREVIOUS"

if [[ "$(docker inspect --format '{{.State.Health.Status}}' "$CONTAINER" 2>/dev/null || true)" != "healthy" ]]; then
  echo "Cannot roll back: slot $PREVIOUS is not healthy." >&2
  exit 1
fi

BACKUP="$(mktemp "$UPSTREAM_DIR/lms-backend-backup.XXXXXX")"
CANDIDATE=""
cp "$UPSTREAM_FILE" "$BACKUP"

cleanup() {
  [[ -z "$CANDIDATE" ]] || rm -f "$CANDIDATE"
  rm -f "$BACKUP"
}
trap cleanup EXIT

restore_previous_config() {
  local restore
  restore="$(mktemp "$UPSTREAM_DIR/lms-backend-restore.XXXXXX")"
  cp "$BACKUP" "$restore"
  mv "$restore" "$UPSTREAM_FILE"

  if nginx -t; then
    systemctl reload nginx
  else
    echo "ERROR: Restored Nginx configuration failed validation." >&2
    return 1
  fi
}

echo "Rolling back from $ACTIVE to $PREVIOUS."

CANDIDATE="$(mktemp "$UPSTREAM_DIR/lms-backend-candidate.XXXXXX")"
cat > "$CANDIDATE" <<EOF
upstream lms_backend {
    server 127.0.0.1:${PREVIOUS_PORT};
    keepalive 16;
}
EOF

mv "$CANDIDATE" "$UPSTREAM_FILE"
CANDIDATE=""

if ! nginx -t; then
  echo "New upstream failed Nginx validation; restoring original configuration." >&2
  restore_previous_config
  exit 1
fi

if ! systemctl reload nginx; then
  echo "Nginx reload failed; restoring original configuration." >&2
  restore_previous_config
  exit 1
fi

printf '%s\n' "$PREVIOUS" > "${ACTIVE_FILE}.tmp"
mv "${ACTIVE_FILE}.tmp" "$ACTIVE_FILE"

echo "Rollback successful: active slot=$PREVIOUS"
