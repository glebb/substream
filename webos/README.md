# Substream for LG webOS TV

This directory contains the LG webOS app manifest, icon, and this guide. The
app reuses Substream's shared screens and core, with a webOS runtime and direct
HTML video player. The LG build targets Chromium 120 (webOS TV 25), uses
relative asset paths, and packages its app files locally. Browser and Samsung
Tizen builds retain their own targets and packaging flows.

LG VOD uses direct native MKV playback. Its native pipeline can decode
Matroska/Dolby combinations that its MP4 MediaSource pipeline rejects, even
when `canPlayType("video/x-matroska")` returns an empty string. The webOS
adapter bypasses the browser MKV remuxer and development compatibility path;
provider requests still go directly from the TV to the provider. Desktop
browser remuxing and Samsung AVPlay retain their existing behavior.

The physical target used for the initial port is an LG 55UT91006LA reporting
webOS TV 25. LG lists this model in its 2024/webOS 24 range, so check the
installed version on the TV before changing the engine target. LG's engine
table lists Chromium 120 for webOS 25 and Chromium 108 for webOS 24. An OS
update does not establish support for additional codecs or containers.

## Prepare the TV and CLI

Install LG's current [webOS CLI](https://webostv.developer.lge.com/develop/tools/cli-installation)
from npm and make its `ares-*` commands available in `PATH`:

```sh
npm install -g @webos-tools/cli
ares -V
```

On the TV, install/open the Developer Mode app, enable Developer Mode, and
enable its Key Server. Keep the TV online while doing this. On the development
computer, register a device name with `ares-setup-device` using the connection
details shown by the TV's Developer Mode app. For example, the generic name
used in this guide is `lg-tv-example`; enter the real connection details only
in the local CLI setup. Retrieve the Developer Mode key with:

```sh
ares-novacom --device lg-tv-example --getkey
```

Follow the TV's prompt for the displayed key-server passphrase. The CLI keeps
the SSH key in its external key store; it is separate from the app's `.env`
defaults. Do not commit CLI setup files, keys, TV addresses, or command output
that contains connection details. LG's [CLI guide](https://webostv.developer.lge.com/develop/tools/cli-dev-guide)
documents device setup, packaging, installation, launching, and inspection.

Check the installed webOS version in the TV's General / TV Information screen
and, if needed, with LG's device-information CLI. Device and network values
remain in ignored local configuration.

## Configure a personal deployment

The one-command deployment builds the personal package from the existing
project `.env`. The personal build requires these values:

- `IPTV_M3U_URL`
- `OPENSUBTITLES_API_KEY`
- `TMDB_API_READ_ACCESS_TOKEN` or `TMDB_API_KEY`

`COMPANION_SERVER_URL` is an optional personal default for the LAN companion.
For a personal LG package, `LG_WEBOS_LOCAL_IP` can set the companion host to the
Mac's LAN IP address or hostname, so the TV connects back to the computer
running the companion. The build keeps the protocol and port from
`COMPANION_SERVER_URL`; if it is unset, the default is HTTP on port 8787. This
LG-only override does not change the shared browser or Tizen companion address.
The value belongs in ignored `.env` and is an app service address, not the
registered TV deployment target. After packaging, the TV's saved companion
address (or a `companion` query parameter) takes precedence over the bundled
default; edit **Settings → TV connection** if it points elsewhere.

LG supports pairing, provider playback commands, and receiving browser-staged
local-media sessions. The TV resolves provider identifiers against its own
saved playlist and builds provider stream URLs locally. The companion receives
no playlist credentials or provider stream URLs. The LG app has no TV-side file
picker, and the Samsung live subtitle relay remains disabled.

Set `LG_WEBOS_DEVICE` in the ignored `.env` if the generic deployment command
should use a default registered target. For example, the value may be the
synthetic name `lg-tv-example`; keep the real registered name in the local
file. This deployment setting is not compiled into the app. Device names,
connection addresses, Developer Mode keys, and other local deployment details
belong in ignored `.env` or `.local/deployment/`, never in tracked files.

## Build, package, install, and launch

From the project root:

```sh
npm run build:webos
npm run package:webos
npm run install:webos -- --device lg-tv-example webos/packages/<generated-file>.ipk
npm run launch:webos -- --device lg-tv-example
```

`build:webos` produces the clean Chromium 120 staging directory at
`webos/dist/`; it does not read `.env` or embed personal defaults.
`package:webos` invokes LG's `ares-package` and writes the IPK to
`webos/packages/`. Both clean commands work without a TV target; packaging
requires the official CLI. The package command audits the IPK's application
archive and rejects `.env` / `.env.*` and `.local` / `.local.*` path components.

For the private personal package, use the explicit personal commands:

```sh
npm run build:webos:personal
npm run package:webos:personal
npm run install:webos -- --device lg-tv-example webos/personal-packages/<generated-file>.ipk
npm run launch:webos -- --device lg-tv-example
```

These commands use the operator's `.env` values and write to the separate
ignored directories `webos/personal-dist/` and `webos/personal-packages/`.
Treat every personal IPK and personal build directory as a private,
credential-bearing artifact. The configured playlist, OpenSubtitles, and TMDb
defaults are embedded in the app package; the package does not encrypt them.
Keep it local and do not publish or share it. The app sends provider and API
credentials directly from the TV to their intended services. The build does
not add a credential proxy or upload these values to Substream services.

