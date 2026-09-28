# Code audit — 2026-09-28

Scope: architecture, security, performance, and the TV-to-computer companion-relay boundary. This is a source review, not a penetration test or device test. `npm run check` passed (283 synthetic tests).

## Architecture decision: companion is optional command transport

The TV application must remain fully functional without the computer companion service. The companion's only current product responsibility is an opt-in command path that lets a separately configured web app request playback of a specific VOD stream on a paired TV. It must not be a dependency for TV startup, browsing, playback, provider authentication, catalogue import, guide data, subtitle processing, settings, or recovery.

The TV remains the authority for its local playlist credentials and resolves the final playable URL itself. The web app sends only a validated provider selection through the optional relay; the relay must never become required infrastructure or the source of truth for normal TV behavior. If unavailable, the TV should silently retain normal functionality and show connection state only in the opt-in companion settings.

## Priority order

| Priority | Finding | Risk | Recommended outcome |
| --- | --- | --- | --- |
| P0 | LAN relay has no authentication, exposes permissive CORS, and is plain HTTP | A LAN peer or a malicious web page that can reach the relay can discover/control the active TV session; TV playlist credentials can be observed or altered in transit | Treat relay as a privileged service: authenticated pairing, origin allow-list, TLS, and a loopback-safe default |
| P0 | TV registration sends its credential-bearing playlist URL to the relay | The relay becomes a credential custodian and the current HTTP transport does not protect it | Replace playlist-url registration with a one-time pairing protocol and credential reference/token, or clearly ship only a local-only development relay |
| P1 | Unbounded/slow provider, body, catalogue, and FFmpeg work share one Node process | A slow provider, a large catalogue, or repeated conversion requests can tie up CPU, memory, network sockets, and disk | Apply timeouts, concurrency/size/job limits, cancellation, cache coalescing, and observability |
| P1 | Relay/service logic duplicates Xtream behavior already implemented in platform code | Provider fixes, validation, fingerprints, and catalogue semantics can drift across browser and relay paths | Define a transport-neutral provider port and use one shared implementation with Node/browser adapters |
| P2 | The relay is a single-active-TV, in-memory event queue with polling | Reconnect/restart loses state; one TV replaces another; 1.5 s polling creates needless requests and command delivery is lossy after 20 events | Make this an explicit single-device development constraint or introduce device identities, durable state, acknowledgement, and push/long-poll delivery |
| P2 | Search and catalogue storage repeatedly process whole catalogues on the UI thread | Large providers can cause slow refreshes/searches and IndexedDB quota/transaction pressure | Use indexed records, incremental indexing, debounced queries, and worker-based parsing/search |
| P1 | Packaged TV guide fallback currently calls the relay | TV guide quality/reliability changes when companion availability changes, contradicting the optional-companion boundary | Remove relay from the TV guide path; use direct provider data and treat any external guide integration as an independent optional adapter |

## Security findings

### P0 — unauthenticated relay control plane

At the time of this audit, the relay bound to `0.0.0.0` by default, used permissive CORS, and exposed session state and catalogue reads. Since then, loopback-by-default, explicit LAN opt-in, strict configured-origin checks, separate scoped TV/browser credentials, long polling, and event acknowledgements have been implemented. The remaining control plane uses scoped credentials for active-session checks, event reads, acknowledgements, and `pair/select` / `pair/play`; catalogue/search routes have since been removed. Per-endpoint rate limits, durable device identities, and TLS remain open concerns.

Impact at audit time: any party that could reach the relay could replace the TV session, obtain the active session identifier, enumerate provider metadata, or enqueue playback. The implemented controls reduce that exposure, though LAN mode still sends credentials over plain HTTP and the relay remains a development service.

Plan:

1. Immediately bind to loopback by default; require an explicit `--lan`/environment opt-in and print a high-visibility warning when enabled.
2. Remove wildcard/reflected CORS. Allow only configured browser origins, and reject unsafe Origins on every state-changing endpoint.
3. Require a short-lived, one-time pairing code displayed on the TV, then issue separate scoped credentials for TV and browser. Do not expose the TV credential via `/api/active`.
4. Authenticate every command, add expiry/rotation, request rate limits and audit-safe security events. Add adversarial route tests for cross-origin reads/writes, session replacement, replay, and multiple clients.
5. For any non-development distribution, terminate TLS and bind the authorization model to a real user/device identity.

### Resolved P0 — registration no longer transmits playlist credentials

The TV now derives its account-aware source fingerprint locally and sends only that safe identifier to `POST /api/connect`; the relay stores no playlist URL, provider username, password, or stream URL. The relay no longer resolves episode metadata against the provider. A paired browser sends identifiers and display metadata, and the TV verifies the fingerprint and derives the final stream URL locally.

