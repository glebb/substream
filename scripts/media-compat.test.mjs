import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { access, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createSourceProxy, fetchMediaSource, hlsOutputArguments, mediaPlan, prepareMedia, runJson, validMediaSource } from "./media-compat.mjs";

const ffmpegPath = process.env.FFMPEG_PATH || "ffmpeg";
const ffprobePath = process.env.FFPROBE_PATH || "ffprobe";
const ffmpegAvailable = spawnSync(ffmpegPath, ["-version"], { stdio: "ignore" }).status === 0;
const ffprobeAvailable = spawnSync(ffprobePath, ["-version"], { stdio: "ignore" }).status === 0;

function runCommand(binary, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["ignore", "ignore", "pipe"] });
    let errorText = "";
    child.stderr.on("data", (chunk) => { errorText += chunk; });
    child.once("error", () => reject(new Error("Synthetic media command was unavailable.")));
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`Synthetic media command failed (${String(code)}): ${errorText.slice(-300)}`)));
  });
}

function countDecodedVideoFrames(input) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffprobePath, ["-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries", "stream=nb_read_frames", "-of", "default=nokey=1:noprint_wrappers=1", input], { stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.once("error", () => reject(new Error("Synthetic frame probe was unavailable.")));
    child.once("close", (code) => {
      const counts = output.trim().split(/\s+/).map(Number);
      const frames = counts.reduce((sum, count) => sum + count, 0);
      if (code === 0 && counts.length > 0 && counts.every(Number.isFinite)) resolve(frames);
      else reject(new Error(`Synthetic frame probe returned ${output.trim() || "no frame count"}.`));
    });
  });
}

function probeStreamTypes(input) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffprobePath, ["-v", "error", "-count_packets", "-show_entries", "stream=codec_type,codec_name,nb_read_packets", "-of", "json", input], { stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.once("error", () => reject(new Error("Synthetic stream probe was unavailable.")));
    child.once("close", (code) => {
      if (code !== 0) return reject(new Error("Synthetic stream probe failed."));
      try { resolve(JSON.parse(output).streams); } catch { reject(new Error("Synthetic stream probe returned invalid data.")); }
    });
  });
}

function syntheticProxyHarness() {
  let handler;
  const server = {
    once: vi.fn(),
    listen: vi.fn((_port, _host, callback) => callback()),
    address: () => ({ port: 12345 }),
    close: (callback) => callback(),
    closeAllConnections: vi.fn(),
  };
  const serverFactory = vi.fn((requestHandler) => { handler = requestHandler; return server; });
  const issueRequest = (url) => {
    let finish;
    const finished = new Promise((resolve) => { finish = resolve; });
    const response = new EventEmitter();
    Object.assign(response, {
      destroyed: false,
      headersSent: false,
      chunks: [],
      writeHead(status, headers) { this.statusCode = status; this.headers = headers; this.headersSent = true; },
      write(chunk) { this.chunks.push(Buffer.from(chunk)); return true; },
      end() { this.ended = true; finish(); this.emit("close"); },
      destroy() { this.destroyed = true; finish(); this.emit("close"); },
    });
    void handler({ url: new URL(url).pathname, method: "GET", headers: {} }, response);
    return { response, finished };
  };
  return { serverFactory, issueRequest };
}

const syntheticProbe = (audioCodec) => ({
  format: { duration: "3600.25" },
  streams: [
    { index: 0, codec_type: "video", codec_name: "h264" },
    { index: 1, codec_type: "audio", codec_name: audioCodec },
  ],
});