The app manifest ID is `org.substream.app`. `disableBackHistoryAPI` is enabled
because shared app navigation handles Back and invokes platform Back at the
app root. The deploy/install wrappers suppress LG CLI output and pass only the
runtime environment required by the CLI; app credentials are not needed by
the device-management commands.

## One-command deployment

Once the CLI target and Developer Mode key are configured, deploy a personal
build with:

```sh
npm run deploy lg-tv-example
```

If `LG_WEBOS_DEVICE` is set in ignored `.env`, `npm run deploy` uses that
registered target. An explicit command argument takes precedence. The command
builds and audits a fresh personal IPK, attempts to close an existing app
instance, installs the IPK, and launches the app. Closing is best-effort for
the first install; packaging, installation, and launch failures stop the
remaining deployment steps. The CLI output is suppressed so it does not print
connection details.

The same dispatcher preserves Samsung's existing signing flow:

```sh
npm run deploy tizen3
npm run deploy tizen6
```

Do not combine the webOS build with `PERSONAL_BUILD`, `PUBLIC_BUILD`,
`CHROMIUM47_PREVIEW`, or `TIZEN_COMPAT_TARGET` shell modes. The webOS commands
select and validate the intended clean or personal mode themselves. The
personal app build reads `.env`; the LG CLI subprocess receives an allowlisted
runtime environment and keeps its SSH key in the CLI's external key store.

## Debugging and recovery

Use the official CLI to inspect an installed or running app. These commands
use the target name configured in the CLI:

```sh
ares-install --device lg-tv-example --list
ares-launch --device lg-tv-example --running
ares-inspect --device lg-tv-example --app org.substream.app
```

Treat device-management output as local: it may contain device connection
details. If an `ares-*` command is unavailable, install the current
`@webos-tools/cli` package and check `PATH`. If the target cannot connect,
confirm Developer Mode is enabled, the TV is online, the registered target
matches the TV's current connection settings, and the key was retrieved while
the Key Server was enabled. Deployment reports command and exit status without
printing the CLI's raw network diagnostics.

Developer Mode is time-limited. Extend the session from the Developer Mode app
while it is active and the TV is online. If it expires, re-enable Developer
Mode and restore the CLI key as needed, then reinstall the developer package;
LG states that expiry disables Developer Mode and removes developer-installed
apps. See LG's [Developer Mode app guide](https://webostv.developer.lge.com/develop/getting-started/developer-mode-app).
An IPK made this way is a Developer Mode artifact, not a Content Store
submission.

## Physical-TV validation

Confirmed on the target TV on 2026-10-10: personal deployment installed and
launched, the configured companion automatically connected to the Mac, the TV
displayed a pairing code and paired with a temporary browser, and a synthetic
60-second H.264/AAC MP4 staged from that browser played on the TV. During the
smoke check the video element reached `readyState` 4 at 320×180 and advanced to
about 7.8 seconds without pausing or reporting an error. A stop command was
accepted; the video element and synthetic title were then removed without an
error. Pairing reset produced a fresh code while the receiver stayed connected
and unpaired. Re-pairing with that code accepted a new sequence-1 local-play
command and played a second synthetic file without error; a second reset left a
fresh code visible. The personal playlist also loaded 18 live categories
directly, and a 1080p live stream produced picture and sound. The Samsung live
subtitle relay remains disabled.

Also confirmed on 2026-10-10: a provider MKV episode that failed in the
browser MP4 remux path played through the LG native pipeline. After installing
the adapter fix, opening the episode from recent titles and choosing Resume
restored its saved position, reached `readyState` 4 at 1920×1080, and advanced
past 118 seconds with no media error and no blob/remux source. This validates
that episode's native playback and saved-position restoration, not all codecs
or track-selection combinations.

The same episode was also paused immediately after a resume and held for
96 seconds on 2026-10-10. The playhead stayed fixed, the paused title remained
visible, and no startup timeout or error overlay appeared. The media Play
control then resumed 1080p playback and advanced by five seconds without an
error. Intentional pause cancels the startup and buffering deadlines; resuming
arms a fresh deadline for a genuine playback stall.

Still pending physical-TV checks include provider command resolution, local
subtitle transfer and seek, VOD seek/resume, audio and subtitle track
selection, broader container/codec coverage, Magic Remote pointer and D-pad
transitions, keyboard editing, Back/Home paths, persistence across restart,
and general standby/network-loss recovery. The smoke check does not establish
these behaviors or broad media compatibility.

## Official references

- [webOS CLI installation](https://webostv.developer.lge.com/develop/tools/cli-installation)
- [CLI developer guide](https://webostv.developer.lge.com/develop/tools/cli-dev-guide)
- [Developer Mode app](https://webostv.developer.lge.com/develop/getting-started/developer-mode-app)
- [App metadata (`appinfo.json`)](https://webostv.developer.lge.com/develop/references/appinfo-json)
- [Web API and web engine versions](https://webostv.developer.lge.com/develop/specifications/web-api-and-web-engine)
- [Streaming protocols and DRM](https://webostv.developer.lge.com/develop/specifications/streaming-protocol-drm)
- [webOS 25 media formats](https://webostv.developer.lge.com/develop/specifications/video-audio-250)
- [Magic Remote](https://webostv.developer.lge.com/develop/guides/magic-remote)
- [Back button behavior](https://webostv.developer.lge.com/develop/guides/back-button)
