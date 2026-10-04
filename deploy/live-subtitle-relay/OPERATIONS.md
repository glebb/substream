# Hosted relay operations

This guide records the last known deployment state from 2026-10-03. The host, service, VPN, certificate and TV package were not queried during this documentation update, so the recorded state must not be read as a fresh health check. The last recorded deployment was a native systemd service behind existing Nginx at `https://subtitles.displayofpatience.com` on Ubuntu 24.04.3, x86-64, four CPUs and 8 GiB RAM. SSH access was `ssh -i ~/.ssh/github_deploy deploy@www.displayofpatience.com`; the deploy account could access `git@github.com:glebb/substream.git`. The release was transferred from the inspected local checkout, not remote HEAD. Docker was not installed; the checked-in Docker/Compose files remain an unvalidated alternative.

The recorded hosted playback path used relay-only Finnish Mullvad egress through endpoint `fi-hel-wg-101`. At that time, direct server requests received HTTP 456, while the Mac received HTTP 200. The user confirmed hosted playback on a personal Tizen 3 package on 2026-10-03. This establishes historical basic playback and HTTPS trust, not current service availability, a sustained soak or measured subtitle timing. `clock=unverified` remains the documented timing status.

The recorded diagnosis ruled out home routing. Provider account capacity was one connection; stop other playback before diagnostic streams. The operations guide was also stored at `/opt/live-subtitle-relay/OPERATIONS.md` outside immutable release directories.

## Installed release

- Source: inspected local commit `f53af5a0984f900d6f1a597225574cd4f7eea63c` under `/opt/live-subtitle-relay/releases/20261003-f53af5a`, followed by the recorded demand-guardrail update under `/opt/live-subtitle-relay/releases/20261003-demand-guardrails`. `/opt/live-subtitle-relay/current` selected the latter. `RELEASE.sha256` in a release directory records installed files; it contains no configuration.
- Node `24.21.0`. Runtime: `/opt/live-subtitle-relay/node-v24.21.0-linux-x64`; `/opt/live-subtitle-relay/node` selects it.
- FFmpeg Ubuntu package `7:6.1.1-3ubuntu5`. Record/reverify its version after OS updates; it is managed by APT and is not held against security updates.
- Service `/etc/systemd/system/live-subtitle-relay.service`, dedicated non-login user `live-subtitle-relay`, loopback `127.0.0.1:8790`, enabled at boot, restart on failure. Its `/etc/systemd/system/live-subtitle-relay.service.d/egress.conf` requires, binds it to, and restarts it with the egress service (`PartOf`).
- VPN unit `/etc/systemd/system/live-subtitle-relay-egress.service`, controller `/opt/live-subtitle-relay/relay-wireguard.py`, interface `ssrelaywg`. Only the relay UID uses routing table 18790 (IPv4/IPv6); rules 18790/18791 select the VPN then prohibit direct fallback. Root/deploy/Nginx retain ordinary host routes. No global default route or host DNS configuration was changed.
- Private VPN config `/etc/live-subtitle-relay/mullvad/mullvad-fi.conf` (root 0600, parent 0700), plus nine Finnish endpoint variants and a private device record. The dedicated key uses one Mullvad device slot; other devices were preserved. A working private copy is in the development computer’s ignored `.live-subtitle-relay/mullvad-fi.conf`.
- Ubuntu `wireguard-tools` package installed; tool version `1.0.20210914`. Paid account time was verified at provisioning; renew the subscription as needed. The VPN handshake alone does not prove paid time or provider media availability.
- Private configuration `/etc/live-subtitle-relay/config.json`, root owner, relay group, mode 0640; parent 0750. The recorded configuration contained discovered Multi-Sub channels and the personal device credential. No provider playlist credentials are stored in the source tree on the host.
- One-session limit, aligned with the verified one-connection provider account, and 60-second lease; per-worker disk limit 128 MiB. Dedicated 384 MiB `/tmp` tmpfs, 1 GiB hard memory limit (768 MiB high watermark), two-CPU quota, 128 tasks. Idle service memory measured about 42 MiB; one live check peaked at about 93 MiB before the final caption check. These are brief samples, not a sustained capacity certification.
- Nginx `/etc/nginx/sites-available/live-subtitle-relay`, enabled by symlink. Both access logging and request-bearing error logging are disabled for this hostname. Existing `www` site remains separate. Firewall exposes SSH/HTTP/HTTPS, not 8790.
- Let's Encrypt certificate under `/etc/letsencrypt/live/subtitles.displayofpatience.com/`, initial expiry 2027-01-01. Existing active `certbot.timer` renews it via webroot `/var/lib/live-subtitle-relay-acme`. `/etc/letsencrypt/renewal-hooks/deploy/live-subtitle-relay-nginx` validates/reloads Nginx after renewal. A certificate renewal dry run passed. Keep the HTTP ACME location, webroot and certificate directory during upgrades/rollback.

