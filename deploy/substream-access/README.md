# Standalone Substream access service

This service owns Google sign-in, the email allowlist, access-link creation
and revocation, and the private static-file authorizer. It runs as the
dedicated `substream-access` system user. The player remains a static release
under `/opt/substream-web`; this service does not proxy provider, catalogue,
media, relay, or companion traffic.

Nginx sends the following HTTPS routes to `127.0.0.1:8792`:

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/` | Portal and sign-in state |
| GET | `/auth/google/login` | Start Google sign-in |
| GET | `/auth/google/callback` | Complete Google sign-in |
| POST | `/access` | Create or replace the current user's link |
| POST | `/access/revoke` | Revoke the current user's link |
| POST | `/logout` | End the current browser session |
| GET | `/branding/substream-icon.png` | Portal icon |

The private listener at `127.0.0.1:8791` exposes only `GET /authorize` for
Nginx `auth_request`. It accepts the Nginx-generated
`X-Substream-Original-URI` and `X-Substream-Client-IP` headers. Both listeners
must remain loopback-only. Never publish either port through a firewall or
another Nginx location.

During a controlled standby rollout, `SUBSTREAM_AUTH_PORT` can be overridden
to `8793` in a systemd drop-in and the reviewed Nginx test config can point its
private auth subrequest there. Restore `8791` on both sides after the handoff.
The public portal listener remains on `8792`.

## Private configuration

Create `/etc/substream-access/config.json` from the service's synthetic
`services/substream-access/config.example.json`, replace the Google OAuth
client values and approved email list on the host, then set owner
`substream-access:substream-access` and mode `0600`. The redirect URI registered for the
Google OAuth client must include
`https://substream.example.invalid/auth/google/callback`. The portal
origin is `https://substream.example.invalid`, and the player origin is
`http://substream.example.invalid`.

The live email allowlist and OAuth secret belong only in that private file.
Do not place them in source, release archives, shell history, logs, or this
repository. It is separate from the existing bot service's user list. Protect the SQLite parent
directory at `/var/lib/substream-access` so only the service account and root
can read it; the database is durable across release switches.

## Runtime and service account

Install [substream-access.service](substream-access.service) as
`/etc/systemd/system/substream-access.service`. It runs the existing Node 24
binary at `/opt/live-subtitle-relay/node/bin/node` and does not start, stop,
or depend on the subtitle relay service. The binary is read-only shared
runtime code. If the host's Node 24 binary lives elsewhere, use a systemd
drop-in that clears and replaces `ExecStart` with that explicit executable
path. Do not copy a private Node installation into the release or run this
unit as the relay's user.

Provision the dedicated `substream-access` system user and group, private
config directory and durable data directory before starting the unit. The
unit's write access is limited to `/var/lib/substream-access`; code under
`/opt/substream-access/current` and config under `/etc/substream-access` are
read-only to the process. No VPN unit relationship or relay credential is
required.

## Immutable releases and rollback

Run `npm run package:access` to build a reviewed
service snapshot. It contains only the standalone service source, a tailored
package lock with the exact production dependency closure resolved from the
project lock, the public portal icon and those runtime dependencies (including
`google-auth-library`). Never
include `.env`, OAuth credentials, the private allowlist, local development
data, user playlists, or media URLs. Keep each validated release immutable
under `/opt/substream-access/releases/<release-id>` and switch
`/opt/substream-access/current` atomically. Keep the previous symlink target
recorded for rollback. Store state only in `/var/lib/substream-access`; a code
rollback must not replace or delete the database or private config.

Once the host account, private config, systemd unit and service directories are
prepared, deploy a built archive with:

```sh
SUBSTREAM_SSH_IDENTITY="$HOME/.ssh/deployment_key" npm run deploy:access -- deploy@HOST /tmp/substream-access-RELEASE.tar.gz
SUBSTREAM_SSH_IDENTITY="$HOME/.ssh/deployment_key" npm run rollback:access -- deploy@HOST RELEASE_ID
```

The deploy command transfers only the archive and reviewed installer scripts,
checks the archive digest and manifest on the host, installs the root-owned
rollback helper, then restarts and checks `substream-access`. The rollback
command selects a retained release and restarts the same service.

After a release switch, restart only `substream-access`, confirm both loopback
listeners and the synthetic denial/allow behavior, and then check Nginx's
portal and static authorization paths. Do not reload Nginx for routine service
releases. Roll back by switching `current` to the recorded retained release
and restarting this unit. Keep the actual deployed state in ignored `.local/deployment/` notes.

The example origins are placeholders. Configure real origins only in the private
host config and keep host-specific templates and records in `.local/deployment/`.
