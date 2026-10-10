# LG webOS TV implementation and acceptance

Status: the initial webOS port is implemented. Clean and personal webOS builds
are isolated from browser and Samsung outputs. The personal package was
installed and launched on the target TV; direct catalogue loading and one
1080p live stream were confirmed with picture and sound. Companion pairing,
staged MP4 playback/stop and reset/re-pair also passed a smoke check. Remaining work is
physical-device acceptance for VOD, tracks, remote interactions, broader media
support, persistence, and lifecycle recovery. An LG Content Store submission
would be a separate release project.

## Target and build profile

The physical target is an LG 55UT91006LA reporting webOS TV 25. LG lists this
2024 model family under webOS 24, so the installed software version is what
sets the web-engine target. LG documents Chromium 120 for webOS TV 25 and
Chromium 108 for webOS TV 24. The current LG Vite target is `chrome120`; a
firmware update does not prove support for additional codecs or containers.

The app is a packaged web app with ID `org.substream.app`, a local launcher
icon, and relative asset URLs. Browser and Tizen builds keep their own outputs
and compatibility targets. The webOS build omits the Tizen legacy entry and
targets the installed Chromium engine.

## Implemented runtime

- `RuntimePlatform` and bootstrap recognize webOS and select the TV interaction
  profile. LG globals stay behind `src/platform/webos` adapters.
- Direct playback uses the shared HTML video implementation with webOS app
  visibility handling. On background/foreground transitions, the adapter
  suspends playback and restores the single active source and safe playback
  state.
- The runtime routes the app's Back behavior through shared navigation and
  calls the platform Back at the app root. The manifest sets
  `disableBackHistoryAPI: true`. It reads the native virtual-keyboard visibility
  state so Back does not close the app while text entry is active.
- The runtime supports companion pairing and receiver commands. Pairing,
  staged H.264/AAC MP4 playback/stop, and reset/re-pair passed a physical smoke
  check on 2026-10-10; provider-command resolution, subtitles and seek remain
  pending. LG has no TV-side local-file picker.
  It does not use Samsung AVPlay, and the personal webOS build does not enable
  the Samsung live subtitle relay. Provider, OpenSubtitles, and TMDb requests
  use the direct client paths; credentials are not routed through helper
  services.
- Build, package, install, launch, personal deployment, and generic Tizen/LG
  dispatch commands are documented in the [webOS TV guide](../webos/README.md).
  The package process checks archive paths for `.env` / `.env.*` and `.local` / `.local.*` records.

## Personal and clean outputs

The clean build commands are `npm run build:webos` and
`npm run package:webos`. They do not read `.env`, carry no personal defaults,
and write to ignored `webos/dist/` and `webos/packages/` directories.

The explicit personal commands are `npm run build:webos:personal` and
`npm run package:webos:personal`. They use the existing `.env` defaults and
write to separate ignored `webos/personal-dist/` and
`webos/personal-packages/` directories. Required provider/API values and the
private-artifact warning are listed in the [webOS TV guide](../webos/README.md).
The IPK embeds the configured defaults without encryption. This is a local
personal artifact and must not be published or shared. The deployment CLI
receives only an allowlisted runtime environment; its device SSH key remains
in the CLI's external key store. The ignored `LG_WEBOS_DEVICE` setting selects
the default deployment target and is not compiled into the app.
`LG_WEBOS_LOCAL_IP` can replace the companion host only in personal LG builds;
its scheme/port come from `COMPANION_SERVER_URL`, or HTTP port 8787 by default.
Saved TV settings take precedence. See [LG configuration](../webos/README.md#configure-a-personal-deployment).

## Physical-TV results and remaining checks

| Area | Status |
| --- | --- |
| Developer Mode installation and app startup | Confirmed on the target TV |
| Direct personal playlist load and live-category browsing | Confirmed; 18 live categories loaded |
| Baseline live playback | Confirmed for one 1080p stream with picture and sound |
| VOD pause, seek, and resume | Pending physical-TV check |
| Audio tracks, subtitle tracks, and external subtitle behavior | Pending physical-TV check |
| H.264/AAC beyond the confirmed stream, HEVC, containers, and provider MPEG-TS variants | Pending per-format checks; no broad codec matrix established |
| Magic Remote pointer/D-pad transitions, virtual keyboard editing, Back, and Home | Pending physical-TV check |
| App relaunch, standby, network loss, and persistence after TV restart | Pending physical-TV check |
| Large catalogues and repeated live-channel switching | Pending performance/resource checks |
| Companion pairing | Confirmed on 2026-10-10; LG paired with a temporary browser |
| Browser-staged local media | Confirmed on 2026-10-10 with one synthetic 60-second H.264/AAC MP4; playback advanced on the TV and stop removed the player/title without error |
| Pairing reset and re-pair | Confirmed on 2026-10-10; fresh code appeared, receiver stayed connected/unpaired, and a new sequence-1 local-play command succeeded after re-pair |
| Provider playback commands, local subtitles/seek | Pending physical-TV check |
| General network/standby recovery | Pending physical-TV check |
| Samsung live subtitle relay and LG TV-side local-file picker | Unsupported |

These results establish a working direct live-TV path, not full playback or
remote parity with Samsung. Keep advertised capabilities limited to behavior
verified by the webOS runtime and physical device.

## Remaining acceptance work

1. Exercise VOD seek/resume, episode changes, audio/subtitle enumeration and
   external subtitle overlays with representative provider streams.
2. Verify remote and keyboard interaction: pointer and D-pad focus changes,
   text entry, app Back routing, platform Back at the root, and Home/relaunch.
3. Check app close/relaunch, standby/resume, network loss, and persistence of
   the catalogue and client settings across a TV restart.
4. Extend media coverage with known test streams for supported codecs,
   containers, HLS, range requests, redirects, and TLS errors. Record exact
   working and failing combinations for this TV.
5. Measure large-catalogue browsing and resources after repeated channel
   switches. Test direct integrations before considering any optional service.

Do not address provider access problems by sending client credentials through
a proxy. Local browser storage is not a secret vault; personal package defaults
are extractable from the IPK and should be handled as private data.

## References

- [Cross-platform architecture](cross-platform-architecture.md)
- [Client credential policy](client-credential-policy.md)
- [LG webOS setup, packaging, and deployment guide](../webos/README.md)
- [LG 55UT91006LA listing](https://www.lg.com/cz/tv-a-soundbars/uhd-tv/55ut91006la/)
- [webOS web-engine versions](https://webostv.developer.lge.com/develop/specifications/web-api-and-web-engine)
- [webOS 25 audio and video formats](https://webostv.developer.lge.com/develop/specifications/video-audio-250)
- [Streaming protocols and DRM](https://webostv.developer.lge.com/develop/specifications/streaming-protocol-drm)
- [Magic Remote](https://webostv.developer.lge.com/develop/guides/magic-remote)
- [Back button behavior](https://webostv.developer.lge.com/develop/guides/back-button)
- [CLI installation](https://webostv.developer.lge.com/develop/tools/cli-installation)
- [CLI developer guide](https://webostv.developer.lge.com/develop/tools/cli-dev-guide)
- [Developer Mode app and session extension](https://webostv.developer.lge.com/develop/getting-started/developer-mode-app)