## Health and restart

```sh
sudo systemctl status live-subtitle-relay --no-pager
curl --fail --silent --show-error https://subtitles.displayofpatience.com/healthz
sudo systemctl restart live-subtitle-relay
sudo journalctl -u live-subtitle-relay -n 50 --no-pager -o cat
sudo systemctl show live-subtitle-relay -p MemoryCurrent -p TasksCurrent -p NRestarts
```

Relay journal events are sanitized; do not enable raw request/upstream logging. Health checks prove process availability, not provider playback. There is no external notification or automatic watchdog for a stuck but running process. A service restart interrupts active sessions. Existing journal retention remains the host policy; the unit limits event bursts.

## VPN operation and rollback

Restart the egress service while no TV is viewing. Its restart also restarts the relay in the correct stop/start order. An explicit relay start afterward is safe and is necessary when recovering from a separately stopped egress service:

```sh
sudo systemctl restart live-subtitle-relay-egress
sudo systemctl start live-subtitle-relay
curl --fail --silent --show-error https://subtitles.displayofpatience.com/healthz
```

To switch endpoints, replace `mullvad-fi.conf` from an existing private variant with root mode 0600, then use the restart sequence. Re-test provider playback with other streams stopped. All variants share this dedicated device key; do not use the same key on simultaneous machines. Keep it private. A network outage or exhausted subscription may leave the VPN unit active but block media; health reports only the relay process. No automatic endpoint rotation or paid-time monitor is configured.

To disable the VPN configuration, first stop both services, remove the relay’s `egress.conf` drop-in, disable the egress service, and reload systemd. This returns a subsequent relay start to direct egress, which currently receives 456. Preserve private configs/device state for reactivation; removing local files does not deregister the Mullvad device. Stop the service before changing route-controller code. The endpoint/key config lives outside source releases and is required when rolling back the application.

`provision-mullvad.py` creates/reuses a dedicated device from a private account-number file; it never deletes other devices. `test-mullvad-namespace.py` offers isolated checks without global routes or wg-quick hook execution. `/opt/live-subtitle-relay/diagnostics` holds the current checks with service/core links into `current`; it is separate from the immutable source release. Controller/units and diagnostic files are inventoried in `/opt/live-subtitle-relay/EGRESS.sha256`.

## Refresh private channel metadata

On the trusted development computer, from the repository root:

```sh
node scripts/relay-hosted-config.ts /tmp/substream-hosted-config.json
scp -i ~/.ssh/github_deploy /tmp/substream-hosted-config.json deploy@www.displayofpatience.com:/tmp/substream-hosted-config.json
```

Wait until active viewing stops, then on the server:

```sh
sudo cp -p /etc/live-subtitle-relay/config.json /etc/live-subtitle-relay/config.previous.json
sudo install -o root -g live-subtitle-relay -m 0640 /tmp/substream-hosted-config.json /etc/live-subtitle-relay/config.json
rm /tmp/substream-hosted-config.json
sudo systemctl restart live-subtitle-relay
```

Delete the development computer's temporary export after transfer. Discovery fetches metadata only, preserves the device credential and automatic `stream-<provider ID>` channel IDs, and retains public-DNS validation on redirects. No automatic metadata refresh is scheduled. Never display JSON or env contents. Backups contain credentials and require the same restricted permissions.

## Authorized hosted playback check

Stop other IPTV playback and run on the server, replacing the synthetic placeholder with a configured channel ID:

```sh
sudo -u live-subtitle-relay env \
  RELAY_CONFIG_FILE=/etc/live-subtitle-relay/config.json \
  RELAY_CHECK_URL=https://subtitles.displayofpatience.com \
  /opt/live-subtitle-relay/node/bin/node \
  /opt/live-subtitle-relay/diagnostics/scripts/relay-hosted-check.ts stream-PROVIDER_ID
```

