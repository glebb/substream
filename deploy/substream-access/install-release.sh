#!/bin/sh
# Install one validated immutable access-service release from stdin.
set -eu

release=${1:?release id required}
expected_sha=${2:?archive sha256 required}
case "$release" in [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9]) :;; *) echo "invalid release id" >&2; exit 2;; esac
case "$expected_sha" in *[!a-f0-9]*|'') echo "invalid archive digest" >&2; exit 2;; esac
[ "${#expected_sha}" -eq 64 ] || { echo "invalid archive digest" >&2; exit 2; }
[ "$(id -u)" -eq 0 ] || { echo "installer must run as root" >&2; exit 1; }
id substream-access >/dev/null 2>&1 || { echo "substream-access account is missing" >&2; exit 1; }
[ -r /etc/substream-access/config.json ] || { echo "private service config is unavailable" >&2; exit 1; }
[ "$(stat -c '%a' /etc/substream-access/config.json)" = 600 ] || { echo "private service config must have mode 0600" >&2; exit 1; }
[ "$(stat -c '%U' /etc/substream-access/config.json)" = substream-access ] || { echo "private service config must belong to substream-access" >&2; exit 1; }
node_bin=/opt/live-subtitle-relay/node/bin/node
[ -x "$node_bin" ] || { echo "Node 24.21+ runtime is unavailable" >&2; exit 1; }
node_version=$("$node_bin" --version)
python3 - "$node_version" <<'PY'
import re, sys
match = re.fullmatch(r"v(\d+)\.(\d+)\.(\d+)", sys.argv[1])
if not match or tuple(map(int, match.groups())) < (24, 21, 0):
    raise SystemExit("Node 24.21+ runtime is required")
PY

base=/opt/substream-access
mkdir -p "$base/releases" "$base/manifests" /var/lib/substream-access
chown substream-access:substream-access /var/lib/substream-access
chmod 0750 /var/lib/substream-access
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
    entries = {}
    total = 0
    for member in bundle.getmembers():
        path = pathlib.PurePosixPath(member.name)
        parts = tuple(part for part in path.parts if part not in ("", "."))
        if path.is_absolute() or ".." in parts or not (member.isfile() or member.isdir()):
            raise SystemExit("archive contains an unsafe path or file type")
        if not parts and member.isdir():
            continue
        if not parts:
            raise SystemExit("archive contains an empty file path")
        name = "/".join(parts)
        if name in entries:
            raise SystemExit("archive contains duplicate paths")
        entries[name] = member
        total += member.size
        if total > 150 * 1024 * 1024:
            raise SystemExit("archive exceeds the 150 MiB limit")

    manifest_file = entries.get("manifest.json")
    if manifest_file is None or not manifest_file.isfile():
        raise SystemExit("missing manifest")
    manifest_data = bundle.extractfile(manifest_file).read()
    manifest = json.loads(manifest_data)
    expected = manifest.get("files")
    if manifest.get("schemaVersion") != 1 or not isinstance(expected, dict):
        raise SystemExit("invalid release manifest")
    dependency = manifest.get("dependency", {})
    if dependency.get("name") != "google-auth-library" or not isinstance(dependency.get("version"), str):
        raise SystemExit("release does not identify the Google auth runtime dependency")

    required = {
        "services/substream-access/main.ts",
        "services/substream-access/config.ts",
        "services/substream-access/service.ts",
        "services/substream-access/store.ts",
        "public/branding/substream-icon.png",
        "package.json",
        "package-lock.json",
    }
    expected_names = set(expected)
    actual_names = {name for name, member in entries.items() if member.isfile() and name != "manifest.json"}
    if actual_names != expected_names or not required.issubset(expected_names):
        raise SystemExit("release contents do not match the service allowlist and manifest")
    for name in expected_names:
        path = pathlib.PurePosixPath(name)
        if path.is_absolute() or ".." in path.parts:
            raise SystemExit("manifest contains an unsafe path")
        allowed = name in required or name.startswith("node_modules/")
        if not allowed or name.startswith("node_modules/.bin/"):
            raise SystemExit("release contains a non-allowlisted file")
        member = entries.get(name)
        if member is None or not member.isfile():
            raise SystemExit("manifest entry is not a regular file")
        data = bundle.extractfile(member).read()
        digest = expected[name]
        if not isinstance(digest, str) or hashlib.sha256(data).hexdigest() != digest:
            raise SystemExit("manifest file digest mismatch")

    for name in sorted(expected_names):
        member = entries[name]
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
printf 'Activated access-service release %s\n' "$release"
