# Samsung Tizen TV setup, packaging, and deployment

This folder packages a prebuilt web app for Samsung Tizen TV.

- Actual Tizen package artifact: `Debug/tizen.wgt`
- Application ID: `M3uTvApp01.MyM3u`
- Package ID: `M3uTvApp01`
- Entry manifest: `config.xml`
- Web payload: `dist/`

The root-level `My M3U.wgt` file is not part of the normal workflow and has been removed. Use `Debug/tizen.wgt` as the package you install on the TV.

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

## Repeatable personal-TV deployment

For each app change:

1. At the repository root, run `npm run check` and `npm run build:tizen:personal`.
2. Open `tizen/` in VS Code and run **Build Project**.
3. Install the generated `tizen/Debug/tizen.wgt` using the extension or CLI below.
4. Open the app manually from the TV Apps screen.

The first connection/permit and certificate steps are one-time work unless the TV, Mac IP, certificate, or network changes.

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
"$SDB" shell 0 vd_applist | grep -A4 -B1 'M3uTvApp01.MyM3u'
```

### 2. Build the Tizen package

Run this in this folder:

```sh
"$TZ" pack --proj-dir="$PWD"
```

Expected output includes:

```text
Package File Location: .../Debug/tizen.wgt
```

### 3. Install on the TV

```sh
"$TZ" install --package-path="$PWD/Debug/tizen.wgt" --serial="$TV_SERIAL"
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
"$TZ" uninstall --package-id=M3uTvApp01.MyM3u --serial="$TV_SERIAL"
```

Expected output includes:

```text
app_id[M3uTvApp01.MyM3u] uninstall completed
cmd_ret:0
```

Using `M3uTvApp01` for uninstall does not work on this TV.

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

Run it after `npm run build:tizen:personal` (or `npm run build:tizen`). It refreshes the generated `tizen_web_project.yaml` asset list and produces the package at `Debug/tizen.wgt`.

### Deploy from VS Code

You have two practical options:

1. Use the integrated terminal and run the CLI install command from the previous section.
2. Use `Tizen TV WASM: Launch Application` after setting `Tizen TV WASM: Target Device Address` to the TV IP.

The second option installs the app, but on this TV the final remote launch step can still report failure even when the app is already installed. If that happens, launch the app manually from the TV.

### Uninstall from VS Code

Open the integrated terminal in this folder and run:

```sh
"$TZ" uninstall --package-id=M3uTvApp01.MyM3u --serial="$TV_SERIAL"
```

## Previously observed behavior on this TV

These are deployment notes from earlier UE75MU8005 testing, not a substitute for the smoke check in [the project verification guide](../docs/verification.md). Revalidate them after SDK, firmware, or app changes.

- Install works from the command line using `tz install`.
- Uninstall works from the command line using the application ID `M3uTvApp01.MyM3u`.
- The app launches correctly when started manually from the TV UI.
- Remote launch currently fails on this Samsung TV from both the older WASM extension path and direct CLI launch.
- The first catalogue import can take time because hundreds of thousands of VOD records are persisted to TV IndexedDB. The Tizen path batches 2,000 records, stages a new catalogue generation before promotion, and maintains indexed browse/search views; the import screen reports safe connection, reader, parser, and write progress. Record the last visible stage/counters if it stops.
- AVPlay external-subtitle paths are rejected by this TV firmware. The app instead renders parsed, timed SRT cues itself over the video surface. ASS/SSA positioning tags and inline HTML formatting tags are omitted from the visible subtitle text.
- In the player, Left/Right skip one minute, Up/Down move through on-screen controls, and the physical Play/Pause key toggles playback. The Aspect control cycles Auto, Fit, and Fill; Subtitle A−/A+ change overlay text size.
- The browser player renders downloaded SRT text as Blob/WebVTT tracks. The UE75MU8005 firmware rejects AVPlay's external-subtitle API, so the TV adapter parses the SRT locally and renders timed subtitle text over playback from AVPlay's play-time callback. No filesystem permissions are needed.
- `npm run dev:personal` must stay running during local subtitle testing because it provides the local OpenSubtitles proxy.
