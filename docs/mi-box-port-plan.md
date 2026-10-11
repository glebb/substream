# Android TV / Xiaomi Mi Box S build and acceptance guide

Status (2026-10-11): the Kotlin shell, shared runtime adapters, Gradle wrapper and packaging commands are implemented. Clean and private debug APKs have been produced locally. This is build evidence, not physical Mi Box acceptance: installation, remote input, live/VOD playback, codec and subtitle support, and persistence on the target box remain unverified. See [shared architecture](cross-platform-architecture.md) and the [device checklist](verification.md#android-tv--mi-box-s-check).

## Target and approach

Target the original Xiaomi Mi Box S 4K HDR shipping baseline: Android TV 8.1 (API 27). Do not require an operating-system or WebView update. Verify the factory WebView version before choosing the Android JavaScript build target. Xiaomi's [original specifications](https://www.mi.com/ae-en/product/mi-box-s/specs/) identify Android 8.1 as the shipping OS.

The current APK uses a Kotlin shell, the shared React UI bundled in a WebView, and native AndroidX Media3/ExoPlayer playback. It reuses the TypeScript catalogue, classification, subtitle rules, and service integrations. Android integrations stay behind adapters; `src/core` remains independent of Android, browser, React, Node, Tizen, and webOS globals.

Use `minSdkVersion 27` and select dependency versions that support it. Compile/target SDK versions are separate from the minimum supported OS. Preserve the shared Chromium 47 CSS baseline and verify Tizen after shared UI changes.

## Implementation and remaining work

### 1. Verify the target device (pending)

- Record the actual box model, installed Android version, WebView version, and available decoder capabilities. An updated physical box does not establish factory-software compatibility; also validate Android 8.1 explicitly.
- Install the current bundled-WebView/native-surface APK and verify video remains behind the shared controls.
- Test synthetic HLS, direct MPEG-TS, and MP4 playback, audio, transparent UI overlays, fullscreen/preview positioning, and D-pad/OK/Back input on the box.
- Start with responsive navigation and H.264/AAC 1080p playback. Test 4K, HEVC, HDR, AC-3/E-AC-3, and HDMI audio separately; do not infer support from container support or the product name.

Exit criterion: the current APK installs by USB, appears in the TV launcher, and plays test media with responsive remote controls and visible overlays.

### 2. Repeatable Android build (implemented)

- Implemented the Kotlin/Gradle shell under `android/`; it loads bundled Vite output through `WebViewAssetLoader` at `https://appassets.androidplatform.net/assets/`.
- Implemented the Android TV launcher entry (`LEANBACK_LAUNCHER`), icon/banner, internet permission, and touchscreen-optional declaration.
- Build clean WebView assets and package them with Gradle using `npm run build:android:web` and `npm run package:android`. The debug APK is `android/app/build/outputs/apk/debug/app-debug.apk`. `npm run package:android:release` invokes `:app:assembleRelease` and is configured to produce an unsigned release APK; configure a private release signing key before distribution. Do not reuse Tizen `.wgt` packaging.
- Keep ordinary Android packages free of private `.env` defaults, provider credentials, API credentials, relay tokens, and signed media URLs. Enter configuration on-device; do not assume local storage is a secret vault.
- The application ID is `org.substream.app`. Configure a stable release signing key before distribution; keep signing material and passwords out of Git and generated logs.

### 3. Android adapters (implemented, device validation pending)

- Reuse `src/contracts/runtime.ts`, `src/bootstrap/runtime.ts` and the TV interaction profile. Shared screens already use a player factory and injected catalogue/preferences/transport rather than selecting Tizen players.
- Android adapters live under `src/platform/android/`; bootstrap selects Android only when the native host bridge exists. Samsung registration and AVPlay stay in their own adapters.
- The shared screens provide a DOM bounds container; the Kotlin shell positions the native player below the transparent WebView. Validate preview and fullscreen placement on the box.
- Reuse the playback release barrier and stale-session guards; add actual native lifecycle/engine capabilities rather than relying solely on live/VOD request kind.
- Preserve unknown catalogue entries and classification evidence throughout the port.

### 4. Native playback (bridge implemented, hardware acceptance pending)

- The `MediaPlayer` bridge implements load, play/pause, progress/state events, resume/seeking, skip, restart, aspect modes, track enumeration/selection, resize and destruction. Hardware format and track behavior remain unverified.
- Use request/session identifiers to reject callbacks from replaced players and prevent overlapping playback sessions during channel changes.
- Handle audio focus, Home/background transitions, sleep/wake, activity recreation, and surface changes. Stop/release playback resources when leaving playback; persist VOD resume state.
- Expose live buffer controls only when the native player reports a usable seekable window. Do not manufacture recording or catch-up support.
- Validate video/UI layering and coordinates at the box's actual display resolution.

### 5. Networking, storage and remote input (partly implemented)

- Audit provider, metadata, EPG, OpenSubtitles, companion, and relay requests. Development proxy routes will not exist inside the APK.
- The Android request bridge sends HTTP(S) requests directly from the box to the requested host, avoiding WebView CORS for calls routed through runtime transport. It has deadlines and generic errors, disables redirects, and caps request bodies at 1 MiB and responses at 16 MiB. Add actual request cancellation and a streaming or batched import path for larger playlists; do not copy an entire large playlist through the JavaScript bridge.
- Define the HTTP policy for provider and trusted-LAN endpoints explicitly, while retaining TLS validation for HTTPS.
- Restrict native bridge access to trusted bundled content, validate messages, and prevent remote pages or frames from obtaining native capabilities. Do not disable WebView security globally to resolve CORS.
- Verify IndexedDB/local settings persistence across restarts and APK updates. Keep credentials out of diagnostics, backup exports, and logs.
- D-pad/OK currently use WebView key events; the shell maps Android Back/Escape to the shared Escape route. Verify key handling, focus after dialogs and playback return, and available media keys on the actual remote.
- Make favourites and other Samsung colour-key shortcuts available through visible controls. Verify search, settings entry, and the TV keyboard using only the Mi Box remote.

### 6. Subtitles and companion playback (partly implemented)

- External SRT/WebVTT attachment, embedded track enumeration/selection and enable/disable commands are wired to Media3. The Android player reports no subtitle timing or styling adjustment capability; verify rendering and finish those controls before claiming parity. Select one rendering owner to avoid duplicate native/web captions.
- Test embedded subtitle and audio tracks on actual media/device combinations; do not assume every DVB subtitle stream is exposed by the native player.
- Keep relay and companion optional; direct provider browsing/playback must work with both disabled. Android currently disables the Samsung live subtitle relay. Any future relay support needs a separate Media3 integration and cue-timing verification; do not assume AVPlay's PNG overlay works on Android.
- If Android relay support is added later, ensure channel changes, exits, and background transitions close its sessions and stop unused ingest.
- Verify optional companion pairing, VOD commands, and computer-to-box local-file playback. Preserve the requirement that the companion computer stays available for its local media sessions.

### 7. Validate and release (pending)

- Run `npm run check` and appropriate Android bridge, remote-input, and lifecycle tests using synthetic fixtures only.
- Verify Android 8.1 compatibility and physical-box playback separately. Automated tests do not establish hardware codec support.
- Check Chromium 47 preview and existing Tizen builds after shared UI/CSS changes; retain flex-and-margin layouts.
- On the Mi Box, exercise startup, catalogue import, search, channel switching, movie/series playback, resume, subtitle/audio selection, network recovery, sleep/wake, and restart persistence.
- Run a sustained playback session and check responsiveness, memory growth, subtitle synchronization, and cleanup after repeated channel changes.
- Produce a signed release APK and perform both a fresh USB installation and an in-place USB update.

First milestone: an APK visible in the Mi Box launcher that opens Substream, works with the remote, and plays one live channel and one VOD title.

Completion criterion: live TV and VOD with usable subtitles, saved settings/favourites/resume, reliable restart and sleep/wake behavior, and repeatable USB installation/update instructions.

## Android build prerequisites

Use Node.js 22.18+ and npm for the Vite assets, plus JDK 17, Android SDK Platform 35 and Android Build Tools 34.0.0. The repository's Gradle wrapper downloads and verifies Gradle 8.9, so a separate Gradle installation is unnecessary. Set `JAVA_HOME` to JDK 17 and `ANDROID_HOME` or `ANDROID_SDK_ROOT` to the SDK installation. Gradle downloads the Android Gradle Plugin and dependencies from Google Maven and Maven Central on first use.

```sh
npm install
npm run build:android:web
npm run package:android
```

`build:android:web` forces the public build mode, removes `VITE_*` overrides, audits generated files and copies the Vite output to `android/app/src/main/assets/`. `package:android` repeats that build before Gradle packaging. The APK uses application ID `org.substream.app`, minimum API 27, target API 28 and currently version code 1. The debug output is `android/app/build/outputs/apk/debug/app-debug.apk`; it is signed with the local Android debug key. `npm run package:android:release` is configured to emit `android/app/build/outputs/apk/release/app-release-unsigned.apk` until private release signing is added. Do not distribute the unsigned artifact. A previous clean debug APK in the local workspace establishes that packaging has run, but it does not establish a repeatable release build or device compatibility.

For local emulator testing with `.env` defaults, start an Android emulator and run `npm run deploy android`. If several emulators are running, use `npm run deploy android emulator-5554` with the selected serial from `adb devices`. This builds a private debug APK at `android/personal-packages/app-personal-debug.apk`, installs it, and launches Substream. `npm run package:android:personal` builds the same private APK without installing it. Both commands require the existing personal-build playlist, OpenSubtitles, and TMDb settings in `.env`. Private assets and the Gradle workspace are staged in ignored directories, separate from the clean Android assets and APK. The private APK contains recoverable credentials; keep it local and do not distribute it.

In the standalone Android TV emulator on this Mac, use the arrow keys to move, Return to select, and **Command+Delete** for Android Back. The Mac Escape key is not forwarded as Back by this emulator. Click inside the emulator window before using the keyboard.

The current emulator reports a physical 1920×1080 display at 320 dpi. Android WebView therefore lays out the page at roughly 960×540 CSS pixels; a 960-pixel-wide screenshot or `window.innerWidth` does not mean the TV output is 960 pixels wide. Check `adb shell wm size` and `adb shell wm density` on both the emulator and the Mi Box, and judge the layout at the resulting CSS viewport. Keep the Android page responsive instead of forcing a 1920-pixel CSS viewport or changing the device's density.

The native request bridge sends provider/API requests directly from the box to their requested hosts with redirects disabled. It caps request bodies at 1 MiB and responses at 16 MiB; larger playlists need a streaming import path. JavaScript abort currently stops waiting for a result but does not cancel the native request. The shell requests Android media audio focus through Media3, but focus interruption behavior still needs device checks. Subtitle timing offset/styling and live relay playback are unavailable on Android. These limits should be resolved or clearly accepted before a release.

## USB installation

USB sideloading is the intended Mi Box deployment method. It requires neither ADB nor developer mode, but the steps below still need confirmation on the target box and firmware. The existing Tizen `.wgt` and webOS `.ipk` packages cannot be installed on Android.

1. Build the debug APK with `npm run package:android` or configure private release signing before using the release variant.
2. Copy `android/app/build/outputs/apk/debug/app-debug.apk` to a USB flash drive as `substream.apk`. Use a drive/filesystem the box can read; FAT32 is a practical starting point. Do not reformat a drive containing needed files.
3. Install a TV-compatible file manager from the box's Play Store if there is no installed app that can browse USB storage and open APKs.
4. Insert the drive into the Mi Box's USB port and open it in the file manager. Grant storage access if requested.
5. Select `substream.apk`. If Android blocks installation, follow its Settings prompt and allow that file manager to install unknown apps. Android 8.1 grants this permission per source app; menu wording varies by firmware and may appear under Security & restrictions / Unknown sources.
6. Return to the file manager, open the APK again, and confirm installation.
7. Open Substream from the Android TV launcher and enter the playlist/service configuration in Settings.
8. Verify remote navigation, one live channel, one VOD title, subtitles, and persistence after closing/reopening the app. Remove the USB drive after installation.

If installation fails, verify API 27 compatibility, CPU/ABI compatibility of any native libraries, available internal storage, and a complete APK copy. If installation succeeds but no launcher entry appears, check the TV manifest/launcher declaration. Do not uninstall an existing working installation as the first troubleshooting step.

### USB updates

1. Increase `versionCode` in `android/app/build.gradle.kts`, then build a new APK with the same application ID and signing key.
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