describe("browser media compatibility planning", () => {
  it("converts E-AC-3 only when the browser reports no support and keeps H.264 copyable", () => {
    expect(mediaPlan(syntheticProbe("eac3"), { supportsEac3: false })).toMatchObject({
      videoCodec: "h264", audioCodec: "eac3", convertAudio: true, audioIndex: 1, duration: 3600.25,
    });
    expect(mediaPlan(syntheticProbe("eac3"), { supportsEac3: true }).convertAudio).toBe(false);
  });

  it("converts AC-3 only when the browser reports no support", () => {
    expect(mediaPlan(syntheticProbe("ac3"), { supportsAc3: false }).convertAudio).toBe(true);
    expect(mediaPlan(syntheticProbe("ac3"), { supportsAc3: true }).convertAudio).toBe(false);
  });

  it.skipIf(!ffmpegAvailable || !ffprobeAvailable)("starts HLS segments at one second while copying video and downmixing converted audio", async () => {
    const directory = await mkdtemp(join(tmpdir(), "substream-fast-hls-test-"));
    const input = join(directory, "synthetic.mkv");
    const playlist = join(directory, "index.m3u8");
    const pattern = join(directory, "segment%05d.ts");
    try {
      await runCommand(ffmpegPath, [
        "-nostdin", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", "testsrc=size=320x180:rate=24:duration=20",
        "-itsoffset", "0.25", "-f", "lavfi", "-i", "anullsrc=channel_layout=5.1:sample_rate=48000:duration=20",
        "-c:v", "libx264", "-g", "24", "-c:a", "eac3", "-ac", "6", input,
      ]);
      const plan = mediaPlan({ streams: [
        { index: 0, codec_type: "video", codec_name: "h264" },
        { index: 1, codec_type: "audio", codec_name: "eac3" },
      ] });
      const args = ["-nostdin", "-hide_banner", "-loglevel", "error", "-i", input, ...hlsOutputArguments(pattern, playlist, plan)];
      expect(args.slice(args.indexOf("-c:v"), args.indexOf("-c:v") + 2)).toEqual(["-c:v", "copy"]);
      expect(args.slice(args.indexOf("-ac"), args.indexOf("-ac") + 2)).toEqual(["-ac", "2"]);
      expect(args).not.toContain("-af");
      expect(args[args.indexOf("-hls_time") + 1]).toBe("1");
      expect(args[args.indexOf("-fs") + 1]).toBe(String(2 * 1024 * 1024 * 1024));
      await runCommand(ffmpegPath, args);

      const manifest = await readFile(playlist, "utf8");
      const firstDuration = Number(manifest.match(/#EXTINF:([0-9.]+)/)?.[1]);
      expect(firstDuration).toBeLessThanOrEqual(1.2);
      expect(manifest).not.toContain("#EXT-X-INDEPENDENT-SEGMENTS");
      const probe = await new Promise((resolve, reject) => {
        const child = spawn(ffprobePath, ["-v", "error", "-show_entries", "stream=codec_type,codec_name,channels", "-of", "json", join(directory, "segment00000.ts")], { stdio: ["ignore", "pipe", "ignore"] });
        let output = "";
        child.stdout.on("data", (chunk) => { output += chunk; });
        child.once("error", () => reject(new Error("Synthetic segment probe was unavailable.")));
        child.once("close", (code) => {
          if (code !== 0) return reject(new Error("Synthetic segment probe failed."));
          try { resolve(JSON.parse(output)); } catch { reject(new Error("Synthetic segment probe returned invalid data.")); }
        });
      });
      expect(probe.streams).toContainEqual(expect.objectContaining({ codec_type: "video", codec_name: "h264" }));
      expect(probe.streams).toContainEqual(expect.objectContaining({ codec_type: "audio", codec_name: "aac", channels: 2 }));
      await runCommand(ffmpegPath, ["-nostdin", "-hide_banner", "-loglevel", "error", "-i", playlist, "-f", "null", "-"]);

      // Input-seeking resume jobs must keep both tracks in every early segment,
      // even when the source audio starts slightly later than video.
      for (const startSeconds of [0.1, 1.3, 5.5, 6.658, 12.3, 17.5]) {
        const resumeDirectory = join(directory, `resume-${String(startSeconds).replace(".", "-")}`);
        await import("node:fs/promises").then(({ mkdir }) => mkdir(resumeDirectory));
        const resumePlaylist = join(resumeDirectory, "index.m3u8");
        const resumePattern = join(resumeDirectory, "segment%05d.ts");
        const resumeArgs = [
          "-nostdin", "-hide_banner", "-loglevel", "error", "-ss", startSeconds.toFixed(3), "-i", input,
          ...hlsOutputArguments(resumePattern, resumePlaylist, plan, startSeconds),
        ];
        expect(resumeArgs.slice(resumeArgs.indexOf("-af"), resumeArgs.indexOf("-af") + 2)).toEqual(["-af", "aresample=async=1:first_pts=0"]);
        await runCommand(ffmpegPath, resumeArgs);
        const resumeManifest = await readFile(resumePlaylist, "utf8");
        const firstDuration = Number(resumeManifest.match(/#EXTINF:([0-9.]+)/)?.[1]);
        expect(firstDuration).toBeGreaterThanOrEqual(1.8);
        expect(firstDuration).toBeLessThanOrEqual(2.2);
        const segmentFiles = (await import("node:fs/promises").then(({ readdir }) => readdir(resumeDirectory)))
          .filter((name) => /^segment\d{5}\.ts$/.test(name));
        expect(segmentFiles.length).toBeGreaterThan(1);
        for (const filename of segmentFiles.slice(0, 3)) {
          const streams = await probeStreamTypes(join(resumeDirectory, filename));
          expect(streams).toEqual(expect.arrayContaining([
            expect.objectContaining({ codec_type: "video", codec_name: "h264" }),
            expect.objectContaining({ codec_type: "audio", codec_name: "aac" }),
          ]));
          expect(Number(streams.find(({ codec_type }) => codec_type === "video")?.nb_read_packets)).toBeGreaterThan(0);
          expect(Number(streams.find(({ codec_type }) => codec_type === "audio")?.nb_read_packets)).toBeGreaterThan(0);
        }
        expect(await countDecodedVideoFrames(resumePlaylist)).toBeGreaterThan(0);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 15_000);

  it("preserves supported audio codecs without conversion", () => {
    for (const codec of ["aac", "mp3", "opus", "dts", "truehd"]) {
      expect(mediaPlan(syntheticProbe(codec), { supportsEac3: false }).convertAudio).toBe(false);
    }
  });

  it("returns direct playback for a supported audio codec without starting FFmpeg", async () => {
    const closeProxy = vi.fn(async () => undefined);
    const spawnProcess = vi.fn();
    const result = await prepareMedia("https://media.example.invalid/video.mkv", {
      probeResult: syntheticProbe("aac"),
      sourceProxyFactory: async () => ({ url: "http://127.0.0.1:9999/opaque", close: closeProxy }),
      spawnProcess,
    });

    expect(result).toMatchObject({ direct: true, plan: { convertAudio: false } });
    expect(spawnProcess).not.toHaveBeenCalled();
    expect(closeProxy).toHaveBeenCalledOnce();
  });

  it("retries resumed HLS setup with longer first segments until audio packets are present", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "substream-adaptive-segment-test-"));
    const closeProxy = vi.fn(async () => undefined);
    const segmentChecks = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const children = [];
    const result = await prepareMedia("https://media.example.invalid/video.mkv", {
      supportsH264: true,
      startSeconds: 15.292,
      probeResult: syntheticProbe("eac3"),
      sourceProxyFactory: async () => ({ url: "http://127.0.0.1:9999/opaque", close: closeProxy }),
      segmentHasPlayableTracks: segmentChecks,
      tempRoot,
      spawnProcess: (_binary, args) => {
        const child = new EventEmitter();
        child.exitCode = null;
        child.signalCode = null;
        child.kill = vi.fn(() => {
          child.signalCode = "SIGTERM";
          child.emit("close", null, "SIGTERM");
          return true;
        });
        children.push({ child, args });
        const playlist = args.at(-1);
        const segmentPattern = args[args.indexOf("-hls_segment_filename") + 1];
        const firstSegment = segmentPattern.replace("%05d", "00000");
        mkdirSync(dirname(playlist), { recursive: true });
        writeFileSync(playlist, "#EXTM3U\n#EXTINF:2,\nsegment00000.ts\n");
        writeFileSync(firstSegment, "synthetic segment");
        return child;
      },
    });

    expect(children).toHaveLength(2);
    expect(children.map(({ args }) => args[args.indexOf("-hls_time") + 1])).toEqual(["2", "4"]);
    expect(segmentChecks).toHaveBeenCalledTimes(2);
    await result.cleanup();
    expect(children.every(({ child }) => child.kill.mock.calls.length === 1)).toBe(true);
    expect(closeProxy).toHaveBeenCalledOnce();
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("waits for FFmpeg close before removing segments and makes cleanup idempotent", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "substream-cleanup-test-"));
    const closeProxy = vi.fn(async () => undefined);
    const child = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    child.kill = vi.fn(() => {
      setTimeout(() => { child.signalCode = "SIGTERM"; child.emit("close", null, "SIGTERM"); }, 30);
      return true;
    });
    const result = await prepareMedia("https://media.example.invalid/video.mkv", {
      supportsH264: true,
      probeResult: syntheticProbe("eac3"),
      sourceProxyFactory: async () => ({ url: "http://127.0.0.1:9999/opaque", close: closeProxy }),
      segmentHasPlayableTracks: async () => true,
      tempRoot,
      spawnProcess: (_binary, args) => {
        const playlist = args.at(-1);
        const segmentPattern = args[args.indexOf("-hls_segment_filename") + 1];
        const firstSegment = segmentPattern.replace("%05d", "00000");
        mkdirSync(dirname(playlist), { recursive: true });
        writeFileSync(playlist, "#EXTM3U\n#EXTINF:4,\nsegment00000.ts\n");
        writeFileSync(firstSegment, "synthetic segment");
        return child;
      },
    });

    const firstCleanup = result.cleanup();
    const secondCleanup = result.cleanup();
    expect(secondCleanup).toBe(firstCleanup);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await stat(result.directory)).toBeDefined();
    await firstCleanup;

    await expect(access(result.directory)).rejects.toThrow();
    expect(child.kill).toHaveBeenCalledOnce();
    expect(closeProxy).toHaveBeenCalledOnce();
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("stops and removes a media job when its bounded duration expires", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "substream-duration-test-"));
    const closeProxy = vi.fn(async () => undefined);
    const child = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    child.kill = vi.fn(() => {
      setTimeout(() => { child.signalCode = "SIGTERM"; child.emit("close", null, "SIGTERM"); }, 0);
      return true;
    });
    const result = await prepareMedia("https://media.example.invalid/video.mkv", {
      maxDurationMs: 25,
      supportsH264: true,
      probeResult: syntheticProbe("eac3"),
      sourceProxyFactory: async () => ({ url: "http://127.0.0.1:9999/opaque", close: closeProxy }),
      segmentHasPlayableTracks: async () => true,
      tempRoot,
      spawnProcess: (_binary, args) => {
        const playlist = args.at(-1);
        const segmentPattern = args[args.indexOf("-hls_segment_filename") + 1];
        mkdirSync(dirname(playlist), { recursive: true });
        writeFileSync(playlist, "#EXTM3U\n#EXTINF:4,\nsegment00000.ts\n");
        writeFileSync(segmentPattern.replace("%05d", "00000"), "synthetic segment");
        return child;
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 80));
    await expect(access(result.directory)).rejects.toThrow();
    expect(child.kill).toHaveBeenCalledOnce();
    expect(closeProxy).toHaveBeenCalledOnce();
    await result.cleanup();
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("waits for a failed startup child's close before cleaning its directory and preserves the original error", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "substream-startup-cleanup-test-"));
    const closeProxy = vi.fn(async () => undefined);
    const child = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    child.kill = vi.fn(() => true);
    const prepare = prepareMedia("https://media.example.invalid/video.mkv", {
      supportsH264: true,
      probeResult: syntheticProbe("eac3"),
      sourceProxyFactory: async () => ({ url: "http://127.0.0.1:9999/opaque", close: closeProxy }),
      tempRoot,
      spawnProcess: () => {
        setTimeout(() => { child.exitCode = 1; child.emit("exit", 1, null); }, 5);
        setTimeout(() => child.emit("close", 1, null), 150);
        return child;
      },
    });

    await expect(prepare).rejects.toThrow("Media conversion failed.");
    expect(closeProxy).toHaveBeenCalledOnce();
    expect(await readdir(tempRoot)).toEqual([]);
    await rm(tempRoot, { recursive: true, force: true });
  });

  it.each([
    "0.1.2.3", "10.20.30.40", "100.64.0.1", "100.127.255.254", "127.0.0.1",
    "169.254.1.2", "172.16.0.1", "172.31.255.254", "192.0.0.1", "192.0.2.1",
    "192.88.99.1", "192.168.1.20", "198.18.0.1", "198.19.255.254", "198.51.100.1",
    "203.0.113.1", "224.0.0.1", "239.255.255.255", "240.0.0.1", "255.255.255.255",
    "::", "::1", "::192.0.2.1", "::ffff:10.0.0.1", "::ffff:7f00:1", "fc00::1",
    "fd12:3456::1", "fe80::1", "ff02::1", "100::1", "2001::1", "2001:2::1",
    "2001:db8::1", "2002::1", "3fff::1", "5f00::1", "64:ff9b::a00:1", "64:ff9b:1::1",
  ])("rejects non-global literal media origin %s", (address) => {
    const host = address.includes(":") ? `[${address}]` : address;
    expect(validMediaSource(`http://${host}/video.mkv`)).toBe(false);
  });

  it.each(["8.8.8.8", "93.184.216.34", "216.239.32.10", "2001:4860:4860::8888"])(
    "allows global unicast literal media origin %s", (address) => {
      const host = address.includes(":") ? `[${address}]` : address;
      expect(validMediaSource(`https://${host}/video.mkv`)).toBe(true);
    },
  );

  it("rejects non-HTTP and credentialed media sources", () => {
    expect(validMediaSource("https://media.example.invalid/video.mkv?token=test")).toBe(true);
    expect(validMediaSource("file:///etc/passwd")).toBe(false);
    expect(validMediaSource("http://user:pass@media.example.invalid/video.mkv")).toBe(false);
  });

  it.each([
    "10.0.0.7", "100.64.0.2", "127.0.0.1", "169.254.0.4", "172.20.1.1", "192.0.2.5",
    "192.168.1.9", "198.18.0.4", "203.0.113.7", "224.0.0.1", "240.0.0.1", "::1",
    "fc00::1", "fe80::1", "ff02::1", "2001:db8::7", "3fff::7", "::ffff:192.168.1.9",
  ])("rejects a non-public DNS answer (%s) before attempting an upstream connection", async (address) => {
    const request = vi.fn();
    await expect(fetchMediaSource("http://media.example.invalid/video.mkv", {
      resolveHost: async () => [{ address, family: address.includes(":") ? 6 : 4 }],
      request,
    })).rejects.toThrow("Media source is not allowed.");
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    ["93.184.216.34", 4],
    ["2001:4860:4860::8888", 6],
  ])("allows a public DNS answer (%s) and uses the injected request", async (address, family) => {
    const request = vi.fn(async () => new Response("synthetic media", { status: 200 }));
    const response = await fetchMediaSource("http://media.example.invalid/video.mkv", {
      resolveHost: async () => [{ address, family }],
      request,
    });
    expect(response.status).toBe(200);
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0][2]).toEqual({ address, family });
  });

  it("pins the first validated address and resolves redirects independently", async () => {
    const resolveHost = vi.fn(async (hostname) => hostname === "media.example.invalid"
      ? [{ address: "93.184.216.34", family: 4 }]
      : [{ address: "192.168.1.9", family: 4 }]);
    const request = vi.fn(async (_url, _headers, address) => {
      expect(address).toEqual({ address: "93.184.216.34", family: 4 });
      return new Response(null, { status: 302, headers: { location: "http://redirect.example.invalid/video.mkv" } });
    });
    await expect(fetchMediaSource("http://media.example.invalid/video.mkv", { resolveHost, request }))
      .rejects.toThrow("Media source is not allowed.");
    expect(resolveHost.mock.calls.map(([hostname]) => hostname)).toEqual([
      "media.example.invalid", "redirect.example.invalid",
    ]);
    expect(request).toHaveBeenCalledOnce();
  });

  it.each(["movie.mkv", "episode.mkv", "movie.mp4", "live.ts"])("identifies the player on %s range requests and redirects for providers that reject missing User-Agent", async (filename) => {
    const request = vi.fn(async (_url, headers) => {
      if (!headers?.["user-agent"]) return new Response(null, { status: 454 });
      return request.mock.calls.length === 1
        ? new Response(null, { status: 302, headers: { location: `https://cdn.example.invalid/${filename}` } })
        : new Response("synthetic media", { status: 206 });
    });
    const response = await fetchMediaSource(`https://media.example.invalid/${filename}`, {
      headers: { range: "bytes=0-1023" },
      resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
      request,
    });
    expect(response.status).toBe(206);
    expect(request).toHaveBeenCalledTimes(2);
    for (const [, headers] of request.mock.calls) {
      expect(headers).toEqual({ "user-agent": "Mozilla/5.0 (compatible; Substream/0.1)", range: "bytes=0-1023" });
    }
  });

  it("bounds a hanging ffprobe process and escalates termination safely", async () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    child.kill = vi.fn((signal) => {
      if (signal === "SIGKILL") {
        child.signalCode = signal;
        child.emit("close", null, signal);
      }
      return true;
    });

    await expect(runJson("synthetic-ffprobe", [], {
      timeoutMs: 10,
      killGraceMs: 10,
      spawnProcess: vi.fn(() => child),
    })).rejects.toThrow("Media probe timed out.");
    expect(child.kill.mock.calls.map(([signal]) => signal)).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("closes the source proxy when ffprobe reaches its deadline", async () => {
    const closeProxy = vi.fn(async () => undefined);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    child.kill = vi.fn((signal) => {
      if (signal === "SIGKILL") {
        child.signalCode = signal;
        child.emit("close", null, signal);
      }
      return true;
    });

    await expect(prepareMedia("https://media.example.invalid/video.mkv", {
      timeoutMs: 10,
      killGraceMs: 10,
      sourceProxyFactory: async () => ({ url: "http://127.0.0.1:9999/opaque", close: closeProxy }),
      spawnProcess: () => child,
    })).rejects.toThrow("Media probe timed out.");
    expect(child.kill.mock.calls.map(([signal]) => signal)).toEqual(["SIGTERM", "SIGKILL"]);
    expect(closeProxy).toHaveBeenCalledOnce();
  });

  it("times out an upstream request independently of the proxy client and returns a sanitized response", async () => {
    let receivedSignal;
    const fetchSource = vi.fn((_sourceUrl, { signal }) => new Promise((_resolve, reject) => {
      receivedSignal = signal;
      signal.addEventListener("abort", () => reject(new Error("secret upstream detail")), { once: true });
    }));
    const { serverFactory, issueRequest } = syntheticProxyHarness();
    const proxy = await createSourceProxy("https://media.example.invalid/video.mkv", { fetchSource, timeoutMs: 15, serverFactory });
    try {
      const { response, finished } = issueRequest(proxy.url);
      await finished;
      expect(response.statusCode).toBe(504);
      expect(response.chunks).toEqual([]);
      expect(receivedSignal.aborted).toBe(true);
      expect(fetchSource).toHaveBeenCalledOnce();
    } finally {
      await proxy.close();
    }
  });

  it("cancels and destroys a stalled upstream response stream at the proxy deadline", async () => {
    let canceled = false;
    const fetchSource = vi.fn(async () => new Response(new ReadableStream({
      pull: () => new Promise(() => undefined),
      cancel: () => { canceled = true; },
    }), { status: 200, headers: { "content-type": "video/mp2t" } }));
    const { serverFactory, issueRequest } = syntheticProxyHarness();
    const proxy = await createSourceProxy("https://media.example.invalid/video.ts", { fetchSource, timeoutMs: 20, serverFactory });
    try {
      const { response, finished } = issueRequest(proxy.url);
      await finished;
      expect(response.statusCode).toBe(200);
      expect(response.destroyed).toBe(true);
      expect(canceled).toBe(true);
    } finally {
      await proxy.close();
    }
  });

  it("rejects audio-only or malformed probe results", () => {
    expect(() => mediaPlan({ streams: [{ codec_type: "audio", codec_name: "eac3" }] })).toThrow("No video stream");
    expect(() => mediaPlan(null)).toThrow("No video stream");
  });
});
