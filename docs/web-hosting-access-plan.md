# Substream hosted access architecture

Hosted access uses an independent service in `services/substream-access`, with deployment tooling in
`deploy/substream-access` and static hosting in `deploy/substream-web`.

## User flow

1. Open https://substream.example.invalid and sign in with Google.
2. The service verifies the Google identity and checks its separate private
   email allowlist. The existing bot service authentication and data are independent.
3. Create an eight-hour access link bound to the public IP observed by Nginx.
4. Open `http://substream.example.invalid/<random-token>/`. Each static
   file request checks the token, exact IP, expiry, revocation and allowlist.
5. The browser connects directly to the provider for catalogues and playback.

Each email has one active grant; creating another replaces it. Users can revoke
a grant. Signing out ends the HTTPS login session; the grant retains its own
expiry. IP changes require a new grant. Anyone who has the link and shares its
bound network can use it. HTTP exposes the link and app to observation and
modification in transit. Revocation blocks future app downloads, but cannot erase
already downloaded code or stop playback connecting directly to the provider.

## Server boundaries

- HTTPS portal: exact public routes proxied to loopback `127.0.0.1:8792`.
- HTTP player: public static build, protected by Nginx auth_request.
- Public guide: fixed `/public/nordic-epg` GET/HEAD route on HTTP and HTTPS,
  independent of player grants, requesting only the public Swedish XMLTV feed.
  Caller headers and bodies are stripped; query strings and non-read methods
  are rejected. This route accepts no provider URL or credentials.
- Private authorizer: loopback `127.0.0.1:8791/authorize`, no public proxy route.
- State: private SQLite database under `/var/lib/substream-access`.
- Config: private `/etc/substream-access/config.json`; OAuth credentials are
  configured independently of other services.
- Runtime: dedicated system account and service; no relay or bot dependency.

Google callbacks require state, a browser-bound secure flow cookie, PKCE and a
nonce. Session cookies are Secure, HttpOnly, SameSite=Lax and host-only; they
are not sent with HTTP player requests. Create, revoke and logout require a
session, matching Origin and CSRF token. Only session/grant token hashes persist.
Nginx overwrites client-IP headers and suppresses URL-bearing logs on this host.
No HSTS or upgrade-insecure-requests policy is set on the Substream hostname.

The public build embeds no personal defaults and publishes no provider proxy.
Hosting on HTTP resolves HTTPS mixed-content restrictions, but provider CORS
still has to allow the actual browser origin. Localhost success alone does not
prove hosted-origin compatibility.

Hosted SkyShowtime guide requests use the same-origin public endpoint without
a companion. Packaged TVs fetch the feed directly. Empty or failed replacement
data leaves the SkyShowtime guide unavailable rather than requesting provider
EPG or DNA. The web release and the corresponding Nginx route must both be
installed; switching static releases alone does not update host configuration.

## Operations and verification

See [access service](../deploy/substream-access/README.md) for releases and
private configuration, [static hosting](../deploy/substream-web/README.md) for
the Nginx contract, and [operations](../deploy/substream-web/OPERATIONS.md) for
generic deployment and verification procedures. Actual deployment and acceptance
records are kept in ignored `.local/deployment/` notes. Tests use synthetic identities,
provider-independent files and an isolated Nginx instance. Real Google login and
client playback acceptance are recorded separately from server health checks.
