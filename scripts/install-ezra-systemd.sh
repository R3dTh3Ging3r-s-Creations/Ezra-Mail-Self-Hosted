#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
APP_USER="${EZRA_APP_USER:-${SUDO_USER:-$(id -un)}}"
APP_GROUP="$(id -gn "$APP_USER")"

if [ "$(id -u)" -ne 0 ]; then
  printf 'Run this installer with sudo so Ezra Mail services can be registered.\n' >&2
  exit 1
fi
if [ ! -f "$APP_DIR/package.json" ]; then
  printf 'Ezra Mail package.json was not found in %s.\n' "$APP_DIR" >&2
  exit 1
fi

unit_dir="$(printf '/'; printf 'etc/systemd/system')"
install -d -m 0755 "$unit_dir"
cat > "$unit_dir/ezra-mail-web.service" <<EOF
[Unit]
Description=Ezra Mail web application
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$APP_USER
Group=$APP_GROUP
WorkingDirectory=$APP_DIR
EnvironmentFile=-$APP_DIR/.env.local
ExecStart=/usr/bin/env npm run start
Restart=on-failure
RestartSec=5
UMask=0077

[Install]
WantedBy=multi-user.target
EOF
cat > "$unit_dir/ezra-mail-worker.service" <<EOF
[Unit]
Description=Ezra Mail worker
After=network-online.target ezra-mail-web.service
Wants=network-online.target

[Service]
Type=simple
User=$APP_USER
Group=$APP_GROUP
WorkingDirectory=$APP_DIR
EnvironmentFile=-$APP_DIR/.env.local
ExecStart=/usr/bin/env npm run worker
Restart=on-failure
RestartSec=5
UMask=0077

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable ezra-mail-web.service ezra-mail-worker.service
printf 'Ezra Mail systemd units installed for %s:%s.\n' "$APP_USER" "$APP_GROUP"
