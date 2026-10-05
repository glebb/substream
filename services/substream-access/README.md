# Standalone Substream access service

This service owns Google sign-in, its email allowlist, browser sessions, and
eight-hour exact-IP grants for the hosted static player. It does not make
provider requests. Run it with Node 24.21 or newer, which supplies native
TypeScript type stripping and `node:sqlite`:

```sh
SUBSTREAM_ACCESS_CONFIG_FILE=/etc/substream-access/config.json npm run access:dev
```

The config fields are shown in [config.example.json](./config.example.json).
Use an absolute `databasePath` in a service-owned directory. Keep the config
readable only by the service account. `allowedEmails` is the standalone
service's own allowlist and is reread for each request; removing an address
immediately denies its sessions and grants. The config's database path cannot
be changed without restarting the process.

The HTTPS reverse proxy sends the original host to the portal bound on
`127.0.0.1:8792`. It must overwrite `X-Real-IP` with its observed client IP.
The service accepts only that header on its loopback-only portal listener.
The player host calls the private `GET /authorize` listener on `127.0.0.1:8791`
with Nginx-generated `X-Substream-Original-URI` and `X-Substream-Client-IP`
headers. Both ports can be overridden with `SUBSTREAM_PORTAL_PORT` and
`SUBSTREAM_AUTH_PORT`; during a side-by-side cutover the private port can be
set to `8793`.

Google's OAuth redirect URI is fixed to
`{portalOrigin}/auth/google/callback`. Register that exact URI in the Google
OAuth client. The service uses authorization code flow with PKCE, one-time
state bound to a per-flow `__Host-` browser cookie, a per-flow nonce, and
`google-auth-library` ID-token verification for signature, issuer, audience,
expiration, and verified email. Sign-in flow creation is throttled per observed
client address. Only the configured email list can start a session.

The browser session cookie is `__Host-substream_session`, secure, HTTP-only,
SameSite Lax, and host-only. Session and grant bearer values are random opaque
strings; only their SHA-256 hashes are stored. SQLite uses WAL mode, full
synchronous writes, a private database file, and explicit expiration checks.
Grant replacement is an atomic per-email upsert. The auth listener returns
204 only for a matching unexpired, unrevoked token, exact normalized IP, and
currently allowed owner; every error denies access.

The service never logs request URLs, form data, OAuth query values, tokens,
provider URLs, or underlying network errors. Portal pages use
`Referrer-Policy: same-origin`, which preserves the browser's `Origin` on
same-origin form submissions while omitting referrers to Google and the HTTP
player. The initial Google redirect and OAuth callback response use
`no-referrer`. Responses use `no-store`. The service deliberately emits no HSTS header,
because the same hostname serves the HTTP player.

Run synthetic real-socket tests with `npm run access:test`. The tests use a
stubbed OAuth transport and synthetic addresses/accounts; they do not contact
Google or use the private playlist.

For a real Chromium check of native form submissions, install Python Playwright
and its Chromium browser in your development environment, then run
`python3 scripts/substream-access-browser-check.py` from the repository root.
The check starts the service with synthetic config and account data, uses a
local HTTPS proxy and HTTP sink, and does not contact Google or the playlist.
