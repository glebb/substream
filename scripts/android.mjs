import { chmodSync, cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const androidRoot = path.join(root, "android");
const webOutput = path.join(androidRoot, ".web-dist");
const assetsDir = path.join(androidRoot, "app", "src", "main", "assets");
const personalWebOutput = path.join(androidRoot, ".personal-web-dist");
const personalWorkspace = path.join(androidRoot, ".personal-workspace");
const personalPackage = path.join(androidRoot, "personal-packages", "app-personal-debug.apk");

export function createAndroidBuildEnvironment(environment = process.env, personal = false) {
  const clean = { ...environment };
  for (const name of Object.keys(clean)) {
    if (name.startsWith("VITE_")) delete clean[name];
  }
  delete clean.WEBOS_BUILD;
  delete clean.CHROMIUM47_PREVIEW;
  delete clean.TIZEN_COMPAT_TARGET;
  if (personal) {
    delete clean.PUBLIC_BUILD;
    clean.PERSONAL_BUILD = "1";
  } else {
    delete clean.PERSONAL_BUILD;
    clean.PUBLIC_BUILD = "1";
  }
  clean.ANDROID_BUILD = "1";
  return clean;
}

/** Android build tools and ADB do not receive the private Vite build inputs. */
export function createAndroidToolEnvironment(environment = process.env) {
  const allowed = ["PATH", "HOME", "TMPDIR", "JAVA_HOME", "ANDROID_HOME", "ANDROID_SDK_ROOT",
    "GRADLE_USER_HOME", "USER", "LOGNAME", "LANG", "LC_ALL"];
  return Object.fromEntries(allowed.filter((name) => environment[name] !== undefined)
    .map((name) => [name, environment[name]]));
}

function walkFiles(dir, relative = "") {
  return readdirSync(dir).flatMap((name) => {
    const file = path.join(dir, name);
    const rel = path.posix.join(relative, name);
    const info = statSync(file);
    return info.isDirectory() ? walkFiles(file, rel) : [rel];
  });
}

/** Validate generated Android web payload paths and synthetic credential sentinels. */
export function auditAndroidAssets(dir, sentinels = []) {
  const entries = walkFiles(dir);
  if (!entries.includes("index.html")) throw new Error("Android web payload is missing index.html");
  const privateEntries = entries.filter((entry) => entry.split("/").some((part) =>
    part === ".env" || part.startsWith(".env.") || part === ".local" || part.startsWith(".local.")));
  if (privateEntries.length) throw new Error("Android web payload contains private configuration files");
  for (const relative of entries) {
    const content = readFileSync(path.join(dir, relative));
    for (const sentinel of sentinels) {
      if (sentinel && content.includes(Buffer.from(sentinel))) {
        throw new Error("Android web payload contains a synthetic credential sentinel");
      }
    }
  }
  return entries;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root, env: createAndroidToolEnvironment(), encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
    timeout: 240_000, ...options,
  });
  if (result.error?.code === "ENOENT") return { ok: false, missing: true, status: null, stdout: "" };
  return { ok: result.status === 0, missing: false, status: result.status,
    timedOut: result.error?.code === "ETIMEDOUT", stdout: result.stdout ?? "" };
}

function buildWebAssets(personal = false) {
  if (!statSync(androidRoot, { throwIfNoEntry: false })?.isDirectory()
    || !statSync(path.join(androidRoot, "app"), { throwIfNoEntry: false })?.isDirectory()) {
    console.error("Android project is missing. See docs/mi-box-port-plan.md.");
    process.exitCode = 1;
    return false;
  }
  const vite = path.join(root, "node_modules", "vite", "bin", "vite.js");
  const output = personal ? personalWebOutput : webOutput;
  const result = run(process.execPath, [vite, "build", "--outDir", output], {
    env: createAndroidBuildEnvironment(process.env, personal), timeout: 240_000,
  });
  if (result.missing) {
    console.error("Vite is unavailable. Run npm install before building Android assets.");
    process.exitCode = 1;
    return false;
  }
  if (!result.ok) {
    console.error(result.timedOut ? "Android web build timed out." : `Android web build failed with exit code ${result.status ?? "unknown"}.`);
    process.exitCode = result.status || 1;
    return false;
  }
  try {
    auditAndroidAssets(output);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Android web payload audit failed.");
    process.exitCode = 1;
    return false;
  }
  if (personal) {
    console.log("Built PRIVATE personal Android WebView assets in an ignored staging directory.");
    return true;
  }
  rmSync(assetsDir, { recursive: true, force: true });
  mkdirSync(path.dirname(assetsDir), { recursive: true });
  cpSync(output, assetsDir, { recursive: true });
  console.log("Built clean Android WebView assets in android/app/src/main/assets/.");
  return true;
}

