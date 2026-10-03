import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, access, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { localTvArguments, localTvPlan, prepareLocalTvMedia } from "./local-tv-media.mjs";

const compatible = { streams: [
  { codec_type: "video", codec_name: "h264", profile: "High", level: 41, pix_fmt: "yuv420p", width: 1920, height: 1080, avg_frame_rate: "24000/1001" },
  { codec_type: "audio", codec_name: "aac", profile: "LC", channels: 2 },
], format: { duration: "60", bit_rate: "3000000" } };

describe("local TV compatibility", () => {
  it("copies compatible video/audio while producing an indexed MP4", () => {
    const plan = localTvPlan(compatible);
    expect(plan).toMatchObject({ copyVideo: true, copyAudio: true, duration: 60 });
    const args = localTvArguments("synthetic.input", "synthetic.mp4", plan, 10000000);
    expect(args.join(" ")).toContain("-c:v copy -c:a copy");
    expect(args).toContain("+faststart");
    expect(args).toContain("-sn");
  });
  it("converts wide 10-bit HEVC to bounded 1080p H264 while preserving EAC3 surround", () => {
    const probe = structuredClone(compatible);
    Object.assign(probe.streams[0], { codec_name: "hevc", profile: "Main 10", pix_fmt: "yuv420p10le", width: 2538 });
    Object.assign(probe.streams[1], { codec_name: "eac3", profile: "Dolby Digital Plus + Dolby Atmos", channels: 6 });
    const plan = localTvPlan(probe);
    expect(plan).toMatchObject({ copyVideo: false, copyAudio: true });
    const args = localTvArguments("synthetic.input", "synthetic.mp4", plan, 10000000);
    expect(args).toContain("libx264");
    expect(args).toContain("scale=w='min(1920,iw)':h='min(1080,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1");
    expect(args.join(" ")).toContain("-c:a copy");
    expect(args).not.toContain("-ac");
    expect(args.join(" ")).toContain("-maxrate 5M -bufsize 10M");
  });
  it("preserves compatible high-bitrate H264 and EAC3 audio", () => {
    const probe = structuredClone(compatible);
    probe.format.bit_rate = "10800000";
    Object.assign(probe.streams[1], { codec_name: "eac3", profile: "Dolby Digital Plus", channels: 6 });
    const plan = localTvPlan(probe);
    expect(plan).toMatchObject({ copyVideo: true, copyAudio: true });
    const args = localTvArguments("synthetic.mkv", "synthetic.mp4", plan, 100000000);
    expect(args.join(" ")).toContain("-c:v copy -c:a copy");
    expect(args).not.toContain("libx264");
    expect(args).not.toContain("-vf");
    expect(args).not.toContain("-maxrate");
    probe.format.bit_rate = "20000000";
    expect(localTvPlan(probe).copyVideo).toBe(true);
  });
  it("keeps an AAC fallback for EAC3 beyond the supported channel count", () => {
    const probe = structuredClone(compatible);
    Object.assign(probe.streams[1], { codec_name: "eac3", channels: 8 });
    const plan = localTvPlan(probe);
    expect(plan.copyAudio).toBe(false);
    expect(localTvArguments("synthetic.mkv", "synthetic.mp4", plan, 10000000).join(" ")).toContain("-c:a aac -ac 2 -b:a 192k");
    probe.streams[1].channels = 0;
    expect(localTvPlan(probe).copyAudio).toBe(false);
  });
  it("does not stream-copy unknown frame rates, excessive bitrates or decoder levels", () => {
    for (const update of [{ avg_frame_rate: "0/0" }, { level: 52 }, { pix_fmt: "yuv420p10le" }]) {
      const probe = structuredClone(compatible); Object.assign(probe.streams[0], update);
      expect(localTvPlan(probe).copyVideo).toBe(false);
    }
    expect(localTvPlan({ ...compatible, format: { ...compatible.format, bit_rate: "20000001" } }).copyVideo).toBe(false);
    expect(() => localTvPlan({ streams: [] })).toThrow("no video");
  });
});


it("cancels preparation before launching tools and leaves no partial copy", async () => {
  const dir = await mkdtemp(join(tmpdir(), "substream-tv-cancel-"));
  const output = join(dir, "synthetic.mp4");
  const controller = new AbortController(); controller.abort();
  try {
    await expect(prepareLocalTvMedia(join(dir, "synthetic.mkv"), output, { maxBytes: 10000000, signal: controller.signal })).rejects.toThrow("cancelled");
    await expect(access(output)).rejects.toThrow();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it.skipIf(spawnSync("ffmpeg", ["-version"]).status !== 0 || spawnSync("ffprobe", ["-version"]).status !== 0)("rejects size-limited incomplete output even when ffmpeg exits successfully", async () => {
  const dir = await mkdtemp(join(tmpdir(), "substream-tv-limit-"));
  const input = join(dir, "synthetic.mkv");
  const output = join(dir, "synthetic.mp4");
  try {
    expect(spawnSync("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=128x72:rate=24:duration=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", input], { stdio: "ignore" }).status).toBe(0);
    await expect(prepareLocalTvMedia(input, output, { maxBytes: 100 })).rejects.toThrow();
    await expect(access(output)).rejects.toThrow();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
