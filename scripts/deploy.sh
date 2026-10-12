#!/usr/bin/env bash
set -Eeuo pipefail

# Blue-green deployment of the LMS API on the EC2 host.
#
# Runs as root, started over SSM by .github/workflows/deploy.yaml, which ships
# this script together with infra/nginx/ as a small bundle. Nothing on the
# host is cloned from Git.
#
# Usage: deploy.sh IMAGE_REPO IMAGE_TAG
#   IMAGE_REPO  e.g. ghcr.io/sunil-dsb/lms-backend
#   IMAGE_TAG   e.g. sha-<commit sha>
#
# Environment:
#   AWS_DEFAULT_REGION  region of the SSM parameters (required)
#   SSM_PREFIX          parameter path, default /lms-backend/production

APP_NAME="lms-backend"
APP_PORT="4000"
APP_DIR="/opt/$APP_NAME"
RELEASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$APP_DIR/app.env"
ACTIVE_FILE="$APP_DIR/active-color"
UPSTREAM_DIR="/etc/nginx/upstreams"
UPSTREAM_FILE="$UPSTREAM_DIR/$APP_NAME-upstream.conf"
SITE_FILE="/etc/nginx/conf.d/$APP_NAME.conf"
SSM_PREFIX="${SSM_PREFIX:-/lms-backend/production}"

IMAGE_REPO="${1:?Usage: deploy.sh IMAGE_REPO IMAGE_TAG}"
IMAGE_TAG="${2:?Usage: deploy.sh IMAGE_REPO IMAGE_TAG}"

if [[ ! "$IMAGE_REPO" =~ ^ghcr\.io/[a-z0-9._/-]+$ ]]; then
  echo "Invalid image repository: $IMAGE_REPO" >&2
  exit 1
fi

if [[ ! "$IMAGE_TAG" =~ ^[a-zA-Z0-9_.-]+$ ]]; then
  echo "Invalid image tag: $IMAGE_TAG" >&2
  exit 1
fi

IMAGE="$IMAGE_REPO:$IMAGE_TAG"

mkdir -p "$APP_DIR" "$UPSTREAM_DIR" /var/www/certbot
umask 077

# Prevent overlapping deployments.
exec 9>"/var/lock/$APP_NAME-deploy.lock"
flock -n 9 || {
  echo "Another deployment is already running." >&2
  exit 1
}

# The first deployment starts blue; later deployments use the inactive slot.
if [[ -f "$ACTIVE_FILE" ]]; then
  ACTIVE="$(cat "$ACTIVE_FILE")"
else
  ACTIVE="green"
fi

case "$ACTIVE" in
  blue)
    NEXT="green"
    NEXT_PORT="3002"
    ;;
  green)
    NEXT="blue"
    NEXT_PORT="3001"
    ;;
  *)
    echo "Invalid active-color state: $ACTIVE" >&2
    exit 1
    ;;
esac

CONTAINER="$APP_NAME-$NEXT"

echo "Deploying $IMAGE to slot $NEXT."

# ---------------------------------------------------------------------------
# Configuration from SSM Parameter Store
# ---------------------------------------------------------------------------

# Prints the parameter value, or nothing if the parameter does not exist.
get_param() {
  aws ssm get-parameter \
    --name "$1" \
    --with-decryption \
    --query 'Parameter.Value' \
    --output text 2>/dev/null || true
}

DOMAIN="$(get_param "$SSM_PREFIX/deploy/domain")"
CERTBOT_EMAIL="$(get_param "$SSM_PREFIX/deploy/certbot-email")"

if [[ -n "$DOMAIN" && ! "$DOMAIN" =~ ^[a-zA-Z0-9.-]+$ ]]; then
  echo "Invalid domain in $SSM_PREFIX/deploy/domain: $DOMAIN" >&2
  exit 1
fi

# Every parameter under <prefix>/env becomes NAME=value in the env file.
ENV_TMP="$(mktemp "$ENV_FILE.XXXXXX")"
DOCKER_CONFIG="$(mktemp -d)"
NGINX_BACKUP="$(mktemp -d)"
export DOCKER_CONFIG

