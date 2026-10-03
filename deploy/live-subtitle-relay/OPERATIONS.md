# Hosted relay operations

Deployed 2026-10-03 at `https://subtitles.displayofpatience.com` on `31.220.94.163` (Ubuntu 24.04.3, x86-64, four CPUs, 8 GiB RAM). The native systemd service uses existing Nginx and requires no Docker. SSH: `ssh -i ~/.ssh/github_deploy deploy@www.displayofpatience.com`. The server's deploy account can access `git@github.com:glebb/substream.git`; this release was transferred from the inspected local checkout rather than remote HEAD.

**Cloud-only hosted playback works through Mullvad.** Direct requests from the server returned HTTP 456 while the Mac received 200, and the provider account API confirmed `auth=1`. TS/HLS/legacy endpoints and a standard-player client did not resolve the direct rejection. A dedicated Mullvad device and Finnish WireGuard endpoint `fi-hel-wg-101` (Blix) now provide relay-only egress. The isolated Finnish Showtime 1 pipeline and the production HTTPS lifecycle passed with four subtitle tracks and PNG captions. The first Creanova endpoint did not handshake; a Swedish variant produced video without detected DVB tracks during its sample. On 2026-10-03 the user confirmed that the installed personal Tizen 3 package works with the hosted relay, establishing basic physical-TV HTTPS trust/playback. A hosted soak and quantitative timing check remain unrecorded.

The user ruled out home routing. Provider account capacity is one connection; stop other playback before diagnostic streams. The current guide is also stored at `/opt/live-subtitle-relay/OPERATIONS.md` outside immutable release directories.

## Installed release

- Source: local commit `f53af5a0984f900d6f1a597225574cd4f7eea63c` plus the deployment artifacts/check script added in this session, originally under `/opt/live-subtitle-relay/releases/20261003-f53af5a`. The active demand-guardrail update is under `/opt/live-subtitle-relay/releases/20261003-demand-guardrails` with the same source plus the updated service lifecycle. `/opt/live-subtitle-relay/current` selects this release. `RELEASE.sha256` in that directory records installed files; it contains no configuration.
- Node `24.21.0`, official Linux x64 archive SHA-256 `fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6`. Runtime: `/opt/live-subtitle-relay/node-v24.21.0-linux-x64`; `/opt/live-subtitle-relay/node` selects it.
- FFmpeg Ubuntu package `7:6.1.1-3ubuntu5`. Record/reverify its version after OS updates; it is managed by APT and is not held against security updates.
- Service `/etc/systemd/system/live-subtitle-relay.service`, dedicated non-login user `live-subtitle-relay`, loopback `127.0.0.1:8790`, enabled at boot, restart on failure. Its `/etc/systemd/system/live-subtitle-relay.service.d/egress.conf` requires, binds it to, and restarts it with the egress service (`PartOf`).
- VPN unit `/etc/systemd/system/live-subtitle-relay-egress.service`, controller `/opt/live-subtitle-relay/relay-wireguard.py`, interface `ssrelaywg`. Only the relay UID uses routing table 18790 (IPv4/IPv6); rules 18790/18791 select the VPN then prohibit direct fallback. Root/deploy/Nginx retain ordinary host routes. No global default route or host DNS configuration was changed.
- Private VPN config `/etc/live-subtitle-relay/mullvad/mullvad-fi.conf` (root 0600, parent 0700), plus nine Finnish endpoint variants and a private device record. The dedicated key uses one Mullvad device slot; other devices were preserved. The account number was entered in a masked local prompt and removed from temporary/local staging files after registration. API tokens were held only in memory. A working private copy is in the development computer’s ignored `.live-subtitle-relay/mullvad-fi.conf`.
- Ubuntu `wireguard-tools` package installed; tool version `1.0.20210914`. Paid account time was verified at provisioning; renew the subscription as needed. The VPN handshake alone does not prove paid time or provider media availability.
- Private configuration `/etc/live-subtitle-relay/config.json`, root owner, relay group, mode 0640; parent 0750. It contains 86 discovered Multi-Sub channels and the existing personal device credential. No provider playlist credentials are stored in the source tree on the host.
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

Stop other IPTV playback and run on the server, replacing the synthetic placeholder with a configured channel ID. The verified Finnish Showtime 1 ID is `stream-174226`:

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

