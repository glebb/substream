import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { auditAndroidAssets, createAndroidBuildEnvironment, createAndroidToolEnvironment,
  deployPersonalAndroidEmulator, selectAndroidEmulator, stagePersonalAndroidProject } from "./android.mjs";

const dirs = [];
function tempDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "android-package-test-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

describe("Android packaging boundary", () => {
  it("forces public mode and strips Vite and incompatible platform overrides", () => {
    const env = createAndroidBuildEnvironment({
      PUBLIC_BUILD: "0", PERSONAL_BUILD: "1", VITE_IPTV_M3U_URL: "https://provider.example.test/?password=synthetic",
      CHROMIUM47_PREVIEW: "1", TIZEN_COMPAT_TARGET: "tizen6", PATH: "/synthetic/bin",
    });
    expect(env).toMatchObject({ PUBLIC_BUILD: "1", ANDROID_BUILD: "1", PATH: "/synthetic/bin" });
    expect(env).not.toHaveProperty("PERSONAL_BUILD");
    expect(env).not.toHaveProperty("VITE_IPTV_M3U_URL");
    expect(env).not.toHaveProperty("CHROMIUM47_PREVIEW");
    expect(env).not.toHaveProperty("TIZEN_COMPAT_TARGET");
  });

  it("audits synthetic WebView payloads and rejects credential sentinels and private files", () => {
    const clean = tempDir();
    writeFileSync(path.join(clean, "index.html"), "<html>synthetic safe fixture</html>");
    mkdirSync(path.join(clean, "assets"));
    writeFileSync(path.join(clean, "assets", "app.js"), "bundle fixture");
    expect(auditAndroidAssets(clean, ["synthetic-provider-password", "synthetic-api-token"])).toContain("index.html");

    writeFileSync(path.join(clean, "assets", "bad.js"), "synthetic-api-token");
    expect(() => auditAndroidAssets(clean, ["synthetic-api-token"])).toThrow(/synthetic credential sentinel/);
    rmSync(path.join(clean, "assets", "bad.js"));
    mkdirSync(path.join(clean, ".local"));
    writeFileSync(path.join(clean, ".local", "deployment"), "fixture");
    expect(() => auditAndroidAssets(clean)).toThrow(/private configuration files/);
  });

  it("keeps explicit personal defaults in Vite only and removes credentials from tool processes", () => {
    const input = {
      PATH: "/synthetic/bin", HOME: "/synthetic/home", PUBLIC_BUILD: "1", WEBOS_BUILD: "1",
      VITE_TOKEN: "synthetic-vite-secret", IPTV_M3U_URL: "https://provider.example.test/?password=synthetic-password",
      OPENSUBTITLES_API_KEY: "synthetic-os-key", TMDB_API_KEY: "synthetic-tmdb-key",
    };
    const vite = createAndroidBuildEnvironment(input, true);
    expect(vite).toMatchObject({ PERSONAL_BUILD: "1", ANDROID_BUILD: "1", IPTV_M3U_URL: input.IPTV_M3U_URL });
    for (const name of ["PUBLIC_BUILD", "WEBOS_BUILD", "VITE_TOKEN"]) expect(vite).not.toHaveProperty(name);
    expect(createAndroidToolEnvironment(input)).toEqual({ PATH: input.PATH, HOME: input.HOME });
  });

  it("stages only personal web assets in a separate Android project", () => {
    const dir = tempDir();
    const source = path.join(dir, "source");
    const target = path.join(dir, "target");
    const personalAssets = path.join(dir, "personal-assets");
    for (const name of ["build.gradle.kts", "settings.gradle.kts", "gradle.properties", "gradlew", "gradlew.bat",
      "gradle/wrapper/gradle-wrapper.jar", "app/build.gradle.kts", "app/src/main/AndroidManifest.xml",
      "app/src/main/assets/index.html", "app/src/main/java/MainActivity.kt", "app/src/main/.env"]) {
      const file = path.join(source, name);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, name.includes("assets/") ? "synthetic-public-asset" : "synthetic fixture");
    }
    mkdirSync(personalAssets);
    writeFileSync(path.join(personalAssets, "index.html"), "synthetic-personal-asset");
    stagePersonalAndroidProject(source, target, personalAssets);
    expect(readFileSync(path.join(target, "app/src/main/assets/index.html"), "utf8")).toBe("synthetic-personal-asset");
    expect(existsSync(path.join(target, "app/src/main/.env"))).toBe(false);
    expect(readFileSync(path.join(source, "app/src/main/assets/index.html"), "utf8")).toBe("synthetic-public-asset");
  });

  it("installs a private APK only on a selected running emulator using an allowlisted environment", () => {
    const output = "List of devices attached\nemulator-5554\tdevice\nphysical-example\tdevice\n";
    expect(selectAndroidEmulator(output)).toBe("emulator-5554");
    expect(() => selectAndroidEmulator(output, "physical-example")).toThrow(/emulator serial/);
    expect(() => selectAndroidEmulator("List of devices attached\n")).toThrow(/Start the Android emulator/);
    const calls = [];
    const runCommand = vi.fn((command, args, options) => {
      calls.push({ command, args, options });
      return { ok: true, stdout: args[0] === "devices" ? output : "" };
    });
    const packageApp = vi.fn(() => "/synthetic/private.apk");
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(deployPersonalAndroidEmulator(undefined, { runCommand, packageApp })).toBe(true);
    expect(packageApp).toHaveBeenCalledOnce();
    expect(calls.map(({ args }) => args)).toEqual([
      ["devices"],
      ["-s", "emulator-5554", "install", "--no-streaming", "-r", "/synthetic/private.apk"],
      ["-s", "emulator-5554", "shell", "am", "start", "-n", "org.substream.app/.MainActivity"],
    ]);
    for (const { options } of calls) {
      expect(options.env).not.toHaveProperty("IPTV_M3U_URL");
      expect(options.env).not.toHaveProperty("OPENSUBTITLES_API_KEY");
    }
  });
});
