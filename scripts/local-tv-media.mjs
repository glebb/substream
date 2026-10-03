import { spawn } from "node:child_process";
import { stat, unlink } from "node:fs/promises";

const INPUT_OPTIONS = ["-protocol_whitelist", "file,pipe", "-format_whitelist", "matroska,webm,mov,mp4,mpegts,mpeg,avi,m4v,asf"];
// Keep the aggregate bitrate within the conservative 20 Mbps 2017 FHD limit.
// The lower 5 Mbps encoding target is not a limit for copying existing H.264.
const MAX_COPY_BITRATE = 20_000_000;
const MAX_PREPARATION_MS = 2 * 60 * 60 * 1000;

/** Conservative Tizen 3 progressive playback profile, preserving the source aspect ratio. */
export function localTvPlan(probe) {
  const video = probe.streams?.find((item) => item.codec_type === "video");
  const audio = probe.streams?.find((item) => item.codec_type === "audio");
  if (!video) throw new Error("The selected file has no video stream.");
  const duration = Number(probe.format?.duration);
  const rateParts = String(video.avg_frame_rate || "0/1").split("/").map(Number);
  const frameRate = rateParts[0] / rateParts[1];
  const copyVideo = video.codec_name === "h264" && video.pix_fmt === "yuv420p"
    && video.width > 0 && video.width <= 1920 && video.height > 0 && video.height <= 1080
    && frameRate > 0 && frameRate <= 30 && ["Baseline", "Constrained Baseline", "Main", "High"].includes(video.profile)
    && Number(video.level) <= 41 && Number(probe.format?.bit_rate) > 0 && Number(probe.format.bit_rate) <= MAX_COPY_BITRATE;
  // Samsung's 2017 TVs support Dolby Digital Plus up to 5.1 channels.
  // Copy the E-AC-3 stream, including Atmos metadata; playback of Atmos depends on the TV/audio system.
  const copyAudio = (audio?.codec_name === "aac" && audio.profile === "LC" && audio.channels > 0 && audio.channels <= 2)
    || (audio?.codec_name === "eac3" && audio.channels > 0 && audio.channels <= 6);
  return { copyVideo, copyAudio, hasAudio: Boolean(audio), duration: Number.isFinite(duration) && duration > 0 ? duration : null };
}

export function localTvArguments(input, output, plan, maxBytes, encoder = "libx264") {
  const args = ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", ...INPUT_OPTIONS, "-i", input, "-map", "0:v:0", "-map", "0:a:0?", "-sn", "-dn", "-map_metadata", "-1", "-map_chapters", "-1"];
  if (plan.copyVideo) args.push("-c:v", "copy");
  else args.push("-vf", "scale=w='min(1920,iw)':h='min(1080,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1", "-c:v", encoder, ...(encoder === "h264_videotoolbox" ? ["-b:v", "4M", "-allow_sw", "0"] : ["-preset", "veryfast", "-crf", "20"]), "-pix_fmt", "yuv420p", "-profile:v", "high", "-level:v", "4.1", "-fpsmax", "30", "-maxrate", "5M", "-bufsize", "10M", "-threads", "2");
  if (plan.hasAudio) args.push("-c:a", plan.copyAudio ? "copy" : "aac", ...(plan.copyAudio ? [] : ["-ac", "2", "-b:a", "192k"]));
  args.push("-fs", String(maxBytes), "-movflags", "+faststart", "-f", "mp4", output);
  return args;
}

function run(binary, args, { signal, timeoutMs, capture = false }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("TV preparation cancelled."));
    const child = spawn(binary, args, { stdio: ["ignore", capture ? "pipe" : "ignore", "ignore"] });
    let output = "";
    let stopped = false;
    const stop = () => { stopped = true; child.kill("SIGKILL"); };
    const timer = setTimeout(stop, timeoutMs);
    signal?.addEventListener("abort", stop, { once: true });
    child.stdout?.on("data", (chunk) => { output += chunk; if (output.length > 1024 * 1024) stop(); });
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", stop); };
    child.once("error", () => { cleanup(); reject(new Error("TV preparation requires ffmpeg and ffprobe on the computer.")); });
    child.once("close", (code) => { cleanup(); if (stopped || code !== 0) reject(new Error("TV-compatible video could not be prepared. Check ffmpeg and the selected file.")); else resolve(output); });
  });
}

async function probeFile(input, signal) {
  const raw = await run(process.env.FFPROBE_PATH || "ffprobe", ["-v", "error", ...INPUT_OPTIONS, "-show_streams", "-show_format", "-of", "json", input], { signal, timeoutMs: 30_000, capture: true });
  try { return JSON.parse(raw); } catch { throw new Error("Video information could not be read."); }
}

/** Finishes conversion and fast-start indexing before exposing any bytes to the TV. */
export async function prepareLocalTvMedia(input, output, { maxBytes, signal } = {}) {
  try {
    const probe = await probeFile(input, signal);
    const plan = localTvPlan(probe);
    // Even compatible MKV files are remuxed to an indexed MP4 with only selected AV streams.
    if (plan.copyVideo && (!plan.hasAudio || plan.copyAudio) && String(probe.format?.format_name).split(",").includes("mp4")) {
      return { path: input, size: (await stat(input)).size, mediaType: "video/mp4", converted: false };
    }
    const encoder = process.platform === "darwin" ? "h264_videotoolbox" : "libx264";
    try {
      await run(process.env.FFMPEG_PATH || "ffmpeg", localTvArguments(input, output, plan, maxBytes, encoder), { signal, timeoutMs: MAX_PREPARATION_MS });
    } catch (cause) {
      if (encoder !== "h264_videotoolbox" || plan.copyVideo || signal?.aborted) throw cause;
      await unlink(output).catch(() => {});
      await run(process.env.FFMPEG_PATH || "ffmpeg", localTvArguments(input, output, plan, maxBytes), { signal, timeoutMs: MAX_PREPARATION_MS });
    }
    const result = await stat(output);
    const outputProbe = await probeFile(output, signal);
    const outputDuration = Number(outputProbe.format?.duration);
    // -fs can exit successfully with a truncated movie; never dispatch such an output.
    if (result.size <= 0 || result.size >= maxBytes || (plan.duration && (!Number.isFinite(outputDuration) || Math.abs(outputDuration - plan.duration) > 2))) throw new Error("The TV-compatible copy exceeds the companion service limit or is incomplete.");
    return { path: output, size: result.size, mediaType: "video/mp4", converted: true };
  } catch (cause) { await unlink(output).catch(() => {}); throw cause; }
}
