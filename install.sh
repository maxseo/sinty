#!/bin/sh
set -e
root=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
stage="$root/build/stage"
test -f "$stage/integrity.json" || { echo "missing $stage. Run: node scripts/stage.mjs"; exit 1; }
dest=${PREFIX:-/usr/local/sinty}
mkdir -p "$dest"
rm -rf "$dest/packages" "$dest/plugins" "$dest/schemas" "$dest/bin" "$dest/node_modules" "$dest/integrity.json" "$dest/package.json"
cp -a "$stage/." "$dest/"
chmod +x "$dest/bin/sinty"
ln -sfn "$dest/bin/sinty" /usr/local/bin/sinty 2>/dev/null || true
echo "installed to $dest"
echo "systemd unit: packaging/sinty.service"
