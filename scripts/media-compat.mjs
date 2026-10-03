import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lookup } from "node:dns/promises";
import { createServer } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import { randomBytes } from "node:crypto";
import { isIP } from "node:net";

const ffprobeDefault = process.env.FFPROBE_PATH || "ffprobe";
const ffmpegDefault = process.env.FFMPEG_PATH || "ffmpeg";
const MAX_MEDIA_JOB_DURATION_MS = 2 * 60 * 60 * 1000;
const MAX_MEDIA_PROBE_DURATION_MS = 30_000;
const MAX_SOURCE_PROXY_DURATION_MS = MAX_MEDIA_JOB_DURATION_MS;
const MAX_MEDIA_OUTPUT_BYTES = 2 * 1024 * 1024 * 1024;

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
  args.push("-fs", String(MAX_MEDIA_OUTPUT_BYTES), "-f", "hls", "-hls_time", segmentSeconds, "-hls_playlist_type", "event", "-hls_flags", "split_by_time+temp_file", "-hls_segment_filename", segmentPattern, playlist);
  return args;
}

/** Fetch only public HTTP(S) origins. The route also requires a same-origin request. */
export function validMediaSource(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    if (url.username || url.password || !url.hostname || url.hostname === "localhost" || url.hostname.endsWith(".localhost") || url.hostname.endsWith(".local")) return false;
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (isIP(host) && !publicAddress(host)) return false;
    return true;
  } catch { return false; }
}

function inCidr(value, network, prefixLength, bitLength) {
  const shift = BigInt(bitLength - prefixLength);
  return (value >> shift) === (network >> shift);
}

function ipv4Value(address) {
  if (isIP(address) !== 4) return null;
  return address.split(".").reduce((value, octet) => (value << 8n) | BigInt(octet), 0n);
}

function ipv6Value(address) {
  if (isIP(address) !== 6) return null;
  let normalized = address.toLowerCase();
  const embeddedIpv4 = normalized.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/);
  if (embeddedIpv4) {
    const value = ipv4Value(embeddedIpv4[1]);
    if (value === null) return null;
    normalized = normalized.slice(0, -embeddedIpv4[1].length) + `${(value >> 16n).toString(16)}:${(value & 0xffffn).toString(16)}`;
  }
  const halves = normalized.split("::");
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const groups = halves.length === 2
    ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right]
    : left;
  if (groups.length !== 8) return null;
  return groups.reduce((value, group) => (value << 16n) | BigInt(`0x${group || "0"}`), 0n);
}

function publicIpv4(address) {
  const value = ipv4Value(address);
  if (value === null) return false;
  // IANA IPv4 special-purpose and non-global ranges, including protocol,
  // documentation, benchmarking, shared-address, and reserved blocks.
  const excluded = [
    ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
    ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
    ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
    ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
  ];
  return !excluded.some(([network, prefix]) => inCidr(value, ipv4Value(network), prefix, 32));
}

function publicAddress(address) {
  const family = isIP(address);
  if (family === 4) return publicIpv4(address);
  if (family !== 6) return false;

  const value = ipv6Value(address);
  if (value === null) return false;
  // IPv4-mapped IPv6 addresses inherit the IPv4 classification of their tail.
  if ((value >> 32n) === 0xffffn) {
    const ipv4 = value & 0xffffffffn;
    const mappedAddress = [24n, 16n, 8n, 0n].map((shift) => Number((ipv4 >> shift) & 0xffn)).join(".");
    return publicIpv4(mappedAddress);
  }

  // Only global unicast space is eligible. This also rejects unspecified,
  // loopback, IPv4-compatible, ULA, link-local, multicast, and reserved space.
  if (!inCidr(value, 0x20000000000000000000000000000000n, 3, 128)) return false;
  const excluded = [
    ["2001::", 23], // IETF protocol assignments (includes Teredo and ORCHID).
    ["2001:db8::", 32], // Documentation.
    ["2002::", 16], // Deprecated 6to4.
    ["3fff::", 20], // Documentation.
    ["5f00::", 16], // Segment-routing SIDs.
    ["64:ff9b::", 96], // Well-known NAT64 prefix.
    ["64:ff9b:1::", 48], // Local-use NAT64 prefix.
  ];
  return !excluded.some(([network, prefix]) => inCidr(value, ipv6Value(network), prefix, 128))
    && !inCidr(value, 0x01000000000000000000000000000000n, 64, 128); // Discard-only 100::/64.
}

