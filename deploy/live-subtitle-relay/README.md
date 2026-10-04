# Live subtitle relay deployment artifacts

The last recorded hosted deployment used a native systemd service behind the host's existing Nginx at `https://subtitles.displayofpatience.com`. The record is from 2026-10-03 and has not been reverified during this documentation update. See [operations](OPERATIONS.md) for the recorded host setup, private configuration refresh, service commands, validation procedure and rollback.

The checked-in systemd and Nginx files describe that native deployment. The Docker/Compose/Caddy files are an alternative preparation path: Docker was not installed on the recorded host, and this container setup has not been deployed or release-validated. Do not infer that these files match the deployed host's current state.

The four container artifacts provide a non-root Node 24 + FFmpeg image, an allowlisted build context, an optional Caddy proxy, and bounded temporary storage/resources. Compose expects private `RELAY_DOMAIN`, `RELAY_CONFIG_PATH` and versioned `RELAY_IMAGE_TAG` values. Keep runtime JSON outside the checkout, readable only by the service UID, and set `sessionRoot` under `/tmp` for the supplied tmpfs. Never include `.env`, generated provider JSON, playlists or personal TV packages in an image.

The checked-in image tags and FFmpeg package selection are development defaults. A future container deployment still needs pinned image/package versions, capacity checks, secret-permission checks, HTTPS validation on the TV, health/restart validation and a tested rollback. `/healthz` reports relay process health, not provider availability. Preserve certificates and private configuration when changing deployment methods or rolling back; never log capability-bearing URLs.
