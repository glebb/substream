# Tizen setup and deployment

Run npm commands from the repository root. Open the `tizen/` folder in VS Code for the Tizen extension's signing and device actions. The application ID is `Substream0.Substream` (separate from the old My M3U app).

## Choose a target

| Target | Package | Build behavior |
| --- | --- | --- |
| Tizen 3 / Chromium 47 | `tizen/Debug/tizen3.wgt` | Legacy JavaScript fallback, static colors and flexbox UI |
| Tizen 6+ / Chromium 76 CSS target | `tizen/Debug/tizen6.wgt` | SystemJS entry only, avoiding the observed modern-module splash-screen failure |

Both variants overwrite `tizen/dist/` when prepared, so prepare, sign, and collect one variant before starting the other.

## One-time setup

1. Install the Samsung VS Code extension for Tizen with TV and certificate components.
2. Put the computer and TV on the same LAN. On the TV's Apps screen, enter `12345`, enable Developer Mode, set Host PC IP to the computer's LAN address, and fully restart the TV. Update that address after network changes.
3. In the extension's Certificate Manager, create a Samsung TV profile with an author certificate and a distributor certificate containing the TV's DUID. Back up the author certificate and password outside the repository; future updates need the same author certificate.
4. Connect the TV at `TV_IP:26101` in Device Manager and permit application installation using the matching certificate profile.
5. The launcher expects `~/tizentv-tools/sdb/sdb`, provisioned by the extension, or an explicit `SDB` environment variable pointing to the executable.

Keep certificate files, passwords, device profiles, and DUIDs private. Menu labels can vary by extension/TV version; the steps above describe the project's established workflow.

## Build, sign, install

```sh
npm run check
npm run prepare:tizen6
# In VS Code, build/sign the tizen project to produce tizen/Debug/tizen.wgt.
npm run collect:tizen6
npm run launch:tizen6 -- TV_IP
```

Replace `tizen6` with `tizen3` for the older target. For embedded personal defaults, use `prepare:tizen6:personal` or `prepare:tizen3:personal`; [personal configuration](../README.md#personal-development) requires the playlist, OpenSubtitles key, and a TMDb credential. Keep the resulting package private.

Prepare builds the web assets and records the variant. The extension must refresh its asset list and sign the new payload. Collect checks the variant marker and renames `Debug/tizen.wgt`; it does not prove that a package is fresh, so always sign immediately after preparing.

Launch connects by IP, pushes the package, **uninstalls the existing app**, installs the replacement, and attempts to launch it. Treat saved on-device data as disposable during this workflow. If remote launch is rejected after installation succeeds, open Substream manually from the TV Apps screen; this occurred on the previously tested UE75MU8005.

### Interactive personal deployment

Copy `.tizen-devices.local.example` to the ignored `.tizen-devices.local` and set `TIZEN3_TV_IP` / `TIZEN6_TV_IP`.

```sh
npm run deploy:tizen6
# Or override the configured address:
npm run deploy:tizen3 -- TV_IP
```

Deploy prepares a personal build, waits for you to sign in VS Code and press Enter, then collects and launches it. An interactive terminal is required.

### CLI packaging alternative

Copy `.tizen-cli.local.example` to `.tizen-cli.local` and set `TIZEN_CLI` to the Samsung CLI executable, or supply `TIZEN_CLI` / `TZ` in the environment. With signing configured:

```sh
npm run package:tizen
# Private credential-embedding variant:
npm run package:tizen:personal
```

These build and package both compatibility variants into `tizen/Debug/`. They require a working CLI signing setup; the VS Code prepare/sign/collect workflow does not require a separate CLI installation.

## Troubleshooting and validation

### Multi-Sub live subtitle relay

Personal Tizen preparation/build/packaging embeds the settings from the gitignored `.env.live-relay`. Run `npm run relay:personal` on the Mac to create those defaults, discover all provider channels marked `Multi-Sub`, and start the separate subtitle service. Matching channels select it automatically; no manual TV address, credential or channel mapping is needed. Keep the Mac awake. `dev:personal` starts the VOD/local-file companion, not this subtitle service.

Saved relay settings on the TV override bundled defaults, including an explicit opt-out. Standard/public packages do not enable or embed the personal relay credential. Personal packages remain private. See [local setup and configuration](../docs/live-subtitle-relay.md#automatic-personal-setup).

`Subtitle relay · Timing test` identifies relay playback. `progress=local`, `ack=confirmed`, and a changing `playheadMs` confirm the native playback clock and startup acknowledgement; `clock=unverified` remains until quantitative timing checks. `bufferEvents` counts native buffering starts. Runtime failures try two new relay sessions with `Subtitle relay · Reconnecting…` before `Relay unavailable · Direct playback`; initial setup failures go directly to fallback after teardown. Reconnection pauses are expected. The fallback does not open the extra provider TS audio-language probe.

Client recovery changes require a newly prepared, signed and installed TV package. The server timeout fix only requires restarting the relay. When moving to public HTTPS, update private build defaults, disable LAN HTTP opt-in, rebuild/reinstall, and verify certificate trust on the actual TV. The [deployment handoff](../docs/live-subtitle-relay-deployment.md) records the remaining work. Local testing was accepted as good enough on 2026-10-03; sustained stability and measured subtitle timing remain unverified.

### General troubleshooting

- **Cannot connect:** check Developer Mode, Host PC IP, the restart, port 26101, and LAN isolation/firewall settings.
- **Install rejected:** check the active certificate, distributor DUID, and permit-to-install step. Replacing the app does not bypass certificate requirements.
- **Missing package or wrong variant:** prepare, sign, and collect the same target again in that order.
- **Installed but not launched:** open the app manually; distinguish installation failure from the final remote-execute failure.
- **Stale assets or splash only:** confirm signing used the freshly built assets and the correct compatibility target.
- **Migration blocked:** close other app/tab connections and use Try again. Do not reset the catalogue merely because an upgrade is blocked.

Use the [verification guide](../docs/verification.md) for the Chromium 47 preview and physical-TV checks. Docker verifies legacy UI behavior, not Samsung APIs, AVPlay, certificates, or device playback.