function packageApk(kind = "debug") {
  if (kind !== "debug" && kind !== "release") {
    console.error("Usage: npm run package:android [debug|release]");
    process.exitCode = 2;
    return;
  }
  if (!buildWebAssets()) return;
  const wrapper = path.join(androidRoot, process.platform === "win32" ? "gradlew.bat" : "gradlew");
  const gradle = statSync(wrapper, { throwIfNoEntry: false })?.isFile() ? wrapper : "gradle";
  const task = `:app:assemble${kind[0].toUpperCase()}${kind.slice(1)}`;
  const result = run(gradle, [task], { cwd: androidRoot, timeout: 600_000 });
  if (result.missing) {
    console.error("Gradle is unavailable. Install the Android SDK and Gradle, or add the project Gradle wrapper.");
    process.exitCode = 1;
    return;
  }
  if (!result.ok) {
    console.error(result.timedOut ? "Android APK build timed out." : `Android Gradle build failed with exit code ${result.status ?? "unknown"}.`);
    process.exitCode = result.status || 1;
    return;
  }
  const apkDir = path.join(androidRoot, "app", "build", "outputs", "apk", kind);
  const apks = readdirSync(apkDir, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith(".apk"));
  if (apks.length !== 1) {
    console.error("Gradle completed without producing exactly one Android APK.");
    process.exitCode = 1;
    return;
  }
  console.log(`Created ${path.relative(root, path.join(apkDir, apks[0].name))}.`);
  if (kind === "debug") console.log("This debug APK uses the Android debug signing key and is for development/sideload verification.");
  else console.log("Release signing depends on the signing configuration in the local Android environment.");
}

/** Build a private APK in a separate Gradle project so clean assets and outputs are untouched. */
export function stagePersonalAndroidProject(sourceRoot, outputRoot, personalAssets) {
  rmSync(outputRoot, { recursive: true, force: true });
  mkdirSync(outputRoot, { recursive: true });
  for (const relative of ["build.gradle.kts", "settings.gradle.kts", "gradle.properties", "gradlew", "gradlew.bat",
    "gradle/wrapper", "app/build.gradle.kts"]) {
    const source = path.join(sourceRoot, relative);
    const destination = path.join(outputRoot, relative);
    mkdirSync(path.dirname(destination), { recursive: true });
    cpSync(source, destination, { recursive: true });
  }
  const mainSource = path.join(sourceRoot, "app", "src", "main");
  const mainDestination = path.join(outputRoot, "app", "src", "main");
  cpSync(mainSource, mainDestination, { recursive: true, filter: (source) => {
    const relative = path.relative(mainSource, source);
    return relative !== "assets" && !relative.startsWith(`assets${path.sep}`)
      && !relative.split(path.sep).some((part) => part === ".env" || part.startsWith(".env.")
        || part === ".local" || part.startsWith(".local."));
  } });
  cpSync(personalAssets, path.join(mainDestination, "assets"), { recursive: true });
  chmodSync(path.join(outputRoot, "gradlew"), 0o755);
}

