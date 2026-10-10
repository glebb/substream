# LG webOS TV packaging

The LG build is a local web app package targeting the webOS 25 Chromium 120
engine. Its Vite output uses relative asset paths and includes the application
files locally. It is separate from the browser and Samsung Tizen builds.

Install the current official [webOS CLI](https://webostv.developer.lge.com/develop/tools/cli-installation)
(LG's documented npm package is `@webos-tools/cli`) and add its `ares-*`
commands to `PATH`. Enable the Developer Mode app on the
TV, configure a named device with `ares-setup-device`, and obtain its key using
the official CLI. Keep device names, addresses, keys, and CLI configuration in
local ignored deployment files; do not add them to this repository.

For one-command personal deployment, run `npm run deploy <configured-device-name>`.
It builds and audits the personal `.ipk`, closes the existing app if running,
installs the package and launches it. Build or installation failures stop the
deployment before the next step. CLI output is suppressed to protect connection
details.

Set `LG_WEBOS_DEVICE` in ignored `.env` to use `npm run deploy` without an argument.
Keep any LG-specific secret values in `.env`; the registered CLI's SSH keys stay
in its external key store, outside this repository. LG deployment settings are
not compiled into the app. The generic command also supports `npm run deploy
tizen3` and `npm run deploy tizen6` through the existing Samsung signing flow.

Run these commands from the project root:

```sh
npm run build:webos
npm run package:webos
npm run build:webos:personal
npm run package:webos:personal
npm run install:webos -- --device <configured-device-name> webos/packages/<generated-file>.ipk
npm run launch:webos -- --device <configured-device-name>
```

`build:webos` can run without the LG CLI. It writes the staged application to
`webos/dist/`. `package:webos` invokes `ares-package` and writes the `.ipk` to
`webos/packages/`; it reports a clear error if the CLI is unavailable or does
not produce a package. Install and launch use the named device already
configured in the local CLI. Their output is suppressed to avoid printing
device addresses or other local connection details.

The build clears personal defaults and preview-proxy settings and does not
read `.env`. Provider, OpenSubtitles, and TMDb credentials remain on the TV and
requests go directly from the app to their intended services. The package does
not include a credential proxy or local endpoint defaults.

The explicit personal commands read the project's existing `.env` values and
embed the same playlist, OpenSubtitles, TMDb, and companion defaults as the
Tizen personal build. They write to `webos/personal-dist/` and
`webos/personal-packages/`, separate from the clean output. Treat that IPK as a
private artifact: it contains the configured defaults and must not be shared
or published. Personal mode does not enable the Samsung live subtitle relay;
the webOS runtime only uses integrations supported by its adapters. Personal,
public, Chromium 47 preview-proxy, and Tizen compatibility modes cannot be
combined.

Developer Mode access is time-limited. LG documents that expiry disables
Developer Mode and removes developer-installed apps; renew the session through
the Developer Mode app/official tooling and reinstall the package if needed.
An `.ipk` build is a development artifact, not an LG Content Store submission.

References: [appinfo.json](https://webostv.developer.lge.com/develop/references/appinfo-json),
[CLI guide](https://webostv.developer.lge.com/develop/tools/cli-dev-guide),
[Developer Mode](https://webostv.developer.lge.com/develop/getting-started/developer-mode-app).

## Validation

The initial port was installed and inspected on a physical webOS 25 TV.
The personal build supplied playlist defaults, loaded provider live categories
directly, and played 1080p video with picture and sound confirmed by the user.
VOD seeking/resume, audio/subtitle switching, broader codec coverage, Magic
Remote behavior and standby recovery still require physical-device acceptance.
Samsung relay and companion integrations remain disabled for this initial port.
