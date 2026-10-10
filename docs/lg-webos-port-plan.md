# LG webOS port plan

Status: initial port implemented. Clean and personal packages install and launch;
the personal package supplies `.env` defaults automatically. Physical-TV
acceptance confirmed direct category loading and 1080p live playback with
picture and sound. VOD, track selection, broader codec support, remote behavior
and standby recovery remain device acceptance checks.
Target: LG 55UT91006LA running the user's stated webOS TV 25.
Initial delivery: an installable packaged Substream web app for Developer Mode.
LG Content Store submission is a separate release project.

## Target and design

LG lists the 55UT91006LA as a 2024/webOS 24 model. Confirm the installed
version in Settings > General > TV Information and via the device API before
choosing the final build target. LG documents Chromium 120 for webOS 25 and
Chromium 108 for webOS 24. A firmware upgrade must not be assumed to upgrade
hardware codec capabilities.

Reuse the shared React screens, pure TypeScript core, catalogue repositories,
settings, focus navigation and playback release barrier. Add a `webos` runtime
and adapters under `src/platform/webos`; keep LG globals out of core and screens.
Retain the complete Chromium 47 CSS baseline for Samsung builds, including
explicit margins rather than flex gap.

## 1. Establish feasibility on the TV

- Confirm installed OS, actual runtime engine, TV networking and Developer Mode
  access. Keep addresses, device registration and SSH material in ignored
  `.local/deployment/`; use synthetic values in committed documentation.
- Create a minimal packaged HTML-video probe and synthetic HTTPS test media.
  Test direct playlist/API fetches, native HLS, MP4 and provider-style MPEG-TS
  paths, then MSE/hls.js where needed. Include redirects, HTTP/HTTPS restrictions,
  range requests and TLS failures. A raw TS endpoint is not assumed playable.
- Check IndexedDB/localStorage persistence across app close, relaunch and TV
  restart; check audio/text track enumeration, selection and external subtitles.
- Test H.264/AAC first, then HEVC and relevant audio/container combinations
  against this physical model's capabilities. Document unsupported combinations.

Gate: installed-app direct access and baseline playback work, or a specific
unsupported provider/network/media case is identified. Never resolve access
failures by forwarding client credentials through a helper server.

## 2. Add runtime and TV input

- Extend `RuntimePlatform` and bootstrap selection with `webos`; explicitly
  select the TV interaction profile even when the remote acts as a pointer.
- Supply an LG player factory and capability values based on demonstrated
  support. Do not infer LG relay support from Samsung AVPlay availability.
- Normalize LG Back (461), arrows, OK and available media keys. Configure
  `disableBackHistoryAPI` consistently with shared navigation: close overlays,
  return through app screens, then invoke LG's platform Back at the root.
- Support Magic Remote pointer click, wheel scrolling and transitions between
  pointer and D-pad focus. Provide on-screen playback actions for remotes
  without dedicated media keys. Integrate virtual keyboard visibility/editing.
- Add adapter-owned app visibility/relaunch handling: save resume state, release
  resources when leaving playback and restore a safe state without duplicates.

## 3. Implement playback behind the shared contract

- Reuse the HTML-video implementation where verified, with LG-specific behavior
  behind an adapter. Prefer native HLS when suitable; use hls.js/MSE only for
  verified formats/features. Do not copy Samsung AVPlay code into LG playback.
- Validate live startup, channel switching, buffering/retry, VOD pause/seek/resume,
  end-of-media and next episode using the existing release barrier.
- Implement and test available audio/subtitle selection and external subtitle
  overlays. Advertise only supported controls; document unavailable embedded
  tracks or live DVB subtitle paths instead of assuming Samsung parity.
- Keep companion and subtitle relay integrations optional. Initially disable
  unsupported LG paths; enable each only after transport, lifecycle and
  credential-boundary checks pass. Ordinary direct playback stays standalone.

## 4. Build and package

- Add `webos/appinfo.json`, launcher assets and isolated build output with
  relative asset paths. Package application assets locally so startup does
  not depend on Substream hosting.
- Add proposed commands `build:webos`, `package:webos`, `install:webos` and
  `launch:webos`, using LG's supported CLI and `.ipk` packaging. Verify the
  toolchain's host prerequisites before selecting/installing its version.
- Separate the LG engine target from existing Tizen compatibility settings.
  Keep browser, Tizen 3 and Tizen 6 outputs functioning.
- Ship a clean credential-free package by default: no personal defaults,
  development proxies, private deployment records or local endpoint defaults.
- Document Developer Mode setup, device key acquisition, install/launch/debug,
  renewal and recovery. Developer Mode is time-limited: LG states that expiry
  disables it and removes developer-installed apps.

## 5. Verify and accept

- Run `npm run check`; add meaningful synthetic coverage for LG runtime/input,
  lifecycle cleanup, playback selection and changed request routing.
- Inspect destinations, headers and payloads with synthetic credentials:
  provider, OpenSubtitles and TMDb credentials go directly only to their
  intended services, including retries and optional-service paths.
- Build browser, Samsung and LG artifacts. If shared CSS changes, run the
  Chromium 47 preview and inspect TV spacing, wrapping and focus.
- On the actual LG TV: import a catalogue; browse/search Live, Movies and
  Series; test channel changes, VOD seek/resume, audio/subtitles, text entry,
  pointer/D-pad navigation, Back, Home, relaunch, standby and network loss.
- Record large-catalogue responsiveness and repeated channel-switch resource
  behavior. Test with optional helpers disabled before testing enabled paths.

Acceptance: a clean `.ipk` installs and launches on the stated TV, persists
client settings/catalogue, supports direct baseline live/VOD playback and remote
navigation, cleans up playback correctly, and preserves existing Samsung/browser
behavior. Publish a tested support matrix and any device-specific limitations.
Physical-TV acceptance remains required even if desktop tests pass.

## References

- [Architecture](cross-platform-architecture.md)
- [Mandatory credential policy](client-credential-policy.md)
- [LG model listing](https://www.lg.com/cz/tv-a-soundbars/uhd-tv/55ut91006la/)
- [LG web engines](https://webostv.developer.lge.com/develop/specifications/web-api-and-web-engine)
- [LG streaming specifications](https://webostv.developer.lge.com/develop/specifications/streaming-protocol-drm)
- [LG webOS 25 media formats](https://webostv.developer.lge.com/develop/specifications/video-audio-250)
- [LG remote input](https://webostv.developer.lge.com/develop/guides/magic-remote)
- [LG Back behavior](https://webostv.developer.lge.com/develop/guides/back-button)
- [LG CLI](https://webostv.developer.lge.com/develop/tools/cli-introduction)
- [LG Developer Mode](https://webostv.developer.lge.com/develop/getting-started/developer-mode-app)
