import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lookup } from "node:dns/promises";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

const ffprobeDefault = process.env.FFPROBE_PATH || "ffprobe";
const ffmpegDefault = process.env.FFMPEG_PATH || "ffmpeg";

/** Keep unsupported containers/codecs out of the browser; video is always stream-copied. */
export function mediaPlan(probe, { supportsEac3 = false, supportsAc3 = false } = {}) {
  const streams = Array.isArray(probe?.streams) ? probe.streams : [];
  const video = streams.find((stream) => stream.codec_type === "video");
  const audio = streams.find((stream) => stream.codec_type === "audio");
  if (!video) throw new Error("No video stream was found.");
  const codec = String(audio?.codec_name || "").toLowerCase();
  return {
    videoCodec: String(video.codec_name || "").toLowerCase(),
    audioCodec: codec,
    convertAudio: (codec === "eac3" && !supportsEac3) || (codec === "ac3" && !supportsAc3),
    audioIndex: audio?.index,
    duration: Number.isFinite(Number(probe.format?.duration)) && Number(probe.format.duration) > 0 ? Number(probe.format.duration) : null,
  };
}

export function hlsOutputArguments(segmentPattern, playlist, plan, startSeconds = 0, segmentSecondsOverride) {
  const args = ["-map", "0:v:0", "-map", "0:a:0?", "-c:v", "copy"];
  // Input-seeking into an H.264 MKV can start at a keyframe without repeating
  // SPS/PPS. Re-inject codec extradata at each keyframe so TS fragments remain
  // decodable when playback starts at a resumed position.
  if (plan.videoCodec === "h264") args.push("-bsf:v", "h264_mp4toannexb,dump_extra=freq=keyframe");
  if (plan.audioIndex !== undefined) {
    args.push("-c:a", plan.convertAudio ? "aac" : "copy");
    if (plan.convertAudio) {
      args.push("-ac", "2");
      // A resumed demux seek can leave initial audio PTS behind video. Fill
      // that gap only for resume jobs; keep source-zero startup unchanged.
      if (startSeconds > 0) args.push("-af", "aresample=async=1:first_pts=0");
    }
  }
  // Split at one-second boundaries instead of waiting for a long source GOP.
  // Video stays copied; subsequent segments may depend on earlier keyframes,
  // so the manifest intentionally omits INDEPENDENT-SEGMENTS.
  // A longer first fragment on resume gives the AAC encoder's first packets
  // time to join the copied video before hls.js inspects the initial TS track set.
  const segmentSeconds = String(segmentSecondsOverride ?? (startSeconds > 0 ? 2 : 1));
  args.push("-f", "hls", "-hls_time", segmentSeconds, "-hls_playlist_type", "event", "-hls_flags", "split_by_time+temp_file", "-hls_segment_filename", segmentPattern, playlist);
  return args;
}

/** Fetch only public HTTP(S) origins. The route also requires a same-origin request. */
export function validMediaSource(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    if (url.username || url.password || !url.hostname || url.hostname === "localhost" || url.hostname.endsWith(".localhost") || url.hostname.endsWith(".local")) return false;
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (/^(?:127\.|10\.|192\.168\.|169\.254\.|0\.|255\.)/.test(host) || /^172\.(?:1[6-9]|2\d|3[01])\./.test(host) || host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:")) return false;
    return true;
  } catch { return false; }
}

function publicAddress(address) {
  return !(/^(?:127\.|10\.|192\.168\.|169\.254\.|0\.|255\.)/.test(address)
    || /^172\.(?:1[6-9]|2\d|3[01])\./.test(address)
    || address === "::1" || /^f[cd]/i.test(address) || /^fe[89ab]/i.test(address)
    || address === "::" || /^::ffff:(?:127\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.)/i.test(address));
}

async function assertPublicHost(url) {
  const addresses = await lookup(url.hostname, { all: true, verbatim: true }).catch(() => []);
  if (!addresses.length || addresses.some(({ address }) => !publicAddress(address))) throw new Error("Media source is not allowed.");
}

async function fetchSource(sourceUrl, headers, redirects = 0, signal) {
  const url = new URL(sourceUrl);
  if (!validMediaSource(url.toString()) || redirects > 4) throw new Error("Media source is not allowed.");
  await assertPublicHost(url);
  const upstream = await fetch(url, { headers, redirect: "manual", signal });
  if (upstream.status >= 300 && upstream.status < 400) {
    const location = upstream.headers.get("location");
    if (!location) throw new Error("Media source redirect was invalid.");
    return fetchSource(new URL(location, url).toString(), headers, redirects + 1, signal);
  }
  return upstream;
}

async function createSourceProxy(sourceUrl) {
  const token = randomBytes(18).toString("hex");
  const server = createServer(async (request, response) => {
    if (request.url !== `/${token}` || request.method !== "GET") { response.writeHead(404).end(); return; }
    const controller = new AbortController();
    response.once("close", () => controller.abort());
    try {
      const upstream = await fetchSource(sourceUrl, request.headers.range ? { range: request.headers.range } : undefined, 0, controller.signal);
      response.writeHead(upstream.status, {
        ...(upstream.headers.get("content-type") ? { "content-type": upstream.headers.get("content-type") } : {}),
        ...(upstream.headers.get("content-length") ? { "content-length": upstream.headers.get("content-length") } : {}),
        ...(upstream.headers.get("content-range") ? { "content-range": upstream.headers.get("content-range") } : {}),
        "accept-ranges": upstream.headers.get("accept-ranges") || "bytes",
      });
      if (!upstream.body) { response.end(); return; }
      for await (const chunk of upstream.body) { if (response.destroyed) break; response.write(chunk); }
      response.end();
    } catch { if (!response.headersSent) response.writeHead(502); response.end(); }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  return { url: `http://127.0.0.1:${address.port}/${token}`, close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); }) };
}

