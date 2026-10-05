# Live subtitle relay operations

This generic runbook contains no production host inventory. Keep actual
endpoints, SSH destinations/identities, release records, VPN provisioning,
private backup locations and playback diagnostics in `.local/deployment/`,
which is ignored by Git. Historical local records are preserved under the
same repository-relative paths in that directory.

## Native host setup

Use the supplied systemd and Nginx files as templates. Customize the example
hostname and certificate paths in an ignored local copy before installation.
Bind the relay to loopback behind HTTPS, use a dedicated service account, and
keep private runtime JSON outside the checkout and immutable release trees.
Restrict config permissions to its intended owner/group. Preserve certificates
and config across release changes. Disable request-bearing access/error logs.

Any optional relay-only VPN configuration, keys, account/device records and
endpoint selections belong in private operator storage. Keep routing isolated
to the relay service; do not change global host routes or unrelated services.
Validate egress and provider availability separately from a VPN handshake.

The relay must never obtain user-entered provider/API credentials from shipped
clients. Independently provisioned private relay configuration does not change
the [client credential policy](../../docs/client-credential-policy.md).

## Health and recovery

Check systemd status, sanitized relay events, process resource use and the
configured HTTPS `/healthz` endpoint. Health proves process availability,
not provider playback or subtitle timing. Restarting interrupts active sessions.
Coordinate diagnostics with viewing and the provider's connection limit.

If using a relay egress unit, stop/start services in the order required by its
dependencies. Keep private config/device records when changing endpoints or
disabling the VPN. Revalidate playback after routing changes.

## Upgrade and rollback

Stage only allowlisted source, runtime dependencies and diagnostic scripts.
Never include environment files, generated provider JSON, playlists or personal
TV packages. Run synthetic FFmpeg and session-lifecycle checks, then select an
immutable release and restart the relay. Retain the previous release and a
restricted compatible config backup. Record installed versions and acceptance
results privately; do not infer deployment state from repository HEAD.

Client changes require separately preparing, signing and installing the TV
package. A web build does not update a physical TV. Validate session teardown,
demand expiration, recovery and sustained subtitle timing after deployment.
Keep capability URLs, credentials and raw upstream errors out of diagnostics.
