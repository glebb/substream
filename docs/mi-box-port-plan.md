# Xiaomi Mi Box S port and USB deployment plan

Status: deferred. Android support and APK build commands are not implemented. The shared runtime, input, player factory, repository ports and optional companion lifecycle are already in place; see [shared architecture](cross-platform-architecture.md). This document is a future implementation proposal, not installation instructions for an existing APK.

## Target and approach

Target the original Xiaomi Mi Box S 4K HDR shipping baseline: Android TV 8.1 (API 27). Do not require an operating-system or WebView update. Verify the factory WebView version before choosing the Android JavaScript build target. Xiaomi's [original specifications](https://www.mi.com/ae-en/product/mi-box-s/specs/) identify Android 8.1 as the shipping OS.

Build an Android TV APK with a Kotlin shell, the existing React UI bundled in a WebView, and native AndroidX Media3/ExoPlayer playback. Reuse the TypeScript catalogue, classification, subtitle rules, and service integrations. Keep Android integrations behind adapters; `src/core` remains independent of Android, browser, React, Node, and Tizen globals.

Use `minSdkVersion 27` and select dependency versions that support it. Compile/target SDK versions are separate from the minimum supported OS. Preserve the shared Chromium 47 CSS baseline and verify Tizen after shared UI changes.

## Implementation sequence

### 1. Prove the device integration

- Record the actual box model, installed Android version, WebView version, and available decoder capabilities. An updated physical box does not establish factory-software compatibility; also validate Android 8.1 explicitly.
- Create a small Android TV prototype using bundled web assets and a native video surface beneath the WebView.
- Test synthetic HLS, direct MPEG-TS, and MP4 playback, audio, transparent UI overlays, fullscreen/preview positioning, and D-pad/OK/Back input on the box.
- Start with responsive navigation and H.264/AAC 1080p playback. Test 4K, HEVC, HDR, AC-3/E-AC-3, and HDMI audio separately; do not infer support from container support or the product name.

Exit criterion: the prototype installs by USB, appears in the TV launcher, and plays test media with responsive remote controls and visible overlays.

### 2. Add a repeatable Android build

- Create the Kotlin/Gradle project under `android/` and bundle the Vite output using `WebViewAssetLoader` with a stable app origin.
- Add the Android TV launcher entry (`LEANBACK_LAUNCHER`), icon/banner, internet permission, and touchscreen-optional declaration.
- Add explicit Android build/package commands and document their prerequisites and actual output paths once implemented. Do not reuse Tizen `.wgt` packaging.
- Keep ordinary Android packages free of private `.env` defaults, provider credentials, API credentials, relay tokens, and signed media URLs. Enter configuration on-device; do not assume local storage is a secret vault.
- Define a stable application ID and release signing key. Keep signing material and passwords out of Git and generated logs.

### 3. Supply Android adapters for the shared runtime

- Reuse `src/contracts/runtime.ts`, `src/bootstrap/runtime.ts` and the TV interaction profile. Shared screens already use a player factory and injected catalogue/preferences/transport rather than selecting Tizen players.
- Add Android adapters under `src/platform/android/` and extend runtime identity only when the Android host exists. Keep Samsung registration and AVPlay in their existing adapters.
- Replace DOM-bound playback surface requests with a suitable native surface seam where needed; do not duplicate shared player controls or navigation.
- Reuse the playback release barrier and stale-session guards; add actual native lifecycle/engine capabilities rather than relying solely on live/VOD request kind.
- Preserve unknown catalogue entries and classification evidence throughout the port.

### 4. Implement native playback

- Implement the existing `MediaPlayer` interface through a narrow Android bridge: load, play/pause, progress/state events, resume/seeking, skip, restart, aspect modes, track enumeration/selection, resize, and destruction.
- Use request/session identifiers to reject callbacks from replaced players and prevent overlapping playback sessions during channel changes.
- Handle audio focus, Home/background transitions, sleep/wake, activity recreation, and surface changes. Stop/release playback resources when leaving playback; persist VOD resume state.
- Expose live buffer controls only when the native player reports a usable seekable window. Do not manufacture recording or catch-up support.
- Validate video/UI layering and coordinates at the box's actual display resolution.

### 5. Connect networking, storage, and remote input

- Audit provider, metadata, EPG, OpenSubtitles, companion, and relay requests. Development proxy routes will not exist inside the APK.
- Add native networking where browser CORS prevents direct requests. Include cancellation, timeouts, redirects, safe error reporting, and bounded streaming/batching for playlist import; avoid copying a whole large playlist through the JavaScript bridge.
- Define the HTTP policy for provider and trusted-LAN endpoints explicitly, while retaining TLS validation for HTTPS.
- Restrict native bridge access to trusted bundled content, validate messages, and prevent remote pages or frames from obtaining native capabilities. Do not disable WebView security globally to resolve CORS.
- Verify IndexedDB/local settings persistence across restarts and APK updates. Keep credentials out of diagnostics, backup exports, and logs.
- Map native input into the shared logical input contract: D-pad, OK, Back, and available media keys without double-dispatching native and web events. Preserve focus after dialogs and playback return.
- Make favourites and other Samsung colour-key shortcuts available through visible controls. Verify search, settings entry, and the TV keyboard using only the Mi Box remote.

