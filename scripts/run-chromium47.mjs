import { spawn, spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const statePath = join(tmpdir(), "substream-chromium47.json");
const baseImage = "local/chromium47:352221";
const image = "local/substream-chromium47:352221";
const containerName = "substream-chromium47-browser";
const viewerUrl = "http://localhost:6080/vnc.html?autoconnect=1&resize=scale";
const action = process.argv[2] ?? "start";

function docker(args, options = {}) {
  return spawnSync("docker", args, { cwd: root, encoding: "utf8", ...options });
}

async function waitFor(url, label) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
  throw new Error(`${label} did not become available`);
}

function readState() {
  if (!existsSync(statePath)) return undefined;
  return JSON.parse(readFileSync(statePath, "utf8"));
}

function stop() {
  const state = readState();
  const existing = docker(["rm", "--force", containerName], { stdio: "ignore" });
  if (state?.buildDir) rmSync(state.buildDir, { recursive: true, force: true });
  rmSync(statePath, { force: true });
  if (existing.error) throw existing.error;
  console.log("Stopped the Chromium 47 preview and removed its temporary build.");
}

if (action === "stop") {
  stop();
} else if (action === "status") {
  const state = readState();
  if (!state) {
    console.log("Chromium 47 preview is not running.");
  } else {
    console.log(`Chromium 47 preview: ${viewerUrl}`);
  }
} else if (action === "start") {
  const personalBuild = process.env.PERSONAL_BUILD === "1";
  const existingState = readState();
  if (existingState) {
    if (Boolean(existingState.personal) !== personalBuild) {
      console.error(`A ${existingState.personal ? "personal" : "standard"} preview is already running. Stop it before switching build modes.`);
      process.exitCode = 1;
    } else {
      console.log(`Chromium 47 preview is already running: ${viewerUrl}`);
    }
    process.exit();
  }

  let state;
  try {
    const baseImageExists = docker(["image", "inspect", baseImage], { stdio: "ignore" }).status === 0;
    if (!baseImageExists) {
      execFileSync("docker", ["build", "--platform", "linux/amd64", "-f", "docker/chromium47/Base.Dockerfile", "-t", baseImage, "docker/chromium47"], { cwd: root, stdio: "inherit" });
    }

    execFileSync("docker", ["build", "--platform", "linux/amd64", "-f", "docker/chromium47/Dockerfile", "-t", image, "docker/chromium47"], { cwd: root, stdio: "inherit" });

    const buildDir = mkdtempSync(join("/private/tmp", "substream-chromium47-"));
    state = { buildDir, personal: personalBuild };
    execFileSync("npm", ["run", "build:tizen", "--", "--outDir", buildDir, "--emptyOutDir"], {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, CHROMIUM47_PREVIEW: "1" },
    });
    writeFileSync(statePath, JSON.stringify(state));
    const dockerArgs = [
      "run", "--detach", "--name", containerName,
      "--platform", "linux/amd64",
      "--publish", "127.0.0.1:6080:6080",
      "--volume", `${buildDir}:/app:ro`,
    ];
    if (personalBuild && process.env.IPTV_M3U_URL) {
      dockerArgs.push("--env", `PREVIEW_PROVIDER_HOST=${new URL(process.env.IPTV_M3U_URL).hostname}`);
    }
    dockerArgs.push(
      image,
    );
    const started = docker(dockerArgs);
    if (started.status !== 0) {
      const detail = String(started.stderr || "").replaceAll(process.env.IPTV_M3U_URL ? new URL(process.env.IPTV_M3U_URL).hostname : "\u0000", "[provider host]").trim();
      throw new Error(`Chromium 47 container could not start${detail ? `: ${detail}` : "."}`);
    }

    await waitFor(viewerUrl, "Chromium 47 viewer");
    const opener = spawn("open", [viewerUrl], { stdio: "ignore", detached: true });
    opener.unref();
    console.log(`Chromium 47 is running. The browser window should open at ${viewerUrl}`);
    console.log(personalBuild
      ? "This personal build embeds the supported playlist, OpenSubtitles, and TMDb values from .env."
      : "Enter a playlist in the app if you want to load your library. This build does not embed .env credentials.");
    console.log("Stop it with: npm run preview:chromium47 -- stop");
  } catch (error) {
    if (state) {
      docker(["rm", "--force", containerName], { stdio: "ignore" });
      rmSync(state.buildDir, { recursive: true, force: true });
      rmSync(statePath, { force: true });
    }
    throw error;
  }
} else {
  console.error("Usage: npm run preview:chromium47 [start|status|stop]");
  process.exitCode = 2;
}
