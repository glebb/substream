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

`scripts/companion-server.mjs` binds to `0.0.0.0` by default. Its generic JSON helper sends `Access-Control-Allow-Origin: *`; preflight reflects any origin. `/api/active` returns the bearer-like `sessionId`, and the same ID authorizes catalogue reads, event reads, and `pair/select` / `pair/play`. `/api/connect` clears the existing session and makes the caller's connection active. There is no client authentication, device identity, origin policy, request rate limit, or replay protection.

Impact: any party that can reach the relay can replace the TV session, obtain the active session identifier, enumerate provider metadata, or enqueue playback. A browser on the same network can read API responses because of permissive CORS. The documented trusted-LAN restriction reduces exposure but is not an authorization control.

Plan:

1. Immediately bind to loopback by default; require an explicit `--lan`/environment opt-in and print a high-visibility warning when enabled.
2. Remove wildcard/reflected CORS. Allow only configured browser origins, and reject unsafe Origins on every state-changing endpoint.
3. Require a short-lived, one-time pairing code displayed on the TV, then issue separate scoped credentials for TV and browser. Do not expose the TV credential via `/api/active`.
4. Authenticate every command, add expiry/rotation, request rate limits and audit-safe security events. Add adversarial route tests for cross-origin reads/writes, session replacement, replay, and multiple clients.
5. For any non-development distribution, terminate TLS and bind the authorization model to a real user/device identity.

### P0 — credential-bearing playlist crosses an unencrypted LAN boundary

The TV calls `POST /api/connect` with `playlistUrl`; `xtreamConnectionFromPlaylist` extracts username/password and the relay keeps them in process memory for the session. The TV accepts both HTTP and HTTPS relay addresses, and the default deployment documentation uses HTTP. The Tizen manifest also permits all origins.

Impact: a passive LAN observer or active network attacker can obtain/replace the playlist credentials; a compromised relay process has usable provider credentials. This conflicts with the otherwise sound goal that stream URLs never cross the playback-command boundary.

Plan:

1. Decide the supported threat model. If this remains a private development tool, hard-gate LAN mode and label it as credential-exposing development software.
2. For a supported companion product, use TLS with certificate handling appropriate for Tizen, authenticated pairing, and encrypted-at-rest credential storage with a bounded lifetime.
3. Prefer a protocol where TV resolves provider IDs locally and the relay never needs playlist credentials. If server-side catalogue lookup is essential, use a narrowly scoped provider token rather than the full playlist URL.
4. Avoid embedding personal defaults in distributable packages; keep the existing warning and add a build-time CI guard that rejects personal secrets in non-personal artifacts.

### P1 — resource exhaustion and SSRF-adjacent media conversion surface

The media endpoint is correctly restricted to loopback peers and performs public-address checks, which is a strong start. However, it has no cap on live FFmpeg jobs, output size, source duration, input transfer time, or per-client concurrency. `body()` accumulates data before enforcing its 128 KiB limit. `assertPublicHost()` validates DNS separately from the subsequent fetch rather than pinning a validated address, leaving a DNS-rebinding window. Provider catalogue requests and most relay routes also lack timeouts.

Plan:

1. Enforce Content-Length before reading; count streamed bytes and destroy oversized requests.
2. Add AbortSignal deadlines and bounded retries to provider, EPG, media-probe, and conversion work.
3. Enforce a small global job semaphore plus per-job duration, disk, segment, and cleanup limits; expose saturation as 429/503.
4. Resolve and connect using validated addresses (or use a vetted egress proxy) to close the DNS re-resolution gap; retain redirect revalidation.
5. Add load/timeout/redirect/rebinding tests and metrics for job count, temp bytes, upstream failures, and request latency.

## Architectural findings

### P1 — duplicated provider domain logic

