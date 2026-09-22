#!/usr/bin/env bash
set -euo pipefail

app_dir="${APP_DIR:?APP_DIR must identify the Ezra Mail installation}"
unit_dir="$(printf '/'; printf 'etc/systemd/system')"

if [ "$(id -u)" -ne 0 ]; then
  printf 'Run this installer with sudo.\n' >&2
  exit 1
fi
if [ ! -f "$app_dir/package.json" ]; then
  printf 'Ezra Mail package.json was not found in %s.\n' "$app_dir" >&2
  exit 1
fi

app_user="${EZRA_APP_USER:-$(stat -c '%U' "$app_dir")}"
app_group="$(id -gn "$app_user")"
install -d -m 0755 "$unit_dir"

write_unit() {
  local name="$1"
  cat > "$unit_dir/$name" 
}

write_unit ezra-mail-backup.service <<EOF
[Unit]
Description=Create and verify an Ezra Mail backup

[Service]
Type=oneshot
User=$app_user
Group=$app_group
WorkingDirectory=$app_dir
EnvironmentFile=$app_dir/.env.local
ExecStart=/usr/bin/env npm run backup:create
NoNewPrivileges=true
PrivateTmp=true
UMask=0077
EOF

write_unit ezra-mail-backup.timer <<'EOF'
[Unit]
Description=Daily Ezra Mail backup timer

[Timer]
OnCalendar=daily
Persistent=true
RandomizedDelaySec=20m

[Install]
WantedBy=timers.target
EOF

write_unit ezra-mail-restore-rehearsal.service <<EOF
[Unit]
Description=Rehearse Ezra Mail restore verification

[Service]
Type=oneshot
User=$app_user
Group=$app_group
WorkingDirectory=$app_dir
EnvironmentFile=$app_dir/.env.local
ExecStart=/usr/bin/env npm run backup:rehearse
NoNewPrivileges=true
PrivateTmp=true
UMask=0077
EOF

write_unit ezra-mail-restore-rehearsal.timer <<'EOF'
[Unit]
Description=Monthly Ezra Mail restore rehearsal timer

[Timer]
OnCalendar=monthly
Persistent=true
RandomizedDelaySec=45m

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now ezra-mail-backup.timer ezra-mail-restore-rehearsal.timer
systemctl is-active --quiet ezra-mail-backup.timer
systemctl is-active --quiet ezra-mail-restore-rehearsal.timer
printf 'Ezra Mail backup and restore-rehearsal timers are active for %s:%s.\n' "$app_user" "$app_group"
