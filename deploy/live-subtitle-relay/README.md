# Live subtitle relay deployment artifacts

This directory contains deployment preparation, not a deployed service. Local real-TV behavior was accepted as good enough on 2026-10-03; public deployment is the next task in a fresh session.

Start with the [deployment handoff](../../docs/live-subtitle-relay-deployment.md), [implementation notes](../../docs/live-subtitle-relay.md), and [current plan](../../docs/live-subtitle-relay-plan.md). The handoff records missing host information, automatic personal TV defaults, release verification, operations and rollback work.

| Artifact | Purpose |
| --- | --- |
| `Dockerfile` | Node 24 + FFmpeg, dependency-free server/core runtime, non-root UID 1000 |
| `Dockerfile.dockerignore` | Allows only service/core source; excludes env, JSON, playlists and tests from the context |
| `compose.yaml` | Relay plus optional Caddy; private runtime JSON secret, internal relay port, tmpfs/resource limits, healthcheck and restart policy |
| `Caddyfile` | HTTPS hostname reverse proxy without request access logging |

Compose runs from this directory with private deployment variables `RELAY_DOMAIN`, `RELAY_CONFIG_PATH` and versioned `RELAY_IMAGE_TAG`. Runtime JSON lives outside the checkout and must be readable by container UID 1000. Its session root must be under `/tmp` for this stack. Do not copy private Mac `.env` files, generated JSON or personal TV bundles into the image.

Reuse an existing ingress proxy if ports 80/443 are occupied. Pin Node/Caddy image digests and FFmpeg package version for release; checked-in tags are development defaults. Verify the 768 MiB RAM, two CPU, 64-process and 256 MiB tmpfs limits against real bitrate and concurrency. Default two sessions can each retain up to 128 MiB, so temporary storage capacity needs particular attention.

`restart: unless-stopped` restarts exited processes, not unhealthy running ones. `/healthz` reports process health, not provider availability. Actual image build, secret permissions, server egress, certificate trust on Tizen, health operation and rollback remain deployment checks. Keep certificate volumes and private configuration when rolling back; never log access URLs containing session capabilities.
