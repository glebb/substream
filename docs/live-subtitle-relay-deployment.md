# Live subtitle relay deployment

Use the native systemd and Nginx templates in `deploy/live-subtitle-relay` for
host preparation. The example hostname is `subtitles.example.invalid`; set
actual hostnames and certificate paths only in ignored local copies under
`.local/deployment/`. The [operations guide](../deploy/live-subtitle-relay/OPERATIONS.md)
is generic. Actual host inventories, VPN details and dated playback acceptance
records belong in private local notes.

The Docker/Compose/Caddy files provide an alternative deployment preparation;
they do not establish that a container release has been deployed or validated.
The [relay implementation and local setup](live-subtitle-relay.md) describe
session behavior and configuration. The [Tizen guide](../tizen/README.md) covers
preparing, signing and installing personal packages.

The service enforces session-only ingestion, one upstream connection per
session, explicit teardown and a demand deadline renewed by successful video
segment requests. Configure capacity for your provider's connection limit.
Source behavior and passing synthetic checks do not establish hosted playback,
sustained stability or measured subtitle synchronization. Timing remains
`clock=unverified`. Preserve private configuration and certificates during
upgrades or rollback, keep capability URLs out of logs, and use only synthetic
fixtures for local verification.
