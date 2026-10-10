# Browser VOD remux

The LG webOS HTML player also reuses this client-side VOD implementation where runtime codec/MSE/worker checks permit it. Desktop or WebKit results below do not validate LG MKV, Dolby audio, range handling or seeking. No server conversion fallback is added for LG; those cases remain in the [LG physical checklist](verification.md#lg-webos-physical-tv-check).

On supported browsers, the VOD player can play selected Matroska (`.mkv`) files by remuxing their existing encoded packets into fragmented MP4 on the device. The app uses Mediabunny in a dedicated worker, then appends the output to a browser media source. Compatible tracks are copied without decoding. When native MP4 streaming rejects AC3/EAC3 audio and accepts AAC, the worker lazily loads Mediabunny WASM codecs and converts only that audio to AAC-LC; video remains packet copied. The codec assets are shipped with the public app and conversion runs on the client.

## Supported media

The path copies the primary AVC (H.264) or HEVC (H.265) video track and one selected browser-compatible audio track. Tracks must be compatible with fragmented MP4 and with the browser's native MSE decoder. Video always uses packet copy. The Dolby audio fallback uses WASM decoding/encoding, including on HTTP builds without WebCodecs. AAC, Opus, FLAC, MP3, AC3, EAC3 and DTS are eligible for packet copying only when the browser reports native MP4 streaming support. Other audio codecs, other video codecs, additional media tracks, or incompatible codec configuration are not converted by this path; playback may fail and the app reports the supported-format limitation. The player can switch between compatible audio tracks by restarting the remux near the current playhead.

The provider’s default audio is preferred; if it is unsupported, the first compatible alternate audio track is selected. An explicit audio selection is preserved. Unsupported audio diagnostics include only a fixed codec label, never provider metadata.

This is a bounded container compatibility path with an AC3/EAC3 audio fallback, rather than a general-purpose transcoder. Other unsupported codecs remain unplayable. Provider access, device codec support, and malformed or unusual source files can still prevent playback.

## Provider requests and bounds

The browser reads the media directly from the configured provider. A range reader requests bounded byte ranges, requires HTTP `206 Partial Content` with a valid `Content-Range` or a whole-file size obtained by `HEAD`, limits each response and its small cache to 2 MiB, and sanitizes request errors. The remux worker sends output in chunks no larger than 8 MiB and waits for the player to acknowledge each chunk. Individual encoded packets are limited to 8 MiB, retained packet data between output writes to 32 MiB, and individual parser reads to 32 MiB, split into bounded range requests. The media URL and provider authentication stay on the client and go only to the provider. The browser does not send either to Substream, the companion service, or a media relay.

For cross-origin playback, the provider must permit the app's origin with CORS, honor byte-range requests, and either expose `Content-Range` to browser JavaScript (for example with `Access-Control-Expose-Headers: Content-Range`) or provide whole-file `Content-Length` through `HEAD` or a header-only `GET`. The GET probe cancels its body as soon as the headers arrive. When `Content-Range` is hidden, the reader uses the HEAD size and HTTP 206 range semantics, checks visible partial `Content-Length`, and validates the received byte count. Provider-directed media redirects are followed by the browser with `credentials: omit` and `Referrer-Policy: no-referrer`. The app does not copy credentials from the original URL into the redirect target, rewrite the destination, or send it through a helper service. The provider supplies the redirect URL; its media endpoint must also permit CORS. If the provider blocks CORS, ignores ranges, or provides neither usable range metadata nor a HEAD file size, this path stops with an error. It does not route playback through a server to work around CORS.

The player uses a dedicated worker for each load or seek. Replacing the source, seeking, or closing playback cancels the worker, any outstanding range request, and the associated stream. Worker output is handed off in bounded chunks with acknowledgements; the worker waits for the browser's append queue before sending more. The player waits for about three seconds of contiguous playable media before its first play request (or a smaller cushion for short media or when the managed source stops requesting data). After an append completes, one additional bounded output chunk can be prepared while managed streaming is paused; it is held until `startstreaming` after startup (initial playable data is allowed to bootstrap playback), with no further output credit until that chunk is appended. This reduces the fetch/remux delay on each managed refill without an unbounded queue. Buffer diagnostics show contiguous seconds ahead and whether managed streaming has paused refills. The player keeps a moving window of about 30 seconds ahead of and behind the playhead, removing old buffered data as playback advances. A seek restarts packet reading from a key packet near the target and rebuilds the output from there.

## Browser media source

The browser prefers `ManagedMediaSource` when exposed and otherwise uses `MediaSource`. It checks whether the selected implementation accepts the output MIME type and codec string; if it does not, playback fails without automatically trying the other media source. Worker chunks are appended in sequential pieces of at most 512 KiB, waiting for the previous append to finish. A synchronous `QuotaExceededError` retries the same unconsumed bytes in progressively smaller pieces, down to 16 KiB. Rejection at that minimum still fails safely. The parser is not aborted or reset during these retries. Worker credit is withheld until the entire chunk has been accepted and its last append has completed, including when managed streaming pauses midway through a chunk.

WebKit initially gives a source buffer the smaller audio-only memory budget before parsing its video initialization segment. An append that combines initialization metadata with a large first fragment can exceed that budget before playback starts. The smaller pieces let WebKit parse the initialization metadata before accepting the rest of the fragment. Synthetic Safari verification with an imposed 128 KiB append limit reproduces the original second-append quota failure; the smaller append path recovers, plays to completion and seeks successfully. This verifies recovery under a simulated quota, not the physical iPhone's actual memory limit.

On WebKit, `ManagedMediaSource` may require disabling remote playback on the video element. This browser path sets `disableRemotePlayback` while remux playback is active; AirPlay is therefore unavailable for that stream. Managed source buffers may evict data under memory pressure, so buffering remains subject to browser memory and network behavior.

## Limits and verification

Browser and provider capabilities vary. In particular, iPhone Chrome uses WebKit on standard iOS installations, so `ManagedMediaSource` availability follows the installed iOS/WebKit version; other iOS browser engines require Apple's applicable entitlement. The feature is detected at runtime, and unsupported media-source or codec combinations fail without a server conversion fallback.

HTTP-hosted builds do not rely on WebCodecs: browser media encoding APIs are not an assumed capability for this path. The app converts only AC3/EAC3 audio when native playback rejects it. Synthetic AVC/AAC MKV playback, seeking, restart, end-of-stream, and disposal have been verified in desktop WebKit. The unit suite also checks packet copying without WebCodecs, bounded transport, backpressure, and stale-worker cleanup. Physical iPhone behavior has not been verified; validate range CORS behavior, playback, seeking, buffering, and device codec support on the target devices before relying on it. This flow follows the [client credential policy](client-credential-policy.md); client-side handling cannot protect local settings from JavaScript altered in transit over HTTP.

The public artifact includes [third-party notices](../public/third-party-notices.txt) with the Mediabunny license and source-package location.

## Transport diagnostics

Buffer failures retain a device-local snapshot after media-source cleanup: the failed operation (buffer setup, duration setup, initial/media append, removal or end of stream), append count, buffered seconds, fixed media-error label and validated codec strings. Synchronous exceptions include only allowlisted exception names; their messages and arbitrary names are discarded. Asynchronous SourceBuffer parser errors are identified separately. Refills show `stopped` after a buffer failure instead of the previous misleading `active` label. Starting another load clears this snapshot. These diagnostics are displayed locally and are not uploaded or logged.

Transport errors are reported before container parsing. A rejected fetch reports “provider request rejected: CORS or network”; JavaScript cannot reliably distinguish those rejection causes. Requests follow provider-directed redirects using the browser fetch implementation. A 15-second request/body deadline is reported separately. Redirects whose initial response is itself blocked by CORS may still appear as rejected fetches. A readable response that is not HTTP 206 reports that partial content was not returned. A readable 206 response without exposed `Content-Range` uses the HEAD size fallback; if that cannot establish a valid size, it reports missing or hidden metadata. Malformed range metadata or inconsistent response bytes report an invalid byte range. None of these labels includes provider URLs, response bodies, or credentials.

## iPhone audio trial

The forced iPhone AC3/EAC3-to-AAC comparison trial was reverted after the user reported that playback stopped working. iPhone loads again copy native-compatible Dolby audio. The unsupported-Dolby fallback remains available for desktop browsers. The cause of the original iPhone stalls remains unresolved; further debugging is deferred.

Phone playback controls include a native seek slider and −10/+30-second buttons.
The slider commits once when released, so dragging does not repeatedly restart
remuxing. The fullscreen subtitle panel has its own visible Close and Info
buttons above the scrolling content. Info closes the panel and leaves safe,
device-local buffer/refill/pending-byte diagnostics visible during playback;
these are not uploaded. Starting at zero reads the first key packet directly
without an unnecessary timestamp/cue lookup. Recurring physical iPhone stalls
remain unverified until playback is retried with the Info overlay enabled.

During a managed refill pause, the player can hold two prepared worker chunks
(up to 16 MiB total) and grants no further credit until it consumes one. This
bounded read-ahead lets the next fragment download while playback consumes the
current buffer. Partially appended chunks keep their original credit until
complete; seek and disposal discard both held chunks. Browser appends still use
the quota-recovering 512 KiB/16 KiB limits. The worker reports only fixed labels
(downloading, remuxing, waiting) once per second; the timer is cleared on disposal
and the labels stay local. This reduces a refill scheduling delay but cannot
ensure uninterrupted playback when source throughput is below the media rate.

The parser cache is configured at 8 MiB to match Mediabunny's network prefetch
window. With a 2 MiB parser cache, interleaved cluster reads can evict prefetched
bytes and request the same ranges again. A generated multi-cluster AVC/AAC
regression fixture limits downloaded bytes to 1.5 times file size (including
index/header reads), catching the former threefold amplification, and verifies
that requests still go directly to the synthetic provider. Each HTTP
range and the separate range-reader cache remain capped at 2 MiB.
