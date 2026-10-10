# Hosted Substream web operations

This is a generic runbook, not a record of a particular production host.
Keep actual domains, IP addresses, SSH identities/accounts, OAuth-client
relationships, allowlists, release inventories and backup/migration locations
in `.local/deployment/`. That directory is ignored by Git. Private deployment
snapshots retain the repository-relative directory layout there.

## Host configuration

The checked-in Nginx template uses `substream.example.invalid`. Copy it to
`.local/deployment/deploy/substream-web/nginx.conf` and customize the hostname
and certificate paths locally before installing it on your host. Never install
the example hostname as a production configuration. Test the repository
template with `npm run test:web-integration`, then validate the customized
host configuration with `nginx -t` before reloading Nginx.

Configure the access service's real origins, Google OAuth credentials and
allowlist only in its private server-side config. Register the matching HTTPS
callback with Google. Keep portal and authorizer listeners on loopback;
overwrite client-IP headers at the proxy and suppress URL-bearing logs.
Provider, OpenSubtitles and TMDb credentials remain exclusively client-owned
under the [credential policy](../../docs/client-credential-policy.md).

The HTTPS portal uses `Referrer-Policy: same-origin` so native form submissions
retain their required Origin. Google redirects and HTTP player files use
`no-referrer`. The HTTP player has documented transport integrity limits;
do not enable HSTS or HTTPS-upgrade directives for that host.

The fixed `/public/nordic-epg` endpoint is available on HTTP and HTTPS without
a player grant. It fetches only the public Swedish XMLTV feed and strips
caller headers and bodies; query strings and non-read methods are rejected.
Keep this route separate from token-protected app files and do not turn it
into a configurable provider proxy. A browser release using this endpoint
also requires the updated vhost: static release archives do not install Nginx
configuration. Validate the customized template with `nginx -t` and reload
Nginx after installing a configuration change.

## Deployment and rollback

Follow the [access service guide](../substream-access/README.md) and
[static host guide](README.md). Supply the SSH destination and identity from
private local configuration. Retain immutable releases and record the active
release, hashes, previous symlink target and verification results privately.
An access release restarts only its own service; a static release restarts no
service. Routine release switches need no Nginx reload.

Keep config, databases and restricted backups outside release directories.
Code rollback must preserve private configuration and durable state. Do not
reactivate a retired bot integration when selecting an earlier release.
Keep unrelated sites, relay routing and private provider configuration intact.

## Verification

Run `npm run check`, the isolated Linux Nginx harness, and the synthetic native
form check in `scripts/substream-access-browser-check.py`. Verify native create,
HTTP navigation without Referer, revoke and logout. Check denial for expired,
revoked, unknown and wrong-IP grants, as well as authorizer unavailability.
Check the public-guide route on HTTP and HTTPS, caller-header stripping,
query/method rejection and suppression of upstream cookies. A guide outage
must leave player authorization and ordinary provider playback independent.
Keep real session cookies and access URLs out of output and committed notes.

Service availability and synthetic checks do not establish real Google login,
provider playback or physical-TV acceptance. Record those outcomes privately.