`src/platform/xtream/client.ts` and `scripts/companion-service.mjs` independently parse Xtream playlists, derive fingerprints, construct authenticated requests, normalize titles, fetch categories, and resolve episodes. They already differ in validation and lifecycle behavior. `createCompanionSearchClient` is also present but production UI uses the browser-owned client, making the relay catalogue API partly orphaned.

Plan: create a shared, platform-independent provider domain module with interfaces such as `ProviderTransport`, `ProviderConnection`, `CatalogueRepository`, and `PlaybackResolver`. Browser and Node should inject fetch/storage implementations. Keep credentials in platform adapters and return only typed safe records from the shared module. Delete or wire the unused relay-search client/API after choosing one search architecture.

### P2 — companion protocol is implicit and stateful

The protocol is spread across the React panel, browser client, Node routes, and documentation. Session state is an in-memory `Map`, `activeSessionId` makes the service single-TV, the event list retains only 20 messages, and polling is the delivery mechanism. Restart, a second TV, or an offline poll loses/replaces state without a protocol-level acknowledgement.

Plan: publish a versioned schema (request/response/event types, ownership, error codes, TTL, ordering, acknowledgement and migration). Add a `deviceId` and separate browser/TV capabilities. Use server-sent events, WebSocket, or authenticated long polling with backoff. If persistence is out of scope, codify “one TV, no restart recovery” in code and UI rather than silently clearing a prior session.

### P2 — layer boundaries are mostly good but application composition is concentrated

`src/core` honors its platform-independent constraint, and adapters are generally separated. However, `App.tsx`, `LiveTv.tsx`, and `HtmlVideoPlayer` own large amounts of orchestration: UI state, provider/network calls, caching, playback, retry, and compatibility behavior coexist. This increases regression surface and makes device-specific testing difficult.

Plan: extract feature controllers/use-cases for catalogue refresh, title details, companion pairing, live-guide refresh, and playback lifecycle. Keep React components as render/focus adapters. Define adapter contracts and test each controller with fake ports; reserve end-to-end tests for wiring.

### Resolved — TV no longer has a non-command companion dependency

The initial review found that `LiveTv.tsx` selected `${relay}/api/nordic-epg` for packaged clients when a companion address was configured. This made the relay part of the fallback guide-data path, contrary to the intended web-requested-TV-playback-only scope.

Implemented: Tizen guide requests always use the public Nordic source directly, even when a companion URL is configured. Browser guide requests can use the relay's credential-free `/api/nordic-epg` CORS bridge. If the direct Tizen request fails, the existing provider-guide fallback remains active. This preserves provider guide data as the baseline and means a missing relay cannot alter TV guide, browsing, or playback behavior.

Follow-up: add a component-level TV integration test that boots live and VOD flows with no companion configuration, and retain any future Nordic XMLTV support as a separately configured optional guide adapter rather than a companion service feature.

## Performance and reliability findings

### P1 — catalogue work is unbounded and duplicated per session

The relay loads every category sequentially, retains the entire catalogue in RAM for a session, serializes the complete list for `/api/catalogue`, and refresh requests can overlap because there is no in-flight promise coalescing. Browser refresh has a better four-worker limit, but does all normalization/record accumulation on the UI thread. Provider requests do not impose deadlines.

Plan: add a catalogue repository keyed by provider fingerprint with TTL, in-flight request deduplication, bounded category concurrency, pagination/streaming where the provider supports it, and size ceilings. Move normalization/index construction to a worker for browser/Tizen-compatible builds. Measure catalogue size, refresh duration, peak heap and first-search latency on representative synthetic catalogues.

### P2 — full-catalogue search/storage path does repeated linear work

`searchSafeRecords` filters and sorts all matching records for each query. IndexedDB stores a full catalogue as one object and `loadCached` revalidates every record before use. This is simple and safe, but becomes expensive for large VOD libraries and can exceed object/transaction quotas.

Plan: store records individually with indexes by source fingerprint and normalized tokens; debounce search input; keep a compact in-memory token index after a controlled initial load; sort once or maintain stable sort keys. Establish a performance budget (for example: 50k records, <100 ms query on target browser/TV) and add benchmark fixtures that contain no real playlist data.