For subsequent releases, switch `current` back to the prior compatible release and restart; restore its compatible config/runtime when necessary. This first release has no earlier hosted release. Its fallback is the accepted Mac relay: privately change `LIVE_SUBTITLE_RELAY_URL` to the Mac LAN origin and `LIVE_SUBTITLE_RELAY_ALLOW_LAN_HTTP=1`, run `npm run relay:personal`, then prepare/sign/install the corresponding personal TV package. Keep the token unchanged. Stop the hosted service if falling back; preserve certificates and private config. Disable the Nginx site symlink and reload only if removing the hosted endpoint deliberately.

## Verification and TV handoff

Passed: 509 tests/typecheck, server synthetic FFmpeg and end-to-end checks, systemd unit validation, loopback binding, HTTPS health from server/Mac, unauthorized 401, isolated Mullvad media/DVB decoding, and the production HTTPS session lifecycle (four tracks, media bytes, startup acknowledgement, PNG, capability rejection, off, heartbeat and deletion). Relay-only routing was checked against root/deploy routes. IPv4/IPv6 direct fallback was blocked with VPN routes removed temporarily, then restored. VPN restart changes the relay PID, and a separate VPN stop stops the relay. Starting the relay then starts its VPN dependency and restores public health. Diagnostic sessions/files were removed. Public and standard Tizen builds excluded playlist/device/API credentials; the standard build retains its existing nonsecret LAN companion address. Personal Tizen build includes the matching hosted endpoint/token. No private media/config files are in the deployed source archive.

Private `.env.live-relay` currently selects hosted HTTPS with LAN HTTP disabled. The personal Tizen 3 build has been signed with the existing Samsung extension and collected at `tizen/Debug/tizen3.wgt` (SHA-256 `07e101ecfba47b8582c3d602921abe2be13ebace5975ff300504a2f0a2d37b2c`). Both signatures are present and every bundled `dist` file matches the fresh build. The extension emitted `tizen/Substream.wgt`; that verified output was copied to the collector's expected `Debug/tizen.wgt` first. Both packages are private and gitignored. The package was installed successfully on the configured Tizen 3 TV after explicit approval to uninstall and clear saved app data. TV installation returned `cmd_ret:0`; remote launch was rejected, so open Substream from the TV Apps screen. The user subsequently confirmed hosted playback works on Tizen on 2026-10-03, establishing basic actual-TV HTTPS trust/playback. The Mac relay was also stopped; no local relay processes or port 8790 listener remained. Hosted provider media/subtitles now work through the server VPN. For subsequent updates use the existing `prepare:tizen3:personal` or `prepare:tizen6:personal`, sign/collect/install workflow. Detailed Finnish/English/off, fullscreen, channel-change, reconnect, teardown, service-restart-during-viewing and sustained checks are not separately recorded. Saved TV overrides still take precedence over bundled defaults. Timing remains `clock=unverified`.


## Provider-stream lifetime

No ingest runs without a client session. The hosted limit is one connection; its slot remains occupied until old-worker teardown finishes. Client DELETE stops the upstream socket/FFmpeg and removes files. Missing heartbeats expire the session after 60 seconds. Preparation is limited to 30 seconds and unacknowledged startup to 60 seconds, with explicit worker shutdown. Disconnected create responses are discarded when the worker becomes available.

After playback acknowledgement, successful capability-authorized video segment requests renew a separate 60-second demand deadline. Control heartbeats, playlists, captions/images and status cannot extend it. Thus a stuck heartbeat loop cannot ingest forever without video consumption. TV power-off/disconnection may take the timeout plus worker teardown to release the provider connection. Subtitle Off does not stop video/audio delivery. A long pause or stall without segment fetching may expire the session and need fresh-session recovery.

On 2026-10-03 all 509 synthetic tests and the real FFmpeg local lifecycle smoke passed. The new release passed the real synthetic FFmpeg lifecycle check on the server, was activated only with zero sessions/FFmpeg workers, and passed public HTTPS health afterward. The previous release is retained for rollback. The Mac remains independent of this hosted operation. No real provider stream was opened for these checks.


## TV failure-copy update

On 2026-10-03 a newly prepared, signed and asset-verified personal Tizen 3 package with clearer Finnish/English connection-failure messages was installed successfully (`cmd_ret:0`). Remote launch was rejected as before; open Substream from Apps. Reconnection and direct fallback are described in plain language. If both paths fail, the overlay asks the viewer to select Retry or another channel; failed teardown asks for a one-minute wait. The TV does not assert a VPN diagnosis or display upstream errors. All 509 tests/typecheck and the personal Tizen 3 build passed. The latest failure screen has not been deliberately triggered on the physical TV; the VPN was not disabled for this change.
