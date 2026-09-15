# Samsung Tizen TV setup, packaging, and deployment

This folder packages a prebuilt web app for Samsung Tizen TV.

- Compatibility package artifacts: `Debug/tizen3.wgt` and `Debug/tizen6.wgt`
- Application ID: `Substream0.Substream`
- Package ID: `Substream0`
- Entry manifest: `config.xml`
- Web payload: `dist/`

The root-level `Substream.wgt` file is not part of the normal workflow and has been removed. Use `Debug/tizen3.wgt` for Tizen 3.0 / Chromium 47 TVs; it includes the legacy entry and static-color/flexbox UI baseline. Use `Debug/tizen6.wgt` for Tizen 6.0+ TVs.

## One-time setup

### Mac and VS Code

Install the Samsung **Visual Studio Code extension for Tizen** and its TV and certificate components. Open this `tizen/` directory in VS Code when using the extension's device and package actions; run npm commands from the repository root.

### Enable Developer Mode

1. Put the Mac and TV on the same normal LAN or Wi-Fi network. Guest networks and client isolation prevent deployment.
2. On the TV, open **Apps** and enter `12345` on the remote.
3. Enable **Developer mode**, enter the Mac's current LAN IP as **Host PC IP**, and fully restart the TV.
4. Find the TV IP in its network settings. The device address used below is `TV_IP:26101`.

If the Mac changes networks, update the Host PC IP and restart the TV again.

### Find the TV DUID

The Samsung certificate profile needs the unique device ID (DUID) of every TV that can install the personal development package. On the TV, open:

```text
Menu → Support → Contact Samsung → Unique Device ID
```

Treat the DUID as a private device identifier; do not commit or post it.

### Create the Samsung TV certificate profile

1. Open the Command Palette and run **Tizen TV: Run Certificate Manager**.
2. Create a new **Samsung** profile for **TV**.
3. Create an author certificate, sign in with a Samsung developer account, and choose a strong password.
4. Back up the author certificate (`.p12`) and password safely. All future app updates must use this same author certificate.
5. Create a public-level distributor certificate and add the TV DUID. When the TV is already connected, the `+` control can add its DUID automatically.
6. Finish the profile and make it active for packaging.

Keep the certificate backup, passwords, `device-profile.xml`, and DUID outside the repository.

### Connect and permit the TV

In the Tizen extension Device Manager, create a custom device for `TV_IP:26101`, connect it, and run **Permit to install applications** if the action is available.

Before you build or deploy, confirm that:

1. Enable Developer Mode on the TV.
2. Make sure the TV is reachable over the network on port `26101`.
3. Make sure a Samsung certificate profile is available and permitted on the TV.
4. Make sure `dist/` already contains the built web assets.

This folder does not contain the frontend build setup. If you change the web app, regenerate `dist/` before packing the Tizen app. Run the Tizen extension's **Build Project** action after regenerating assets so it refreshes `tizen_web_project.yaml` with the current hashed asset names.

## Personal development package

For personal TV development only, the root `.env` can be embedded into the installed package so the IPTV URL and OpenSubtitles API key do not need to be entered using the remote:

```sh
npm run build:tizen:personal
```

This is deliberately separate from `npm run build:tizen`; the normal build contains no injected configuration. The personal command requires both `IPTV_M3U_URL` and `OPENSUBTITLES_API_KEY` to be present in the ignored root `.env` file. `npm run dev:personal` starts a local browser server with the same defaults, while `npm run build:personal` creates the equivalent browser build in the root `dist/` folder.

| Command | Output | Injects `.env` values? |
| --- | --- | --- |
| `npm run dev` | Local Vite server | No |
| `npm run dev:personal` | Local Vite server | Yes |
| `npm run build` | `dist/` | No |
| `npm run build:personal` | `dist/` | Yes |
| `npm run build:tizen` | `tizen/dist/` | No |
| `npm run build:tizen:personal` | `tizen/dist/` | Yes |

An installed package can be extracted, so these values must be treated as exposed to anyone with access to the `.wgt` or TV app storage. Never distribute, upload, or commit that package. To stop embedding them later, use `npm run build:tizen`, rebuild/package/install, and uninstall the old app first if you also want to erase its locally saved settings.

## Build both compatibility packages

For a project-local setup, copy the root `.tizen-cli.local.example` file to `.tizen-cli.local` and set its `TIZEN_CLI` value to the Samsung Tizen CLI executable. The local file is ignored by Git. You can alternatively set `TIZEN_CLI` (or use the existing `TZ` variable from the CLI workflow below), then run this from the repository root:

```sh
npm run package:tizen
```

This signs and produces exactly these two files in `tizen/Debug/`:

- `tizen3.wgt` uses the legacy/SystemJS entry and the Tizen 3 static-color/flexbox UI baseline for Chromium 47.
- `tizen6.wgt` uses the SystemJS-compatible entry directly, avoiding Tizen 6's unreliable modern-module detection while retaining a Chromium 76 CSS target. This is the package for Tizen 6.0 / 2021 TVs such as the QE65Q70AATXXH.

For the local, credential-embedding workflow, use `npm run package:tizen:personal` instead. Both output packages contain the embedded values and must remain private.

### VS Code extension workflow (no Tizen CLI required)

When the VS Code Tizen extension already signs packages successfully, use this workflow instead of the CLI command above. It keeps the extension's existing certificate profile and creates the two compatibility packages without requiring Tizen Studio or a `tz` executable.

1. At the repository root, run `npm run prepare:tizen3:personal`.
2. In VS Code, run the same Tizen signed-package action you normally use. It creates `tizen/Debug/tizen.wgt`.
3. At the repository root, run `npm run collect:tizen3`. This renames the signed package to `tizen/Debug/tizen3.wgt`.
4. Repeat the same sequence with `tizen6`: `npm run prepare:tizen6:personal`, package in VS Code, then `npm run collect:tizen6`.

The prepare command records the intended variant in an ignored local marker. The collect command refuses to rename a package prepared for the other variant, which prevents accidentally labelling a Tizen 3 build as Tizen 6.

### Install and launch by IP

After packaging, the VS Code extension's `sdb` helper can install and launch either WGT without changing `tizentv.targetDeviceAddress` in VS Code settings:

```sh
npm run launch:tizen3 -- 192.168.1.50
npm run launch:tizen6 -- 192.168.1.50
```

The command connects to the supplied IP on port `26101`, replaces the existing Substream application, installs the selected package, and attempts to launch it. The TV must be in Developer Mode and already permitted for the extension's certificate profile. The first successful VS Code extension launch provisions its `sdb` helper at `~/tizentv-tools/sdb/sdb`; the command uses that helper automatically.

Some TVs, including the tested setup documented in this project, reject the final remote launch command even after a successful installation. The command reports that case as a successful install; open Substream from the TV Apps screen manually.

## Verified VS Code build and deployment

This is the primary workflow on this Mac. It does not require Tizen Studio or a `tz` executable: the VS Code extension signs the WGT, and its provisioned `sdb` helper deploys it by IP.

The first connection/permit and certificate steps are one-time work unless the TV, Mac IP, certificate, or network changes. For each app change:

1. Run `npm run check` from the repository root.
2. Run `npm run prepare:tizen6:personal` for a Tizen 6+ TV, or `npm run prepare:tizen3:personal` for a Tizen 3.0 / Chromium 47 TV.
3. In VS Code, open the `tizen/` folder and run the same Tizen signed-package action used for previous builds. It produces `tizen/Debug/tizen.wgt`.
4. Run the matching collect command: `npm run collect:tizen6` or `npm run collect:tizen3`.
5. Deploy the result directly by IP, for example: `npm run launch:tizen6 -- TV_IP`.
6. If the launcher reports that the remote execute command was rejected, open Substream manually from the TV Apps screen; installation has still completed.

`tizen6.wgt` is intentionally legacy-only at the JavaScript entry point. The Tizen 6 web runtime can claim module support yet leave the static splash visible if Vite's modern entry fails; using the same SystemJS-compatible entry path as the working Tizen 3 package avoids that failure mode.

## Fast provider catalogue

When the configured M3U URL is an Xtream-style `get.php` URL, the app first tries the provider's catalogue API. It loads movie and series categories only, then requests titles when a category is opened and episodes when a series is selected. This avoids importing the entire playlist before playback and should make the category screen available in seconds.

The M3U importer remains the fallback if the provider API is unavailable. If an older app installation already has a completed M3U catalogue, uninstall it before testing this new mode so the fresh app starts from the provider catalogue rather than the existing local database.

## CLI workflow

These commands use the SDK tools managed by the VS Code Tizen extension.

```sh
export TV_SERIAL="TV_IP:26101"
export SDK_TOOLS="/absolute/path/to/sdktools/data/tools"
export SDB="$SDK_TOOLS/sdb"
export TZ="$SDK_TOOLS/tizen-core/tz"
```

### 1. Connect to the TV

```sh
"$SDB" connect "$TV_SERIAL"
"$SDB" devices
```

Optional checks:

```sh
"$SDB" capability
"$SDB" shell 0 vd_applist | grep -A4 -B1 'Substream0.Substream'
```

### 2. Build the Tizen package

Run this in this folder:

```sh
"$TZ" pack --proj-dir="$PWD"
```

Expected output includes an intermediate package at:

```text
Package File Location: .../Debug/tizen.wgt
```

### 3. Install on the TV

```sh
"$TZ" install --package-path="$PWD/Debug/tizen6.wgt" --serial="$TV_SERIAL"
```

Expected output includes:

```text
install completed
cmd_ret:0
```

### 4. Launch on the TV

On this TV, remote launch from the CLI and the older Tizen TV WASM extension fails at the final step with `shell 0 execute ... closed`, even though install succeeds.

Use the TV remote to open the installed app manually after install completes.

### 5. Uninstall from the TV

Use the application ID, not the package ID:

```sh
"$TZ" uninstall --package-id=Substream0.Substream --serial="$TV_SERIAL"
```

Expected output includes:

```text
app_id[Substream0.Substream] uninstall completed
cmd_ret:0
```

Using `Substream0` for uninstall does not work on this TV.

## VS Code workflow

### Preferred setup

1. Install the `Visual Studio Code extension for Tizen`.
2. Open this folder in VS Code.
3. In the Tizen extension Device Manager, add or connect the TV at `TV_IP:26101`.
4. If needed, right-click the device and run `Permit to install applications`.

### Permit-to-install workaround

On this setup, the Device Manager did not always show the `Permit to install applications` action, but the TV still required that step before installs would succeed.

When that menu item is missing, the newer VS Code Tizen extension exposes the same action through its local API. This was the workaround that made installation succeed on this TV.

Example:

```sh
curl -X POST \
	'http://127.0.0.1:8001/api/v1/devices/TV_IP%3A26101/permit-to-install' \
	-H 'Content-Type: application/json' \
	-d '{"certificate_path":"/absolute/path/to/device-profile.xml"}'
```

Expected response:

```json
{"status":"success","message":"Permit to install succeeded"}
```

Notes:

1. Replace `TV_IP%3A26101` with your TV address, URL-encoded so `:` becomes `%3A`.
2. Replace the certificate path with the `device-profile.xml` file that matches the Samsung certificate profile used to sign the app.
3. If this step has not been completed, install attempts can fail even when the TV is connected and developer mode is enabled.

### Build in VS Code

Use the Tizen extension sidebar action `Build Project`.

For the two compatibility packages on this Mac, use the verified `prepare` and `collect` commands above. The CLI `package:tizen` commands remain available only when a separate Samsung `tz` executable is configured.

### Deploy from VS Code

Use the IP-based launcher instead of changing `Tizen TV WASM: Target Device Address` in VS Code settings:

```sh
npm run launch:tizen3 -- TV_IP
npm run launch:tizen6 -- TV_IP
```

It installs the chosen signed package and attempts to launch it. On this TV the final remote-launch step can still report failure even when the app is already installed; if that happens, launch the app manually from the TV.

### Uninstall from VS Code

Open the integrated terminal in this folder and run:

```sh
"$TZ" uninstall --package-id=Substream0.Substream --serial="$TV_SERIAL"
```

## Previously observed behavior on this TV

These are deployment notes from earlier UE75MU8005 testing, not a substitute for the smoke check in [the project verification guide](../docs/verification.md). Revalidate them after SDK, firmware, or app changes.

- Install works from the command line using `tz install`.
- Uninstall works from the command line using the application ID `Substream0.Substream`.
- The app launches correctly when started manually from the TV UI.
- Remote launch currently fails on this Samsung TV from both the older WASM extension path and direct CLI launch.
- The first catalogue import can take time because hundreds of thousands of VOD records are persisted to TV IndexedDB. The Tizen path batches 2,000 records, stages a new catalogue generation before promotion, and maintains indexed browse/search views; the import screen reports safe connection, reader, parser, and write progress. Record the last visible stage/counters if it stops.
- AVPlay external-subtitle paths are rejected by this TV firmware. The app instead renders parsed, timed SRT cues itself over the video surface. ASS/SSA positioning tags and inline HTML formatting tags are omitted from the visible subtitle text.
- In the player, Left/Right skip one minute, Up/Down move through on-screen controls, and the physical Play/Pause key toggles playback. The Aspect control cycles Auto, Fit, and Fill; Subtitle A−/A+ change overlay text size.
- The browser player renders downloaded SRT text as Blob/WebVTT tracks. The UE75MU8005 firmware rejects AVPlay's external-subtitle API, so the TV adapter parses the SRT locally and renders timed subtitle text over playback from AVPlay's play-time callback. No filesystem permissions are needed.
- `npm run dev:personal` must stay running during local subtitle testing because it provides the local OpenSubtitles proxy.