This opens one session, checks media/subtitle PNGs, heartbeat, startup acknowledgement, track off and deletion, and closes the session on failure. Output uses fixed stages and omits URLs/capabilities/errors. If a session-create request times out, wait at least the 60-second lease plus teardown time before retrying: an aborted client may not have received a created session ID. Do not run this as a health monitor.

## Upgrade and rollback

Keep release directories immutable after publishing their manifest. Stage allowlisted `services/live-subtitle-relay`, `src/core`, required smoke-client files and scripts only; never copy `.env`, personal builds, generated provider JSON, playlists or the LAN companion. Stage into a new directory, run the synthetic FFmpeg and local lifecycle checks with the pinned runtime, then switch `current` and restart while no TV is viewing. Save a restricted compatible config backup before config changes. Do not blindly deploy remote HEAD.

For subsequent releases, inspect `current` and the retained release directories, then switch to a prior compatible release and restart; restore its compatible config/runtime when necessary. The recorded fallback was the accepted Mac relay, which was stopped after hosted playback was confirmed: privately set `LIVE_SUBTITLE_RELAY_URL` to the Mac LAN origin and `LIVE_SUBTITLE_RELAY_ALLOW_LAN_HTTP=1`, run `npm run relay:personal`, then prepare/sign/install the corresponding personal TV package. Keep the token unchanged. Stop the hosted service if falling back; preserve certificates and private config. Disable the Nginx site symlink and reload only if removing the hosted endpoint deliberately.

## Provider-stream lifetime

No ingest runs without a client session. The hosted limit is one connection; its slot remains occupied until old-worker teardown finishes. Client DELETE stops the upstream socket/FFmpeg and removes files. Missing heartbeats expire the session after 60 seconds. Preparation is limited to 30 seconds and unacknowledged startup to 60 seconds, with explicit worker shutdown. Disconnected create responses are discarded when the worker becomes available.

After playback acknowledgement, successful capability-authorized video segment requests renew a separate 60-second demand deadline. Control heartbeats, playlists, captions/images and status cannot extend it. Thus a stuck heartbeat loop cannot ingest forever without video consumption. TV power-off/disconnection may take the timeout plus worker teardown to release the provider connection. Subtitle Off does not stop video/audio delivery. A long pause or stall without segment fetching may expire the session and need fresh-session recovery.

The service behavior above is described by the current source tree; the deployed release itself has not been inspected during this update. The 2026-10-03 record documents systemd and HTTPS checks, synthetic FFmpeg lifecycle checks, Finnish provider playback through the relay VPN, and user-confirmed basic playback on Tizen 3. It does not establish current host health, sustained stability or measured subtitle timing. `clock=unverified` remains the timing status.

The user subsequently reported installing a fresh personal TV package after the cross-platform refactor; see the 2026-10-04 diagnostic below. Its signed assets and physical-TV playback acceptance were not verified in this diagnostic. Client changes require preparing, signing and installing a new personal package with the existing `prepare:tizen3:personal` or `prepare:tizen6:personal` workflow; a successful web build alone does not update the TV. The relay deployment is a separate native systemd service and was not changed by the client architecture work.

## Playback diagnostic — 2026-10-04

The user reported a fresh personal TV installation showing Connecting on Showtime 1 before direct fallback. The relay journal recorded session creation at 18:01:02 Helsinki time, then `upstream-ended` during preparation about 21 seconds later, followed by deletion. This establishes that the app reached and authenticated with the relay; it does not identify why the provider response ended.

After the user stopped IPTV playback, one authorized hosted diagnostic passed HTTPS/authentication, four subtitle tracks, pinned startup, media bytes, playback acknowledgement, PNG captions, capability rejection, subtitle Off, heartbeat and deletion. A subsequent check found no relay FFmpeg worker remaining. Relay and VPN services were active. No code, configuration, endpoint, token or server deployment was changed. The earlier interruption was not reproduced. The user subsequently confirmed that Showtime 1 relay playback works again on the TV. This confirms basic playback after the fresh personal installation; sustained playback and measured subtitle timing remain unverified.