### 6. Port subtitles and companion playback

- Support external SRT/WebVTT subtitles, preferred Finnish/English language, size, enable/disable, and timing offset. Select one rendering owner to avoid duplicate native/web captions.
- Test embedded subtitle and audio tracks on actual media/device combinations; do not assume every DVB subtitle stream is exposed by the native player.
- Keep relay and companion optional; direct provider browsing/playback must work with both disabled. Reuse the Multi-Sub relay when configured. Replace AVPlay-specific playback/PNG-overlay integration and verify cue timing against Media3's playhead, including buffering, reconnects, and discontinuities.
- Ensure channel changes, exits, and background transitions close relay sessions and stop unused ingest.
- Verify optional companion pairing, VOD commands, and computer-to-box local-file playback. Preserve the requirement that the companion computer stays available for its local media sessions.

### 7. Validate and release

- Run `npm run check` and appropriate Android bridge, remote-input, and lifecycle tests using synthetic fixtures only.
- Verify Android 8.1 compatibility and physical-box playback separately. Automated tests do not establish hardware codec support.
- Check Chromium 47 preview and existing Tizen builds after shared UI/CSS changes; retain flex-and-margin layouts.
- On the Mi Box, exercise startup, catalogue import, search, channel switching, movie/series playback, resume, subtitle/audio selection, network recovery, sleep/wake, and restart persistence.
- Run a sustained playback session and check responsiveness, memory growth, subtitle synchronization, and cleanup after repeated channel changes.
- Produce a signed release APK and perform both a fresh USB installation and an in-place USB update.

First milestone: an APK visible in the Mi Box launcher that opens Substream, works with the remote, and plays one live channel and one VOD title.

Completion criterion: live TV and VOD with usable subtitles, saved settings/favourites/resume, reliable restart and sleep/wake behavior, and repeatable USB installation/update instructions.

## USB installation

USB sideloading is the primary deployment method. It requires neither ADB nor developer mode. These steps apply once the Android APK exists; the existing Tizen `.wgt` package cannot be installed on Android.

1. Build the Android APK. For regular use, use the signed release APK; record its actual output path in this guide when build tooling is implemented.
2. Copy the APK to a USB flash drive as `substream.apk`. Use a drive/filesystem the box can read; FAT32 is a practical starting point. Do not reformat a drive containing needed files.
3. Install a TV-compatible file manager from the box's Play Store if there is no installed app that can browse USB storage and open APKs.
4. Insert the drive into the Mi Box's USB port and open it in the file manager. Grant storage access if requested.
5. Select `substream.apk`. If Android blocks installation, follow its Settings prompt and allow that file manager to install unknown apps. Android 8.1 grants this permission per source app; menu wording varies by firmware and may appear under Security & restrictions / Unknown sources.
6. Return to the file manager, open the APK again, and confirm installation.
7. Open Substream from the Android TV launcher and enter the playlist/service configuration in Settings.
8. Verify remote navigation, one live channel, one VOD title, subtitles, and persistence after closing/reopening the app. Remove the USB drive after installation.

If installation fails, verify API 27 compatibility, CPU/ABI compatibility of any native libraries, available internal storage, and a complete APK copy. If installation succeeds but no launcher entry appears, check the TV manifest/launcher declaration. Do not uninstall an existing working installation as the first troubleshooting step.

### USB updates

1. Build a new APK with the same application ID and signing key, and a higher version code.
2. Copy it to the USB drive and open it on the box using the same file manager.
3. Confirm the update without uninstalling the existing app. In-place updates normally preserve app data; verify settings, favourites, catalogue access, and playback resume afterward.

A debug-signed APK cannot be updated directly with a release APK signed by a different key. Choose the signing strategy before storing important data on the box. Android normally rejects version-code downgrades, so do not assume a previous APK can be reinstalled over a newer one for rollback.

## Other deployment options

- A TV browser can download a release APK from a website or local server and launch installation, with installation permission granted to that browser/source app.
- ADB is an optional development convenience for frequent installs and diagnostics. Android 8.1 uses legacy ADB connectivity; network access depends on the firmware and may require an initial USB debugging connection. Modern wireless-debugging pairing is not a baseline requirement.

## References

- [Xiaomi: install software on Mi TV and Box using a USB drive](https://www.mi.com/ph/support/article/KA-06405/).
- [Android: APK distribution and per-source installation permission](https://developer.android.com/distribute/marketing-tools/alternative-distribution).
- [Android TV app manifest and setup](https://developer.android.com/training/tv/get-started/create).
- [Bundled WebView content and WebViewAssetLoader](https://developer.android.com/develop/ui/views/layout/webapps/load-local-content).
- [Media3 supported formats and device-dependent decoding](https://developer.android.com/media/media3/exoplayer/supported-formats).
- [WebView native bridge security](https://developer.android.com/privacy-and-security/risks/insecure-webview-native-bridges).
- [ADB connectivity and APK installation](https://developer.android.com/tools/adb).