Residual risk: pairing and scoped session credentials still travel over plain HTTP in explicit LAN mode, so TLS is required before any non-development distribution. A source fingerprint matches an account/provider context but is not cryptographic proof of account ownership; paired browser commands are therefore still validated by the TV/provider at playback time.

Plan:

1. Decide the supported threat model. If this remains a private development tool, hard-gate LAN mode and label it as credential-exposing development software.
2. For a supported companion product, use TLS with certificate handling appropriate for Tizen, authenticated pairing, and encrypted-at-rest credential storage with a bounded lifetime.
3. Prefer a protocol where TV resolves provider IDs locally and the relay never needs playlist credentials. If server-side catalogue lookup is essential, use a narrowly scoped provider token rather than the full playlist URL.
4. Avoid embedding personal defaults in distributable packages; keep the existing warning and add a build-time CI guard that rejects personal secrets in non-personal artifacts.

### P1 — resource exhaustion and SSRF-adjacent media conversion surface

The media endpoint is restricted to loopback peers and now uses a global FFmpeg job cap, request-size limits, a 2 GiB output cap, bounded job/probe/source-transfer durations, DNS-pinned egress, and special-use IP rejection. Per-client conversion quotas, metrics, and broader route-level observability remain open work.

Plan:

1. Enforce Content-Length before reading; count streamed bytes and destroy oversized requests.
2. Add AbortSignal deadlines and bounded retries to provider, EPG, media-probe, and conversion work.
3. Enforce a small global job semaphore plus per-job duration, disk, segment, and cleanup limits; expose saturation as 429/503.
4. Resolve and connect using validated addresses (or use a vetted egress proxy) to close the DNS re-resolution gap; retain redirect revalidation.
5. Add load/timeout/redirect/rebinding tests and metrics for job count, temp bytes, upstream failures, and request latency.

## Architectural findings

### P1 — duplicated provider domain logic

`src/core/provider/xtream.ts` now owns Xtream playlist endpoint derivation and source/pairing fingerprints for both browser and relay adapters. Provider request construction and episode resolution remain adapter-specific. The unused `createCompanionSearchClient` and relay catalogue/search APIs have been removed; production search uses the browser-owned client and its own provider connection.

Plan: create a shared, platform-independent provider domain module with interfaces such as `ProviderTransport`, `ProviderConnection`, and `PlaybackResolver`. Browser and Node should inject fetch implementations. Keep credentials in platform adapters and return typed domain values from the shared module. Relay catalogue search is unsupported: the browser owns catalogue search and contacts its configured provider directly.

### P2 — companion remains intentionally single-device and in-memory

The protocol now has a versioned schema, separate scoped browser/TV capabilities, bounded authenticated long polling, acknowledgement, and explicit queue-retention-gap reporting. Session state is still an in-memory `Map`, and one active session is deliberately supported. A relay restart loses pairing/session state; a TV app reload loses its in-memory TV credential and must wait for expiry or restart the relay before registering again. Delivery is at least once until acknowledgement, so a crash after local handling but before ACK commit can replay a command.

Remaining plan: either add durable device identities, persistence, and multi-device ownership, or make the one-TV/no-restart-recovery development constraint more explicit in UI and setup guidance.

### P2 — layer boundaries are mostly good but application composition is concentrated

`src/core` honors its platform-independent constraint, and adapters are generally separated. However, `App.tsx`, `LiveTv.tsx`, and `HtmlVideoPlayer` own large amounts of orchestration: UI state, provider/network calls, caching, playback, retry, and compatibility behavior coexist. This increases regression surface and makes device-specific testing difficult.

Plan: extract feature controllers/use-cases for catalogue refresh, title details, companion pairing, live-guide refresh, and playback lifecycle. Keep React components as render/focus adapters. Define adapter contracts and test each controller with fake ports; reserve end-to-end tests for wiring.

### Resolved — TV no longer has a non-command companion dependency

The initial review found that `LiveTv.tsx` selected `${relay}/api/nordic-epg` for packaged clients when a companion address was configured. This made the relay part of the fallback guide-data path, contrary to the intended web-requested-TV-playback-only scope.

Implemented: Tizen guide requests always use the public Nordic source directly, even when a companion URL is configured. Browser guide requests can use the relay's credential-free `/api/nordic-epg` CORS bridge. If the direct Tizen request fails, the existing provider-guide fallback remains active. This preserves provider guide data as the baseline and means a missing relay cannot alter TV guide, browsing, or playback behavior.

Follow-up: add a component-level TV integration test that boots live and VOD flows with no companion configuration, and retain any future Nordic XMLTV support as a separately configured optional guide adapter rather than a companion service feature.

## Performance and reliability findings

### P1 — browser catalogue work remains large and UI-thread bound