export function packagePersonalAndroidApk() {
  rmSync(personalPackage, { force: true });
  try {
    if (!buildWebAssets(true)) return undefined;
    stagePersonalAndroidProject(androidRoot, personalWorkspace, personalWebOutput);
    const wrapper = path.join(personalWorkspace, process.platform === "win32" ? "gradlew.bat" : "gradlew");
    const result = run(wrapper, [":app:assembleDebug"], { cwd: personalWorkspace, timeout: 600_000 });
    if (!result.ok) {
      console.error(result.timedOut ? "Private Android APK build timed out." : "Private Android APK build failed.");
      process.exitCode = result.status || 1;
      return undefined;
    }
    const apk = path.join(personalWorkspace, "app", "build", "outputs", "apk", "debug", "app-debug.apk");
    if (!statSync(apk, { throwIfNoEntry: false })?.isFile()) {
      console.error("Private Android build produced no debug APK.");
      process.exitCode = 1;
      return undefined;
    }
    mkdirSync(path.dirname(personalPackage), { recursive: true });
    cpSync(apk, personalPackage);
    chmodSync(personalPackage, 0o600);
    console.log("Created PRIVATE personal Android APK in android/personal-packages/.");
    return personalPackage;
  } finally {
    rmSync(personalWorkspace, { recursive: true, force: true });
    rmSync(personalWebOutput, { recursive: true, force: true });
  }
}

export function selectAndroidEmulator(adbDevicesOutput, requestedSerial) {
  if (requestedSerial !== undefined && !/^emulator-\d+$/.test(requestedSerial)) {
    throw new Error("Android deployment accepts only an emulator serial such as emulator-5554.");
  }
  const connected = adbDevicesOutput.split(/\r?\n/)
    .map((line) => /^\s*(emulator-\d+)\s+device(?:\s|$)/.exec(line)?.[1])
    .filter(Boolean);
  if (requestedSerial) {
    if (!connected.includes(requestedSerial)) throw new Error("The selected Android emulator is not connected and ready.");
    return requestedSerial;
  }
  if (connected.length !== 1) throw new Error(connected.length
    ? "More than one Android emulator is running; pass its emulator serial after android."
    : "Start the Android emulator before running npm run deploy android.");
  return connected[0];
}

/** Build the private package first; ADB receives only runtime variables, never .env values. */
export function deployPersonalAndroidEmulator(requestedSerial, steps = {}) {
  const runCommand = steps.runCommand ?? run;
  const packageApp = steps.packageApp ?? packagePersonalAndroidApk;
  const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
  const adbCandidate = sdk && path.join(sdk, "platform-tools", process.platform === "win32" ? "adb.exe" : "adb");
  const adb = adbCandidate && statSync(adbCandidate, { throwIfNoEntry: false })?.isFile() ? adbCandidate : "adb";
  const devices = runCommand(adb, ["devices"], { env: createAndroidToolEnvironment() });
  if (!devices.ok) {
    console.error("ADB is unavailable; start the Android emulator and check the Android SDK installation.");
    process.exitCode = 1;
    return false;
  }
  let serial;
  try { serial = selectAndroidEmulator(devices.stdout, requestedSerial); }
  catch (error) { console.error(error.message); process.exitCode = 2; return false; }
  const apk = packageApp();
  if (!apk) return false;
  const toolOptions = { env: createAndroidToolEnvironment(), timeout: 180_000 };
  if (!runCommand(adb, ["-s", serial, "install", "--no-streaming", "-r", apk], toolOptions).ok) {
    console.error("Android emulator installation failed.");
    process.exitCode = 1;
    return false;
  }
  if (!runCommand(adb, ["-s", serial, "shell", "am", "start", "-n", "org.substream.app/.MainActivity"], toolOptions).ok) {
    console.error("Android emulator launch failed.");
    process.exitCode = 1;
    return false;
  }
  console.log("Installed and launched PRIVATE personal Android build on the emulator.");
  return true;
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const [command = "package", ...args] = process.argv.slice(2);
  if (command === "assets") buildWebAssets();
  else if (command === "package") packageApk(args[0] ?? "debug");
  else if (command === "package-personal") packagePersonalAndroidApk();
  else if (command === "deploy-personal") deployPersonalAndroidEmulator(args[0]);
  else {
    console.error("Usage: node scripts/android.mjs [assets|package [debug|release]|package-personal|deploy-personal [emulator-serial]]");
    process.exitCode = 2;
  }
}