cleanup() {
  rm -rf "$ENV_TMP" "$DOCKER_CONFIG" "$NGINX_BACKUP"
}
trap cleanup EXIT

aws ssm get-parameters-by-path \
  --path "$SSM_PREFIX/env" \
  --with-decryption \
  --query 'Parameters[].[Name,Value]' \
  --output text |
  while IFS=$'\t' read -r name value; do
    [[ -n "$name" ]] || continue
    printf '%s=%s\n' "${name##*/}" "$value"
  done > "$ENV_TMP"

for required in DATABASE_URL BETTER_AUTH_SECRET; do
  if ! grep -q "^$required=" "$ENV_TMP"; then
    echo "Missing SSM parameter: $SSM_PREFIX/env/$required" >&2
    exit 1
  fi
done

mv "$ENV_TMP" "$ENV_FILE"

# ---------------------------------------------------------------------------
# Nginx helpers
# ---------------------------------------------------------------------------

write_upstream() {
  local port="$1" tmp
  tmp="$(mktemp "$UPSTREAM_FILE.XXXXXX")"

  cat > "$tmp" <<EOF
upstream lms_backend {
    server 127.0.0.1:${port};
    keepalive 16;
}
EOF

  chmod 644 "$tmp"
  mv "$tmp" "$UPSTREAM_FILE"
}

# Serves HTTPS once a certificate exists for the domain, plain HTTP until then.
render_site() {
  local template="$RELEASE_DIR/infra/nginx/$APP_NAME.http.conf"
  local server_name="$APP_NAME"
  local tmp

  if [[ -n "$DOMAIN" ]]; then
    server_name="$DOMAIN"
    if [[ -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]]; then
      template="$RELEASE_DIR/infra/nginx/$APP_NAME.https.conf"
    fi
  fi

  tmp="$(mktemp "$SITE_FILE.XXXXXX")"
  sed "s/__SERVER_NAME__/$server_name/g" "$template" > "$tmp"
  chmod 644 "$tmp"
  mv "$tmp" "$SITE_FILE"
}

