#!/bin/sh
# Linux only. Creates the user the systemd unit runs as. Does not change file owners of an existing home.
set -e
id sinty >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/sinty --shell /usr/sbin/nologin sinty
echo "user sinty is ready. Install the unit: cp packaging/sinty.service /etc/systemd/system/ && systemctl enable --now sinty"
echo "strict mode still uses the Node permission model. OS firewall rules for plugin egress are not installed by this script."
