#!/bin/sh
set -eu
umask 077
exec 9>/run/starpost-maintenance.lock
flock -n 9
release=__STARPOST_RELEASE__
db=/var/lib/starpost/data.sqlite
media=/var/lib/starpost/media
backups=/var/backups/starpost
state=/var/lib/starpost/maintenance
run() { /usr/bin/node "$release/server/maintenance.mjs" "$1" "$db" "$media" "$backups" "$state"; }
run alert
run backup
if [ "$(TZ=Asia/Shanghai date +%u)" = 7 ] && run pending; then
  systemctl stop starpost
  stopped=1
  restore() { if [ "$stopped" = 1 ]; then systemctl start starpost; fi; }
  trap restore EXIT INT TERM
  STARPOST_MAINTENANCE_OFFLINE=1 run sweep
  systemctl start starpost
  stopped=0
  trap - EXIT INT TERM
fi
run scan
run alert