backup_nginx() {
  rm -f "$NGINX_BACKUP"/*
  local file
  for file in "$UPSTREAM_FILE" "$SITE_FILE"; do
    if [[ -f "$file" ]]; then
      cp -p "$file" "$NGINX_BACKUP/"
    fi
  done
}

restore_nginx() {
  echo "Restoring previous Nginx configuration."

  local file
  for file in "$UPSTREAM_FILE" "$SITE_FILE"; do
    if [[ -f "$NGINX_BACKUP/$(basename "$file")" ]]; then
      cp -p "$NGINX_BACKUP/$(basename "$file")" "$file"
    else
      rm -f "$file"
    fi
  done

  if nginx -t; then
    systemctl reload nginx || {
      echo "ERROR: Nginx reload failed while restoring the previous configuration." >&2
      return 1
    }
  else
    echo "ERROR: Restored Nginx configuration failed validation." >&2
    return 1
  fi
}

SWITCH_ATTEMPTED=0

on_error() {
  local rc=$?
  trap - ERR
  set +e

  if [[ "$SWITCH_ATTEMPTED" -eq 1 ]]; then
    restore_nginx
  fi

  echo "Deployment failed (exit $rc). The previous slot ($ACTIVE) is still serving traffic." >&2
  exit "$rc"
}
trap on_error ERR

# ---------------------------------------------------------------------------
# Pull the image
# ---------------------------------------------------------------------------

# The workflow stores its short-lived GITHUB_TOKEN in SSM for this pull.
GHCR_TOKEN="$(get_param "$SSM_PREFIX/deploy/ghcr-token")"
if [[ -z "$GHCR_TOKEN" || "$GHCR_TOKEN" == "unset" ]]; then
  echo "No registry token in $SSM_PREFIX/deploy/ghcr-token" >&2
  exit 1
fi

printf '%s' "$GHCR_TOKEN" |
  docker login ghcr.io --username github-actions --password-stdin > /dev/null
unset GHCR_TOKEN

docker pull "$IMAGE"

# ---------------------------------------------------------------------------
# Migrate, then start the inactive slot
# ---------------------------------------------------------------------------

# Migrations run while the old slot is still serving, so each release's
# migrations must stay compatible with the release before it.
echo "Applying database migrations."
docker run --rm --env-file "$ENV_FILE" "$IMAGE" node scripts/migrate.mjs

docker rm -f "$CONTAINER" > /dev/null 2>&1 || true

docker run -d \
  --name "$CONTAINER" \
  --restart unless-stopped \
  --init \
  --security-opt no-new-privileges:true \
  --env-file "$ENV_FILE" \
  -e NODE_ENV=production \
  -e PORT="$APP_PORT" \
  -p "127.0.0.1:${NEXT_PORT}:${APP_PORT}" \
  --health-cmd "node -e \"fetch('http://127.0.0.1:${APP_PORT}/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))\"" \
  --health-interval 10s \
  --health-timeout 5s \
  --health-retries 3 \
  --health-start-period 10s \
  --log-opt max-size=10m \
  --log-opt max-file=5 \
  "$IMAGE" > /dev/null

# Wait up to 90 seconds for the new container to become healthy.
DEADLINE=$((SECONDS + 90))

until [[ "$(docker inspect --format '{{.State.Health.Status}}' "$CONTAINER" 2>/dev/null || true)" == "healthy" ]]; do
  if (( SECONDS >= DEADLINE )); then
    echo "New container did not become healthy." >&2
    docker logs --tail 100 "$CONTAINER" || true
    exit 1
  fi
  sleep 3
done

# The new slot must reach the database before it takes traffic.
if ! curl -fsS --max-time 10 "http://127.0.0.1:${NEXT_PORT}/health/db" > /dev/null; then
  echo "New container cannot reach the database." >&2
  docker logs --tail 100 "$CONTAINER" || true
  exit 1
fi

# ---------------------------------------------------------------------------
# Switch traffic
# ---------------------------------------------------------------------------

backup_nginx

# From here on a failure restores the previous Nginx configuration.
SWITCH_ATTEMPTED=1
write_upstream "$NEXT_PORT"
render_site

nginx -t
systemctl reload nginx

# Record the active slot only after Nginx accepts the new upstream.
printf '%s\n' "$NEXT" > "${ACTIVE_FILE}.tmp"
mv "${ACTIVE_FILE}.tmp" "$ACTIVE_FILE"

SWITCH_ATTEMPTED=0
trap - ERR

echo "Traffic switched to slot $NEXT."

# ---------------------------------------------------------------------------
# TLS certificate (first issue only; certbot-renew.timer handles renewals)
# ---------------------------------------------------------------------------

# Never fails the deployment: until DNS points at this host the API simply
# stays on plain HTTP and the next deployment tries again.
enable_tls() {
  local email_args=(--register-unsafely-without-email)
  if [[ -n "$CERTBOT_EMAIL" ]]; then
    email_args=(--email "$CERTBOT_EMAIL")
  fi

  echo "Requesting a TLS certificate for $DOMAIN."

  if ! certbot certonly \
    --webroot --webroot-path /var/www/certbot \
    --domain "$DOMAIN" \
    --non-interactive --agree-tos \
    "${email_args[@]}" \
    --deploy-hook "systemctl reload nginx"; then
    echo "WARNING: could not issue a certificate for $DOMAIN (is its DNS record pointing here?). Still serving HTTP." >&2
    return 0
  fi

  backup_nginx
  render_site

  if nginx -t && systemctl reload nginx; then
    echo "HTTPS enabled for $DOMAIN."
  else
    echo "WARNING: HTTPS configuration was rejected by Nginx." >&2
    restore_nginx || true
  fi
}

if [[ -n "$DOMAIN" && ! -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]]; then
  enable_tls
fi

# Drop images that neither slot uses any more.
docker image prune --all --force > /dev/null || true

echo "Deployment successful: slot=$NEXT image=$IMAGE"
