# Mandatory client credential policy

This is a hard product and architecture requirement. Future features, fixes,
refactors and deployments must preserve it. It must not be removed, weakened
or bypassed unless the user explicitly authorizes a change to this specific
policy. A general request to fix CORS, improve playback or add an integration
does not authorize an exception.

## Required behavior

User-entered playlist/provider credentials, OpenSubtitles API keys and account
credentials, and TMDb API keys/read-access tokens belong to the client device.
Persist them only in client-owned storage, or retain them in client memory when
persistence is unavailable. Do not synchronize them with the Google account
or any server-side user profile.

The client may transmit a credential directly to its intended provider/API
when required to authenticate or perform the requested operation. Thus
"locally stored" does not mean that a key never leaves the device: its intended
API must receive it. It means that Substream does not collect or retain it on
the user's behalf.

Substream hosting/access services, the existing bot service, companion services and subtitle
relays must not receive or store these client credentials. This prohibition
includes requests, headers, query strings, uploaded configuration, database
records, logs, analytics, error/crash reports, backups and credential-bearing
playlist or media URLs. Do not introduce a server proxy, account sync, credential
verification endpoint or background upload that crosses this boundary.

Provider catalogue/media and TMDb/OpenSubtitles requests originate from the
client and go directly to their respective services. CORS or mixed-content
problems must not be resolved by forwarding client credentials through a
Substream service. Public release bundles must contain no personal defaults.

## Separate service authentication

Google login and the access service necessarily process Google identity,
sessions, source IPs and temporary grants. Companion pairing and subtitle-relay
sessions use their own service-specific authentication. These are distinct
from provider/API credentials; do not reuse provider/API keys as service tokens.

Companion playback messages carry the allowed provider identifiers and display
metadata, not credential-bearing stream URLs or the client's settings. A
subtitle relay may use its own independently provisioned private server
configuration; it must not obtain provider credentials from client settings.

Existing isolated local development previews may explicitly use a local
provider proxy, and private personal builds may embed operator-provided
defaults. Neither is the hosted public app. Keep those modes isolated and
disabled in public artifacts; they do not authorize adding credential
collection to shipped client workflows.

## LG packaged builds and deployment tooling

The LG app follows the same mandatory client boundary. Its settings and
catalogue belong to the TV, and provider, TMDb and OpenSubtitles requests go
directly from that TV to the intended service. LG companion pairing and receiver
commands use separate service authentication and credential-safe provider
identifiers; the TV resolves those identifiers against its own saved playlist.
LG live subtitle relay remains disabled. Network or codec failures do not
authorize forwarding credentials through a server.

The clean LG package ignores `.env` defaults. Explicit personal LG commands
may embed operator-provided playlist/OpenSubtitles/TMDb defaults under the
existing private-personal-build allowance above. Those `.ipk` files contain
recoverable credentials: keep their output directories ignored and do not
publish them. This allowance does not extend to collecting user-entered
credentials or changing shipped request routing.

`LG_WEBOS_DEVICE` and `LG_WEBOS_LOCAL_IP` belong in ignored `.env`.
`LG_WEBOS_LOCAL_IP` is the Mac's LAN address used as the companion host in a
personal LG package; it is not the registered TV target. Actual connection
diagnostics and operations records stay in ignored `.local/deployment/`.
Registered SSH keys remain in the CLI's external key store. The personal Vite
build receives the app defaults it needs;
`ares-package`, `ares-install`, `ares-launch` and best-effort app closure receive
only an allowlist of runtime/path/key-store environment variables. Their raw
output is suppressed. Deployment settings are not compiled into the app, and
package auditing rejects `.env` and `.local` records. See [LG setup](../webos/README.md).

## Current implementation and limits

The browser settings adapters store playlist, OpenSubtitles and TMDb settings
in localStorage through device-owned preferences. API clients issue direct
requests to the provider, OpenSubtitles or TMDb. The hosted access service
handles login/grants and does not accept the player's credential settings.
The static host publishes no provider/API proxy.

Its fixed `/public/nordic-epg` route fetches only the public Swedish XMLTV
feed. It accepts no configurable destination, rejects query strings and
non-read methods, strips caller headers and bodies, and suppresses upstream
cookies. Client guide requests omit credentials and referrers. This public
data bridge does not authorize any provider/API credential forwarding.

Browser local storage is not an encrypted secret vault. It is accessible to
code executing with the player's origin, persists across sessions, and is not
automatically separated by Google account. Signing out of the access portal
does not erase the player's local settings.

The HTTP player cannot provide an absolute guarantee against credential theft:
an attacker able to alter delivered JavaScript can change its behavior and read
client storage. This policy describes the application's required behavior;
it does not remove HTTP transport-integrity risks. Do not claim otherwise.

## Required review and verification

- Review changes to settings, storage, transport, API clients, optional services,
  logging, diagnostics and deployment for this boundary.
- For credential-routing changes, use synthetic credentials and inspect request
  destinations, URLs, headers and bodies. Assert that only the intended
  provider/API receives its credential and that Substream/helper endpoints do
  not receive it. Include error, retry and optional-service paths as applicable.
- Keep credential-bearing values out of test output and diagnostics; never use
  the user's real playlist or keys in fixtures.
- Confirm public artifacts disable development proxies and personal defaults.
  Server availability or a passing login test alone does not verify credential
  handling.

This policy must remain linked from the repository's contributor instructions,
architecture documentation and user-facing README.
