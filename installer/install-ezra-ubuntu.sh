#!/usr/bin/env bash
set -euo pipefail

mode=""
origin=""
lan_origin=""
app_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
  cat <<'EOF'
Usage: sudo installer/install-ezra-ubuntu.sh --desktop|--headless [--origin https://private.example] [--lan-origin https://192.0.2.10] [--app-dir /path/to/ezra-mail]

The headless installer prefers a Tailscale HTTPS setup link. A supplied LAN
fallback must be HTTPS. The first-owner setup link expires after 15 minutes.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --desktop) mode="desktop" ;;
    --headless) mode="headless" ;;
    --origin) origin="${2:-}"; shift ;;
    --lan-origin) lan_origin="${2:-}"; shift ;;
    --app-dir) app_dir="${2:-}"; shift ;;
    --help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
  shift
done

if [ "$mode" != "desktop" ] && [ "$mode" != "headless" ]; then
  usage >&2
  exit 2
fi
if [ "$(id -u)" -ne 0 ]; then
  printf 'Run the Ubuntu installer with sudo.\n' >&2
  exit 1
fi
if [ ! -f "$app_dir/package.json" ]; then
  printf 'Ezra Mail package.json was not found in %s.\n' "$app_dir" >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(`.`)[0]')" -lt 22 ]; then
  printf 'Node.js 22 or newer is required before Ezra Mail can be installed.\n' >&2
  exit 1
fi

app_user="${SUDO_USER:-$(stat -c '%U' "$app_dir")}"
app_group="$(id -gn "$app_user")"
install -d -m 0700 -o "$app_user" -g "$app_group" "$app_dir/data"
env_path="$app_dir/.env.local"
if [ ! -f "$env_path" ]; then
  cp "$app_dir/.env.example" "$env_path"
  chown "$app_user:$app_group" "$env_path"
  chmod 0600 "$env_path"
fi

set_env_value() {
  local key="$1"
  local value="$2"
  local temporary
  temporary="$(mktemp)"
  grep -v "^${key}=" "$env_path" > "$temporary" || true
  printf '%s=%s\n' "$key" "$value" >> "$temporary"
  install -o "$app_user" -g "$app_group" -m 0600 "$temporary" "$env_path"
  rm -f "$temporary"
}

owner_is_configured() {
  grep -qE '^EZRA_AUTH_PASSWORD_HASH(_B64)?=.+$' "$env_path"
}

resolve_tailscale_origin() {
  command -v tailscale >/dev/null 2>&1 || return 1
  local dns_name
  dns_name="$(tailscale status --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.stdout.write((j.Self&&j.Self.DNSName||"").replace(/\.$/,""))}catch{}})')"
  [ -n "$dns_name" ] || return 1
  printf 'https://%s' "$dns_name"
}

transport="local"
if [ -n "$origin" ]; then
  setup_origin="$origin"
  case "$setup_origin" in
    https://*.ts.net) transport="tailscale" ;;
    https://*) transport="lan" ;;
  esac
elif [ "$mode" = "headless" ] && setup_origin="$(resolve_tailscale_origin)"; then
  transport="tailscale"
elif [ "$mode" = "headless" ] && [ -n "$lan_origin" ]; then
  setup_origin="$lan_origin"
  transport="lan"
else
  setup_origin="http://127.0.0.1:3000"
fi
case "$setup_origin" in
  http://127.0.0.1:3000) ;;
  https://*) ;;
  *) printf 'Headless setup requires Tailscale HTTPS or an explicit HTTPS LAN origin.\n' >&2; exit 1 ;;
esac
if [ "$mode" = "headless" ] && [ "$transport" = "local" ]; then
  printf 'Headless setup needs Tailscale HTTPS or --lan-origin https://...; no broad listener was created.\n' >&2
  exit 1
fi
set_env_value "APP_BASE_URL" "$setup_origin"
if [ "$transport" != "local" ]; then
  rp_id="$(printf '%s' "$setup_origin" | sed -E 's#^https://([^/:]+).*#\1#')"
  set_env_value "EZRA_WEBAUTHN_ORIGIN" "$setup_origin"
  set_env_value "EZRA_WEBAUTHN_RP_ID" "$rp_id"
fi

configure_lan_https() {
  local host
  local caddy_config_path
  host="$(printf '%s' "$setup_origin" | sed -E 's#^https://([^/:]+).*#\1#')"
  if ! command -v caddy >/dev/null 2>&1; then
    apt-get update
    apt-get install -y caddy
  fi
  caddy_config_path="${EZRA_CADDY_CONFIG_PATH:-$(printf '/'; printf 'etc/caddy/Caddyfile')}"
  cat > "$caddy_config_path" <<EOF
https://$host {
  bind $host
  tls internal
  reverse_proxy 127.0.0.1:3000
  header {
    Strict-Transport-Security "max-age=31536000"
    X-Content-Type-Options "nosniff"
    X-Frame-Options "DENY"
    Referrer-Policy "same-origin"
  }
}
EOF
  caddy validate --config "$caddy_config_path"
  systemctl enable --now caddy
  systemctl reload caddy
}

cd "$app_dir"
npm ci
npm run build
EZRA_APP_USER="$app_user" APP_DIR="$app_dir" "$app_dir/scripts/install-ezra-systemd.sh"
EZRA_APP_USER="$app_user" APP_DIR="$app_dir" "$app_dir/scripts/install-ezra-backup-timers.sh"
chown -R "$app_user:$app_group" "$app_dir/data"

setup_url=""
if ! owner_is_configured; then
  setup_json="$(sudo -u "$app_user" env EZRA_ENV_FILE="$env_path" npm --silent run auth:bootstrap -- --origin "$setup_origin" --transport "$transport" --json)"
  setup_url="$(printf '%s' "$setup_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s);if(!v.setupUrl)process.exit(1);process.stdout.write(v.setupUrl)})')"
fi
systemctl restart ezra-mail-web.service ezra-mail-worker.service
systemctl is-active --quiet ezra-mail-web.service
systemctl is-active --quiet ezra-mail-worker.service
if [ "$transport" = "tailscale" ]; then
  tailscale serve --https=443 http://127.0.0.1:3000
elif [ "$transport" = "lan" ]; then
  configure_lan_https
fi

if owner_is_configured; then
  printf 'An owner is already configured; skipping first-owner setup.\n'
elif [ "$mode" = "desktop" ] && command -v xdg-open >/dev/null 2>&1; then
  sudo -u "$app_user" xdg-open "$setup_url" >/dev/null 2>&1 || true
  printf 'Opened the secure Ezra Mail first-owner setup page in your browser.\n'
else
  printf 'Open this private first-owner setup link before it expires: %s\n' "$setup_url"
fi
printf 'The first-owner setup link expires after 15 minutes and is single-use.\n'
