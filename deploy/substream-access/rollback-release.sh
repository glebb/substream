#!/bin/sh
set -eu
release=${1:?release id required}
case "$release" in [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9]) :;; *) echo "invalid release id" >&2; exit 2;; esac
[ "$(id -u)" -eq 0 ] || { echo "rollback must run as root" >&2; exit 1; }
base=/opt/substream-access
target="$base/releases/$release"
[ -d "$target" ] && [ -f "$base/manifests/$release.json" ] || { echo "release not found" >&2; exit 1; }
if [ -L "$base/current" ]; then
  old=$(readlink "$base/current")
  ln -sfn "$old" "$base/previous.next"
  mv -Tf "$base/previous.next" "$base/previous"
fi
ln -s "$target" "$base/current.next"
mv -Tf "$base/current.next" "$base/current"
printf 'Selected access-service release %s\n' "$release"