async function resolvePublicAddress(url, resolveHost = lookup) {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = await resolveHost(hostname, { all: true, verbatim: true }).catch(() => []);
  if (!addresses.length || addresses.some(({ address }) => !publicAddress(address))) throw new Error("Media source is not allowed.");
  return addresses[0];
}

function raceAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error("Media request aborted."));
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => { cleanup(); reject(signal.reason instanceof Error ? signal.reason : new Error("Media request aborted.")); };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then((value) => { cleanup(); resolve(value); }, (error) => { cleanup(); reject(error); });
  });
}

function requestPinned(url, headers, address, signal) {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const transport = url.protocol === "https:" ? httpsRequest : httpRequest;
  const family = address.family || (address.address.includes(":") ? 6 : 4);
  const request = transport(url, {
    method: "GET",
    headers: { ...headers, host: url.host },
    // Bypass the resolver after validation. The connection target is the exact
    // address checked above, while Host and TLS SNI/certificate checks retain
    // the URL's original hostname.
    hostname: address.address,
    family,
    servername: url.protocol === "https:" && !/^\d+(?:\.\d+){3}$/.test(hostname) && !hostname.includes(":") ? hostname : undefined,
    lookup: (_requestedHostname, _options, callback) => callback(null, address.address, family),
  });
  return new Promise((resolve, reject) => {
    const onAbort = () => request.destroy(signal.reason instanceof Error ? signal.reason : new Error("Media request aborted."));
    if (signal?.aborted) { onAbort(); }
    else signal?.addEventListener("abort", onAbort, { once: true });
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    request.once("error", (error) => { cleanup(); reject(error); });
    request.once("response", (incoming) => {
      incoming.once("close", cleanup);
      const body = incoming.statusCode === 204 || incoming.statusCode === 304 ? null : Readable.toWeb(incoming);
      resolve(new Response(body, {
        status: incoming.statusCode || 502,
        statusText: incoming.statusMessage,
        headers: incoming.headers,
      }));
    });
    request.end();
  });
}

export async function fetchMediaSource(sourceUrl, { headers, redirects = 0, signal, resolveHost = lookup, request = requestPinned } = {}) {
  const url = new URL(sourceUrl);
  if (!validMediaSource(url.toString()) || redirects > 4) throw new Error("Media source is not allowed.");
  const address = await raceAbort(resolvePublicAddress(url, resolveHost), signal);
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Media request aborted.");
  // Some IPTV providers reject otherwise valid media requests without a
  // User-Agent. Identify the local player consistently for probes, conversion,
  // range requests, and redirects; do not forward browser cookies or credentials.
  const mediaHeaders = { "user-agent": "Mozilla/5.0 (compatible; Substream/0.1)", ...headers };
  const upstream = await request(url, mediaHeaders, address, signal);
  if (upstream.status >= 300 && upstream.status < 400) {
    const location = upstream.headers.get("location");
    if (!location) throw new Error("Media source redirect was invalid.");
    await upstream.body?.cancel().catch(() => undefined);
    return fetchMediaSource(new URL(location, url).toString(), { headers, redirects: redirects + 1, signal, resolveHost, request });
  }
  return upstream;
}

export async function createSourceProxy(sourceUrl, { fetchSource = fetchMediaSource, timeoutMs = MAX_SOURCE_PROXY_DURATION_MS, serverFactory = createServer } = {}) {
  const token = randomBytes(18).toString("hex");
  const server = serverFactory(async (request, response) => {
    if (request.url !== `/${token}` || request.method !== "GET") { response.writeHead(404).end(); return; }
    const controller = new AbortController();
    let timedOut = false;
    const deadline = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error("Media source timed out."));
    }, timeoutMs);
    deadline.unref?.();
    response.once("close", () => controller.abort(new Error("Media client disconnected.")));
    let upstream;
    let reader;
    const cancelUpstream = () => {
      if (reader) void reader.cancel().catch(() => undefined);
      else if (upstream?.body) void upstream.body.cancel().catch(() => undefined);
    };
    controller.signal.addEventListener("abort", cancelUpstream, { once: true });
    try {
      upstream = await fetchSource(sourceUrl, { headers: request.headers.range ? { range: request.headers.range } : undefined, signal: controller.signal });
      if (controller.signal.aborted) throw controller.signal.reason;
      response.writeHead(upstream.status, {
        ...(upstream.headers.get("content-type") ? { "content-type": upstream.headers.get("content-type") } : {}),
        ...(upstream.headers.get("content-length") ? { "content-length": upstream.headers.get("content-length") } : {}),
        ...(upstream.headers.get("content-range") ? { "content-range": upstream.headers.get("content-range") } : {}),
        "accept-ranges": upstream.headers.get("accept-ranges") || "bytes",
      });
      if (!upstream.body) { response.end(); return; }
      reader = upstream.body.getReader();
      while (!response.destroyed) {
        const { done, value } = await reader.read();
        if (done) break;
        response.write(value);
      }
      if (controller.signal.aborted) throw controller.signal.reason;
      response.end();
    } catch {
      if (timedOut && response.headersSent) response.destroy();
      else if (!response.destroyed) {
        if (!response.headersSent) response.writeHead(timedOut ? 504 : 502);
        response.end();
      }
    } finally {
      clearTimeout(deadline);
      controller.signal.removeEventListener("abort", cancelUpstream);
      if (reader) { try { reader.releaseLock(); } catch { /* The upstream body may already be canceled. */ } }
    }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  return { url: `http://127.0.0.1:${address.port}/${token}`, close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); }) };
}

