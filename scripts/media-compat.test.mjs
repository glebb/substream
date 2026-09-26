import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { access, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { hlsOutputArguments, mediaPlan, prepareMedia, validMediaSource } from "./media-compat.mjs";

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

  it("rejects non-HTTP, credentialed, and private-network media sources", () => {
    expect(validMediaSource("https://media.example.invalid/video.mkv?token=test")).toBe(true);
    expect(validMediaSource("file:///etc/passwd")).toBe(false);
    expect(validMediaSource("http://user:pass@media.example.invalid/video.mkv")).toBe(false);
    expect(validMediaSource("http://127.0.0.1/video.mkv")).toBe(false);
    expect(validMediaSource("http://192.168.1.20/video.mkv")).toBe(false);
  });

  it("rejects audio-only or malformed probe results", () => {
    expect(() => mediaPlan({ streams: [{ codec_type: "audio", codec_name: "eac3" }] })).toThrow("No video stream");
    expect(() => mediaPlan(null)).toThrow("No video stream");
  });
});