The relay catalogue loader and its per-session cache were removed because production Search uses the browser-owned provider connection. Browser refresh has a four-worker limit, does normalization/record accumulation on the UI thread, and its Xtream/provider playlist requests now have cancellable bounded deadlines.

Plan: keep catalogue search in the browser, add incremental/indexed storage, cancellation/deadlines and size ceilings as needed, and move normalization/index construction to a worker for browser-compatible builds. Measure catalogue size, refresh duration, peak heap and first-search latency on representative synthetic catalogues.

### P2 — full-catalogue search/storage path does repeated linear work

`searchSafeRecords` filters and sorts all matching records for each query. IndexedDB stores a full catalogue as one object and `loadCached` revalidates every record before use. This is simple and safe, but becomes expensive for large VOD libraries and can exceed object/transaction quotas.

Plan: store records individually with indexes by source fingerprint and normalized tokens; debounce search input; keep a compact in-memory token index after a controlled initial load; sort once or maintain stable sort keys. Establish a performance budget (for example: 50k records, <100 ms query on target browser/TV) and add benchmark fixtures that contain no real playlist data.

### P2 — media transfer and guide bridge still amplify steady-state load

TV event delivery now uses authenticated 25-second long polling with failure backoff, so idle polling no longer generates a request every 1.5 seconds. HLS segment handling still reads complete segment files into memory before responding; concurrent clients can multiply that allocation. The EPG relay still downloads and buffers the compressed response on each cache miss.

Remaining plan: stream files with backpressure; cache EPG payloads in memory with single-flight fetches and conditional refresh; and add limits and metrics around active streams and response bytes.

## TV ↔ computer dependency map

| Capability | TV app | Computer relay | Browser app | Failure behavior / coupling |
| --- | --- | --- | --- | --- |
| Normal M3U/Xtream VOD and live playback | Holds playlist and resolves stream URLs; AVPlay/browser adapter plays | Not required | Optional independent client | Provider reachability and device codec support only |
| Browser catalogue search / Play here | Not required | Not required | Fetches its own Xtream catalogue; caches safe metadata | Browser needs its own matching playlist/provider access |
| Play on TV | Registers a locally derived source fingerprint and constructs the final URL locally | Holds source fingerprint, scoped session credentials, and queued commands | Redeems one-time code and sends identifier-only selection | Requires reachable relay, active TV session, same provider/account fingerprint, 30-minute renewal, and long-poll delivery |
| Nordic SkyShowtime EPG fallback | Fetches public feed directly, then falls back to provider guide | Optional public-guide CORS bridge for browsers only | Uses configured relay bridge when available | Relay outage cannot affect Tizen; guide failure does not block tuning |
| Browser MKV audio compatibility | Not used by Tizen | Loopback-only FFmpeg/ffprobe source proxy and HLS files | Calls same-origin `/api/media/*` | Development-only; requires local relay, tools, public-reachable source and disk/CPU capacity |
| Serving built web app | Can use packaged Tizen assets | Can serve `dist/` | May be opened from relay but need not be | Co-hosting UI and privileged API expands the relay's attack surface |

Important boundary: Play on TV deliberately sends only identifiers from browser through relay to TV, and TV derives the playable URL. TV registration likewise sends only a safe account-aware fingerprint. The relay must have no other TV product responsibilities.

## Delivery plan

### Phase 0 — enforce optionality and contain exposure (P0/P1, before wider LAN use)

Implemented: the live-TV EPG relay dependency is removed; the relay is loopback-by-default with explicit LAN opt-in, configured CORS origins, one-time pairing, scoped credentials, credential-free TV registration, and synthetic adversarial route coverage. Plain HTTP remains an explicit development-only limitation.

### Phase 1 — make the service bounded (P1)

Implemented: body limits, abort propagation and deadlines, browser/provider request deadlines, conversion concurrency/output/duration limits, DNS-pinned media egress, and synthetic slow/large/redirecting tests. Remaining Phase 1 work is structured metrics, per-client quotas, and guide/media streaming/cache observability.

### Phase 2 — consolidate domains and protocol (P1/P2)

Decision: relay catalogue/search is unsupported. The unused `/api/search` and `/api/catalogue` routes, session catalogue cache/loader, relay catalogue service, and `createCompanionSearchClient` were removed. Search stays browser-owned and uses the browser's configured provider connection. Remaining work is to extract shared provider-domain logic and continue formalizing the versioned playback-command protocol; browser search remains responsible for its own catalogue indexing/storage performance.

### Phase 3 — scale UX reliability (P2)

Implemented: authenticated bounded long polling and acknowledgements with explicit retention-gap reporting. Remaining work is to model multiple devices or explicitly tighten the single-device contract, move catalogue indexing/search off the UI thread, and add target-device performance benchmarks. Restart/reconnect state remains intentionally in-memory.