export function runJson(binary, args, { spawnProcess = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(binary, args, { stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; if (output.length > 4 * 1024 * 1024) child.kill(); });
    child.once("error", () => reject(new Error("Media probe tool is unavailable.")));
    child.once("close", (code) => {
      if (code !== 0) return reject(new Error("Media probe failed."));
      try { resolve(JSON.parse(output)); } catch { reject(new Error("Media probe returned invalid data.")); }
    });
  });
}

async function segmentHasPlayableTracks(filename, options) {
  if (options.segmentHasPlayableTracks) return options.segmentHasPlayableTracks(filename);
  const probe = await runJson(options.ffprobePath || ffprobeDefault, [
    "-v", "error", "-count_packets", "-show_entries", "stream=codec_type,codec_name,nb_read_packets", "-of", "json", filename,
  ], options);
  const streams = Array.isArray(probe.streams) ? probe.streams : [];
  return streams.some((stream) => stream.codec_type === "video" && stream.codec_name === "h264" && Number(stream.nb_read_packets) > 0)
    && streams.some((stream) => stream.codec_type === "audio" && stream.codec_name === "aac" && Number(stream.nb_read_packets) > 0);
}

async function emptyDirectory(directory) {
  await Promise.all((await readdir(directory)).map((entry) => rm(join(directory, entry), { recursive: true, force: true })));
}

function stopProcess(process, isClosed) {
  if (isClosed()) return Promise.resolve();
  return new Promise((resolve) => {
    process.once("close", resolve);
    if (process.exitCode === null && process.signalCode === null) process.kill("SIGTERM");
  });
}

export async function prepareMedia(sourceUrl, options = {}) {
  if (!validMediaSource(sourceUrl)) throw new Error("Media source is not allowed.");
  const proxy = await (options.sourceProxyFactory || createSourceProxy)(sourceUrl);
  let directory;
  let process;
  let processClosed = false;
  try {
    const probe = options.probeResult || await runJson(options.ffprobePath || ffprobeDefault, ["-v", "error", "-show_streams", "-show_format", "-of", "json", proxy.url], options);
    const plan = mediaPlan(probe, { supportsEac3: options.supportsEac3, supportsAc3: options.supportsAc3 });
    if (!plan.convertAudio || !options.supportsH264 || plan.videoCodec !== "h264") {
      await proxy.close();
      return { direct: true, plan };
    }
    directory = await mkdtemp(join(options.tempRoot || tmpdir(), "substream-media-"));
    const playlist = join(directory, "index.m3u8");
    const segment = join(directory, "segment%05d.ts");
    const startSeconds = Number.isFinite(options.startSeconds) && options.startSeconds > 0
      ? Math.min(options.startSeconds, Math.max(0, (plan.duration || options.startSeconds) - 1)) : 0;
    // Input seeking lets long resume positions begin near the requested time
    // instead of converting every preceding segment. FFmpeg resets the output
    // timeline to zero; the browser receives startSeconds as its timeline base.
    const attempts = startSeconds > 0 ? [2, 4, 8, 16] : [1];
    let firstSegmentReady = false;
    for (const segmentSeconds of attempts) {
      processClosed = false;
      const args = ["-nostdin", "-hide_banner", "-loglevel", "error", "-protocol_whitelist", "http,tcp"];
      if (startSeconds > 0) args.push("-ss", startSeconds.toFixed(3));
      args.push("-i", proxy.url);
      args.push(...hlsOutputArguments(segment, playlist, plan, startSeconds, segmentSeconds));
      process = (options.spawnProcess || spawn)(options.ffmpegPath || ffmpegDefault, args, { stdio: "ignore" });
      process.once("close", () => { processClosed = true; });
      const readyDeadline = Date.now() + 15_000;
      let filesReady = false;
      while (Date.now() < readyDeadline) {
        try {
          await stat(playlist);
          await stat(join(directory, "segment00000.ts"));
          filesReady = true;
          break;
        } catch {
          if (process.exitCode !== null) throw new Error("Media conversion failed.");
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      if (!filesReady) throw new Error("Media conversion did not start.");
      if (await segmentHasPlayableTracks(join(directory, "segment00000.ts"), options)) {
        firstSegmentReady = true;
        break;
      }
      const processStopped = stopProcess(process, () => processClosed);
      await processStopped;
      if (segmentSeconds === attempts.at(-1)) throw new Error("Media conversion could not prepare an audio-compatible segment.");
      await emptyDirectory(directory);
    }
    if (!firstSegmentReady) throw new Error("Media conversion could not prepare an audio-compatible segment.");
    let cleanupPromise;
    return {
      directory, playlist, plan, process, startSeconds,
      cleanup: () => {
        cleanupPromise ??= (async () => {
          const processStopped = stopProcess(process, () => processClosed);
          let proxyCloseError;
          try { await proxy.close(); } catch (error) { proxyCloseError = error; }
          await processStopped;
          await rm(directory, { recursive: true, force: true });
          if (proxyCloseError) throw proxyCloseError;
        })();
        return cleanupPromise;
      },
    };
  } catch (error) {
    const processStopped = process ? stopProcess(process, () => processClosed) : Promise.resolve();
    try { await proxy.close(); } catch { /* Preserve the original sanitized media error. */ }
    await processStopped;
    if (directory) {
      try { await rm(directory, { recursive: true, force: true }); } catch { /* Preserve the original sanitized media error. */ }
    }
    throw error;
  }
}
