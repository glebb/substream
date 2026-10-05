# Substream static web host

This directory contains the dedicated Nginx virtual host for the HTTP player
and HTTPS Google-auth access portal, plus immutable static-player release
helpers. It does not configure DNS or change another site. The example host name is
`substream.example.invalid`; the portal is HTTPS and the token player is
served over HTTP for provider compatibility.

The independent portal service, its private config and systemd unit are
documented in [../substream-access/README.md](../substream-access/README.md).
The Nginx portal upstream is loopback `127.0.0.1:8792`; static authorization
remains a private GET to `127.0.0.1:8791/authorize`.
HTTP certificate challenges are served from the isolated webroot
`/var/lib/substream-access-acme`; they never use the player document root or
an application proxy.

## Authorization contract

HTTP `/` and the portal's Google-auth, access, logout and branding routes
redirect to HTTPS. HTTPS proxies only `GET /`, `GET /auth/google/login`,
`GET /auth/google/callback`, `POST /access`, `POST /access/revoke`,
`POST /logout`, and `GET /branding/substream-icon.png` to the standalone
portal service. GET/HEAD requests to well-shaped HTTPS player landing links
(`/<43-character-token>/`) redirect to the HTTP player gate, without query
parameters, referrers or caching. This recovers browser HTTPS upgrades; the
HTTP gate still validates the grant. Other HTTPS paths return 404. Strict
HTTPS-only browser settings or inherited HSTS may still require a browser
exception or a separate HTTP player hostname. Nginx replaces `X-Real-IP` and
`X-Forwarded-For` with its observed `$remote_addr`; the portal must set secure,
host-only cookies itself. No HSTS or `upgrade-insecure-requests` is configured,
so the same hostname's HTTP player remains available.

On HTTP, Nginx accepts only `/<token>/` and descendants where `token` matches
`[A-Za-z0-9_-]{43}`. It performs an uncached `auth_request` for the index and
each asset. The internal subrequest is a GET to `http://127.0.0.1:8791/authorize`
with `X-Substream-Original-URI` set to the original request URI and
`X-Substream-Client-IP` set to Nginx's `$remote_addr`. Nginx clears browser
cookies, Authorization and request body. The endpoint allows only a valid,
unexpired, unrevoked grant for that exact IP whose owner remains eligible; it
returns 204 to allow and 403 to deny. All other outcomes fail closed. The
endpoint must bind only to loopback and must treat these Nginx-generated
headers as trusted only on that private listener.

Token URLs remain reusable during their grant lifetime so reloads and assets
work. Each allowed Google account has one active eight-hour grant;
regeneration replaces it and explicit revoke disables it. The URL grants access
to anyone who has it and shares the authorized public IP. A network change
requires a new grant. The static host makes no provider, media, relay or
companion requests; those connections originate in the browser.

The Nginx template protects all app files, rejects API-like paths, encoded
traversal forms and malformed/root asset paths, disables access logging for
this host, and sends `Cache-Control: no-store` and
`Referrer-Policy: no-referrer`. HTTPS portal responses use
`Referrer-Policy: same-origin` so native form posts include their `Origin`
while cross-origin navigations to Google and the HTTP player receive no
referrer. Do not add an unprotected `/assets/` alias or SPA fallback.
Authorization denials keep HTTP 403 and include a small link back to the HTTPS
access portal; missing and malformed paths remain 404.
Authorization applies to each future file request. It cannot erase JavaScript
already downloaded or guarantee that a provider stream already playing stops.
The app is served over HTTP, so its URL and contents are visible and modifiable
in transit. Do not enable HSTS or an HTTPS-upgrade CSP for this hostname; verify
that browser HTTPS-only settings permit the provider-compatible HTTP player.

## Test the Nginx gate

On Linux with Nginx and OpenSSL installed, run:

```sh
npm run test:web-integration
```

The harness starts Nginx under a temporary prefix on loopback-only ports and
uses a temporary self-signed certificate, synthetic token/IPs, fake loopback
authorizer and portal services, and generated static files. It checks HTTP
portal redirects, the separate ACME webroot, HTTPS route/method allowlists, overwritten client-IP headers,
secure host-only cookies, absence of HSTS/HTTPS-upgrade directives, protected
static delivery, denial paths, traversal and closed access when the authorizer
is unavailable. It does not read `.env`, contact a provider, or modify the
active Nginx service. The harness cleans up temporary files and processes on
exit. `npm run test:web-deploy` runs it when Linux Nginx, Python and OpenSSL are
available; it skips that integration test on other systems.

To check a built static directory as well, pass it explicitly:

```sh
python3 scripts/substream-web-integration.py --dist dist
```

Without `--dist`, the harness uses only its generated synthetic fixture.

## Build and package

Run `npm ci`, then `npm run package:web`. This runs `npm run build:public` with
personal and Chromium-47 proxy build flags disabled, audits the generated
static files, writes a SHA-256 manifest, and creates a release archive under
`/tmp`. Only `dist` contents and `manifest.json` enter the archive. The build
audit checks that application assets use relative URLs, the worker/WASM outputs
exist, and no personal credential defaults, local service defaults, or private
key material were packaged. Review the emitted base revision and digest. The
archive is created with macOS resource-fork metadata disabled and its complete
member list is checked against the manifest before packaging succeeds. The
manifest hashes every shipped file and records a SHA-256 snapshot of the
non-environment source files plus whether the checkout was dirty. These hashes
identify the exact static artifact even when built from uncommitted source.
Never pass `.env`, personal `dist` output or provider URLs to the package step.

## Install and rollback

After independently verifying DNS, Nginx module availability, firewall and
the loopback authorization service, run:

```sh
npm run deploy:web -- deploy@HOST /tmp/substream-web-<release>.tar.gz
```

The SSH identity is selected by the operator's SSH configuration; set
`SUBSTREAM_SSH_IDENTITY` to an identity file path when a specific key is needed.
The script copies only the archive and installer, verifies the archive digest on-host,
refuses to overwrite an existing release, retains all old release directories,
and atomically updates `/opt/substream-web/current`. It stores the validated
manifest under `/opt/substream-web/manifests/` outside the document root, makes
release files root-owned and read-only, and records the former target at
`/opt/substream-web/previous`. No Nginx reload is needed for a static release
switch.

To select a retained release, use:

```sh
npm run rollback:web -- deploy@HOST <release-id>
```

Inspect the active symlink and manifest after each operation. Nginx syntax
validation and reload are separate host-configuration operations; perform them
only when the reviewed dedicated vhost has been installed. This repository
does not claim any DNS, host, Nginx or authorization-service change has been
deployed.

Keep real domains, IPs, SSH destinations, installed-release inventories and backup
locations in ignored `.local/deployment/` files. Customize an ignored copy of
`nginx.conf` before installing it; the checked-in hostname is a placeholder.
