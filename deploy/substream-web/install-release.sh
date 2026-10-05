#!/bin/sh
# Run on the host with the extracted release archive on stdin. Existing
# releases are immutable; activation is a same-filesystem symlink rename.
set -eu

release=${1:?release id required}
expected_sha=${2:?archive sha256 required}
case "$release" in [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9]) :;; *) echo "invalid release id" >&2; exit 2;; esac
case "$expected_sha" in *[!a-f0-9]*|'') echo "invalid archive digest" >&2; exit 2;; esac
[ "${#expected_sha}" -eq 64 ] || { echo "invalid archive digest" >&2; exit 2; }

base=/opt/substream-web
mkdir -p "$base/releases"
mkdir -p "$base/manifests"
stage=$(mktemp -d "$base/releases/.stage.XXXXXX")
trap 'rm -rf "$stage"' EXIT HUP INT TERM
archive="$stage/release.tar.gz"
cat > "$archive"
actual_sha=$(sha256sum "$archive" | awk '{print $1}')
[ "$actual_sha" = "$expected_sha" ] || { echo "archive digest mismatch" >&2; exit 1; }
mkdir "$stage/content"
python3 - "$archive" "$stage/content" "$stage/manifest.json" <<'PY'
import hashlib, json, os, pathlib, sys, tarfile

archive, destination, manifest_destination = sys.argv[1:]
with tarfile.open(archive, "r:gz") as bundle:
    members = bundle.getmembers()
    entries = {}
    total = 0
    for member in members:
        name = pathlib.PurePosixPath(member.name)
        parts = tuple(part for part in name.parts if part not in ("", "."))
        if name.is_absolute() or ".." in parts or not (member.isfile() or member.isdir()):
            raise SystemExit("archive contains an unsafe path or file type")
        if not parts and member.isdir():
            continue
        if not parts:
            raise SystemExit("archive contains an empty file path")
        normalized = "/".join(parts)
        if normalized in entries:
            raise SystemExit("archive contains duplicate paths")
        entries[normalized] = member
        total += member.size
        if total > 100 * 1024 * 1024:
            raise SystemExit("archive exceeds the 100 MiB limit")
    manifest_member = entries.get("manifest.json")
    if manifest_member is None or not manifest_member.isfile():
        raise SystemExit("missing manifest")
    manifest_data = bundle.extractfile(manifest_member).read()
    manifest = json.loads(manifest_data)
    expected = manifest.get("files")
    if manifest.get("schemaVersion") != 1 or not isinstance(expected, dict):
        raise SystemExit("invalid manifest")
    expected_names = set(expected)
    actual_names = {name for name, member in entries.items() if member.isfile() and name != "manifest.json"}
    if actual_names != expected_names:
        raise SystemExit("archive contents do not match manifest")
    for name, digest in expected.items():
        parts = pathlib.PurePosixPath(name)
        if parts.is_absolute() or ".." in parts.parts or not isinstance(digest, str):
            raise SystemExit("manifest contains an unsafe path")
        member = entries[name]
        if not member.isfile():
            raise SystemExit("manifest entry is not a regular file")
        data = bundle.extractfile(member).read()
        if hashlib.sha256(data).hexdigest() != digest:
            raise SystemExit("manifest file digest mismatch")
    for name, member in entries.items():
        if not member.isfile() or name == "manifest.json":
            continue
        destination_path = os.path.join(destination, *pathlib.PurePosixPath(name).parts)
        os.makedirs(os.path.dirname(destination_path), mode=0o755, exist_ok=True)
        with open(destination_path, "xb") as output:
            output.write(bundle.extractfile(member).read())
        os.chmod(destination_path, 0o444)
    with open(manifest_destination, "xb") as output:
        output.write(manifest_data)
    os.chmod(manifest_destination, 0o444)
PY
find "$stage/content" -type d -exec chmod 0555 {} +
chown -R root:root "$stage/content" "$stage/manifest.json"

target="$base/releases/$release"
[ ! -e "$target" ] || { echo "release already exists; refusing overwrite" >&2; exit 1; }
mv "$stage/content" "$target"
mv "$stage/manifest.json" "$base/manifests/$release.json"
if [ -L "$base/current" ]; then
  old=$(readlink "$base/current")
  ln -sfn "$old" "$base/previous.next"
  mv -Tf "$base/previous.next" "$base/previous"
fi
ln -s "$target" "$base/current.next"
mv -Tf "$base/current.next" "$base/current"
trap - EXIT HUP INT TERM
rm -rf "$stage"
printf 'Activated release %s\n' "$release"
