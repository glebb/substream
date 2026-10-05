# Live subtitle relay deployment artifacts

The checked-in files are generic deployment templates. Use `subtitles.example.invalid` only as an example hostname; keep actual hostnames, certificate paths and production records in ignored `.local/deployment/` copies. See [operations](OPERATIONS.md) for service checks and rollback guidance.

The systemd and Nginx files provide a native deployment path. The Docker/Compose/Caddy files provide an alternative preparation path that still requires deployment and release validation. Repository templates do not identify an active host or installed release.

The four container artifacts provide a non-root Node 24 + FFmpeg image, an allowlisted build context, an optional Caddy proxy, and bounded temporary storage/resources. Compose expects private `RELAY_DOMAIN`, `RELAY_CONFIG_PATH` and versioned `RELAY_IMAGE_TAG` values. Keep runtime JSON outside the checkout, readable only by the service UID, and set `sessionRoot` under `/tmp` for the supplied tmpfs. Never include `.env`, generated provider JSON, playlists or personal TV packages in an image.

The checked-in image tags and FFmpeg package selection are development defaults. A future container deployment still needs pinned image/package versions, capacity checks, secret-permission checks, HTTPS validation on the TV, health/restart validation and a tested rollback. `/healthz` reports relay process health, not provider availability. Preserve certificates and private configuration when changing deployment methods or rolling back; never log capability-bearing URLs.
