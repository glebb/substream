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

## Current implementation and limits

The browser settings adapters store playlist, OpenSubtitles and TMDb settings
in localStorage through device-owned preferences. API clients issue direct
requests to the provider, OpenSubtitles or TMDb. The hosted access service
handles login/grants and does not accept the player's credential settings.
The static host publishes no provider/API proxy.

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