export function runJson(binary, args, { spawnProcess = spawn, timeoutMs = MAX_MEDIA_PROBE_DURATION_MS, killGraceMs = 250 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(binary, args, { stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    let settled = false;
    let timedOut = false;
    let outputTooLarge = false;
    let killTimer;
    const timer = setTimeout(() => {
      timedOut = true;
      stopChild();
    }, timeoutMs);
    timer.unref?.();
    const stopChild = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      try { child.kill("SIGTERM"); } catch { /* Process may have exited between checking and signaling. */ }
      clearTimeout(killTimer);
      killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          try { child.kill("SIGKILL"); } catch { /* Process may have exited before escalation. */ }
        }
      }, killGraceMs);
      killTimer.unref?.();
    };
    child.stdout.on("data", (chunk) => {
      if (!outputTooLarge && output.length + chunk.length > 4 * 1024 * 1024) {
        outputTooLarge = true;
        stopChild();
      } else if (!outputTooLarge) output += chunk;
    });
    child.once("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      reject(new Error("Media probe tool is unavailable."));
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      if (timedOut) return reject(new Error("Media probe timed out."));
      if (outputTooLarge) return reject(new Error("Media probe returned too much data."));
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
  let durationTimer;
  let durationExpired = false;
  let cleanupPromise;
  let jobCleanup;
  const requestedDurationMs = Number(options.maxDurationMs);
  const maxDurationMs = Number.isFinite(requestedDurationMs) && requestedDurationMs > 0
    ? Math.min(requestedDurationMs, MAX_MEDIA_JOB_DURATION_MS) : MAX_MEDIA_JOB_DURATION_MS;
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
      if (!durationTimer) {
        durationTimer = setTimeout(() => {
          durationExpired = true;
          if (jobCleanup) void jobCleanup().catch(() => undefined);
          else if (process) void stopProcess(process, () => processClosed);
        }, maxDurationMs);
        durationTimer.unref?.();
      }
      const readyDeadline = Date.now() + 15_000;
      let filesReady = false;
      while (Date.now() < readyDeadline) {
        if (durationExpired) throw new Error("Media conversion took too long.");
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
        if (durationExpired) throw new Error("Media conversion took too long.");
        firstSegmentReady = true;
        break;
      }
      const processStopped = stopProcess(process, () => processClosed);
      await processStopped;
      if (segmentSeconds === attempts.at(-1)) throw new Error("Media conversion could not prepare an audio-compatible segment.");
      await emptyDirectory(directory);
    }
    if (!firstSegmentReady) throw new Error("Media conversion could not prepare an audio-compatible segment.");
    if (durationExpired) throw new Error("Media conversion took too long.");
    jobCleanup = () => {
      cleanupPromise ??= (async () => {
        clearTimeout(durationTimer);
        const processStopped = stopProcess(process, () => processClosed);
        let proxyCloseError;
        try { await proxy.close(); } catch (error) { proxyCloseError = error; }
        await processStopped;
        await rm(directory, { recursive: true, force: true });
        if (proxyCloseError) throw proxyCloseError;
      })();
      return cleanupPromise;
    };
    return {
      directory, playlist, plan, process, startSeconds,
      cleanup: jobCleanup,
    };
  } catch (error) {
    clearTimeout(durationTimer);
    const processStopped = process ? stopProcess(process, () => processClosed) : Promise.resolve();
    try { await proxy.close(); } catch { /* Preserve the original sanitized media error. */ }
    await processStopped;
    if (directory) {
      try { await rm(directory, { recursive: true, force: true }); } catch { /* Preserve the original sanitized media error. */ }
    }
    throw error;
  }
}