### P2 — polling and media transfer amplify steady-state load

Each connected TV calls `/api/pair/events` every 1.5 seconds. HLS segment handling reads whole segment files into memory before responding; concurrent clients can multiply this allocation. The EPG relay downloads and buffers the entire compressed response on every cache miss.

Plan: replace polling with push/long-poll and exponential backoff; stream files with backpressure; cache EPG payloads in memory with single-flight fetches and conditional refresh. Put limits and metrics around active streams and response bytes.

## TV ↔ computer dependency map

| Capability | TV app | Computer relay | Browser app | Failure behavior / coupling |
| --- | --- | --- | --- | --- |
| Normal M3U/Xtream VOD and live playback | Holds playlist and resolves stream URLs; AVPlay/browser adapter plays | Not required | Optional independent client | Provider reachability and device codec support only |
| Browser catalogue search / Play here | Not required | Not required | Fetches its own Xtream catalogue; caches safe metadata | Browser needs its own matching playlist/provider access |
| Play on TV | Registers credential-bearing playlist, polls events, verifies provider fingerprint, constructs final URL locally | Holds session/provider credentials and queues commands | Reads active session and sends identifier-only selection | Requires reachable relay, active TV session, same provider/account fingerprint, 30-minute renewal, and polling delivery |
| Nordic SkyShowtime EPG fallback | Fetches public feed directly, then falls back to provider guide | Optional public-guide CORS bridge for browsers only | Uses configured relay bridge when available | Relay outage cannot affect Tizen; guide failure does not block tuning |
| Browser MKV audio compatibility | Not used by Tizen | Loopback-only FFmpeg/ffprobe source proxy and HLS files | Calls same-origin `/api/media/*` | Development-only; requires local relay, tools, public-reachable source and disk/CPU capacity |
| Serving built web app | Can use packaged Tizen assets | Can serve `dist/` | May be opened from relay but need not be | Co-hosting UI and privileged API expands the relay's attack surface |

Important boundary: Play on TV deliberately sends only identifiers from browser through relay to TV, and TV derives the playable URL. This is the correct optional integration shape. It is weakened because TV registration sends the full credential-bearing playlist to the relay first. The preferred target is therefore an authenticated, credential-minimizing relay rather than moving stream URLs into browser commands. The relay must have no other TV product responsibilities.

## Delivery plan

### Phase 0 — enforce optionality and contain exposure (P0/P1, before wider LAN use)

The live-TV EPG relay dependency has been removed. Next, implement loopback-by-default, explicit LAN opt-in, strict CORS/origin checks, authenticated one-time pairing, scoped session credentials, and safe request logging. Update setup text and add route-level security tests. Success criterion: the TV works unchanged with no relay, and an unpaired LAN host or arbitrary web origin cannot read session state, send commands, or replace the TV.

### Phase 1 — make the service bounded (P1)

Introduce deadlines, abort propagation, request/body limits, provider/catalogue single-flight cache, conversion concurrency/disk/duration limits, and structured metrics. Success criterion: synthetic slow/large/redirecting upstreams cannot exhaust a development machine, and the UI receives a sanitized bounded-time error.

### Phase 2 — consolidate domains and protocol (P1/P2)

Extract the shared provider domain and formalize a versioned companion protocol. Decide whether relay catalogue search is supported; remove dead client/API code if not. Success criterion: one tested domain implementation governs fingerprints, catalogue records, episode validation and serialization.

### Phase 3 — scale UX reliability (P2)

Adopt push/long-poll delivery with acknowledgements, model multiple devices or explicitly forbid them, move catalogue indexing/search off the UI thread, and add target-device performance benchmarks. Success criterion: restart/reconnect/multiple-device behavior is deterministic and 50k-record synthetic searches meet the agreed budget.
