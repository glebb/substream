import {
  AudioSampleSink,
  AudioSampleSource,
  type AudioSample,
  EncodedAudioPacketSource,
  EncodedPacket,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  Input,
  CustomSource,
  MATROSKA,
  Mp4OutputFormat,
  Output,
  StreamTarget,
  WEBM,
  type InputAudioTrack,
  type InputVideoTrack,
  type StreamTargetChunk,
} from "mediabunny";
import { VodRangeSource, VodRangeSourceError } from "./vod-range-source.ts";
import {
  VOD_REMUX_AUDIO_MIME_CODECS,
  type VodRemuxAudioCodec,
  type VodRemuxAudioLabel,
  VOD_REMUX_MAX_AUDIO_TRACKS,
  VOD_REMUX_MAX_CHUNK_BYTES,
  type VodRemuxAudioTrack,
  type VodRemuxFailureReason,
  type VodRemuxWorkerRequest,
  type VodRemuxWorkerResponse,
} from "./vod-remux-protocol.ts";

const MAX_PACKET_BYTES = 8 * 1024 * 1024;
const MAX_BUFFERED_PACKET_BYTES = 32 * 1024 * 1024;
const MAX_SOURCE_REQUEST_BYTES = 32 * 1024 * 1024;
const SOURCE_RANGE_BYTES = 2 * 1024 * 1024;

export interface VodRemuxWorkerScope {
  addEventListener(type: "message", listener: (event: MessageEvent<VodRemuxWorkerRequest>) => void): void;
  postMessage(message: VodRemuxWorkerResponse, transfer?: Transferable[]): void;
}

interface CreditGate {
  wait(): Promise<void>;
  acknowledge(): void;
  dispose(): void;
}

/** Each output chunk needs player credit before further output and ranged reads. */
export function createVodRemuxCreditGate(): CreditGate {
  let waiting: (() => void) | undefined;
  let disposed = false;
  return {
    wait() {
      if (disposed) return Promise.resolve();
      return new Promise<void>((resolve) => { waiting = resolve; });
    },
    acknowledge() {
      const resolve = waiting;
      waiting = undefined;
      resolve?.();
    },
    dispose() {
      disposed = true;
      this.acknowledge();
    },
  };
}

/** Installs the MKV/WebM packet-copy remux worker handler. */
export function installVodRemuxWorker(scope: VodRemuxWorkerScope): void {
  let disposed = false;
  let started = false;
  let gate: CreditGate | undefined;
  let abort: AbortController | undefined;
  let source: VodRangeSource | undefined;
  let input: Input | undefined;
  let output: Output | undefined;
  let failureReported = false;
  let activeReads = 0;
  let waitingForCredit = false;
  let progressTimer: ReturnType<typeof setInterval> | undefined;

  const cleanup = async (): Promise<void> => {
    disposed = true;
    clearInterval(progressTimer);
    abort?.abort();
    gate?.dispose();
    if (output?.state !== "finalized" && output?.state !== "canceled") {
      try { await output?.cancel(); } catch { /* Cancellation is best effort. */ }
    }
    try { input?.dispose(); } catch { /* Disposal is best effort. */ }
    try { source?.dispose(); } catch { /* Disposal is best effort. */ }
    output = undefined;
    input = undefined;
    source = undefined;
  };

  const reportFailure = (error: unknown): void => {
    if (disposed || failureReported) return;
    failureReported = true;
    scope.postMessage({ type: "error", reason: classifyFailure(error), ...(error instanceof FixedRemuxError && error.audioCodec ? { audioCodec: error.audioCodec } : {}) });
    void cleanup();
  };

  scope.addEventListener("message", (event) => {
    const request = event.data;
    if (!request || typeof request !== "object") return;
    if (request.type === "dispose") {
      void cleanup();
      return;
    }
    if (request.type === "ack") {
      gate?.acknowledge();
      return;
    }
    if (request.type !== "start" || disposed || started) return;
    started = true;
    abort = new AbortController();
    gate = createVodRemuxCreditGate();
    void run(request).catch((error: unknown) => {
      if (disposed || isAbortError(error)) return;
      reportFailure(error);
    });
  });

  async function run(request: Extract<VodRemuxWorkerRequest, { type: "start" }>): Promise<void> {
    if (typeof request.url !== "string" || request.url.length === 0
      || !Number.isFinite(request.startSeconds) || request.startSeconds < 0
      || (request.audioTrackId !== undefined && !Number.isSafeInteger(request.audioTrackId))) {
      throw new FixedRemuxError("invalid-media");
    }

    source = new VodRangeSource(request.url, abort?.signal ? { signal: abort.signal } : {});
    const rangedSource = new CustomSource({
      getSize: () => source!.getSize(),
      read: (start, end) => createRangedReadStream(source!, start, end, (active) => {
        activeReads += active ? 1 : -1;
      }),
      dispose: () => source?.dispose(),
      // Network prefetch grows to 8 MiB. A smaller parser cache evicts
      // prefetched bytes before interleaved audio/video clusters consume them.
      maxCacheSize: 8 * 1024 * 1024,
      prefetchProfile: "network",
      handleUnhandledError: reportFailure,
    });
    input = new Input({ formats: [MATROSKA, WEBM], source: rangedSource });
    if (!await input.canRead()) throw new FixedRemuxError("invalid-media");

    const videoTrack = await input.getPrimaryVideoTrack();
    if (!videoTrack) throw new FixedRemuxError("unsupported-video");
    const videoCodec = await videoTrack.getCodec();
    if (videoCodec !== "avc" && videoCodec !== "hevc") throw new FixedRemuxError("unsupported-video");
    const videoConfig = await videoTrack.getDecoderConfig();
    if (!isSupportedVideoConfig(videoConfig, videoCodec)) throw new FixedRemuxError("unsupported-video");

    const allAudio = await input.getAudioTracks();
    const primaryAudio = await input.getPrimaryAudioTrack();
    const requestedAudio = request.audioTrackId === undefined
      ? primaryAudio
      : allAudio.find((track) => track.id === request.audioTrackId) ?? null;
    const audioCandidates = allAudio.slice(0, VOD_REMUX_MAX_AUDIO_TRACKS);
    if (primaryAudio && !audioCandidates.some((track) => track.id === primaryAudio.id)) audioCandidates.push(primaryAudio);
    if (requestedAudio && !audioCandidates.some((track) => track.id === requestedAudio.id)) audioCandidates.push(requestedAudio);
    const accepted = request.supportedAudioCodecs ?? ["aac"];
    if (!Array.isArray(accepted) || accepted.length > 7
      || accepted.some((codec) => !Object.hasOwn(VOD_REMUX_AUDIO_MIME_CODECS, codec))) {
      throw new FixedRemuxError("invalid-media");
    }
    const playableAudio: Array<{ track: InputAudioTrack; config: AudioDecoderConfig; codec: VodRemuxAudioCodec }> = [];
    for (const track of audioCandidates) {
      const codec = await track.getCodec();
      if (!codec || !accepted.includes(codec as VodRemuxAudioCodec)
        || (request.forceDolbyAac === true && (codec === "ac3" || codec === "eac3"))) continue;
      const config = await track.getDecoderConfig();
      if (isSupportedAudioConfig(config, codec as VodRemuxAudioCodec)) playableAudio.push({ track, config, codec: codec as VodRemuxAudioCodec });
    }
    // Prefer the provider's default, but use an alternate browser-compatible
    // track when that default cannot be copied. Explicit selections stay strict.
    const forcedDolby = request.forceDolbyAac === true && requestedAudio
      && ["ac3", "eac3"].includes((await requestedAudio.getCodec()) ?? "");
    let selected = forcedDolby ? undefined : playableAudio.find(({ track }) => track.id === requestedAudio?.id)
      ?? (request.audioTrackId === undefined ? playableAudio[0] : undefined);
    let convertAudio = false;
    if (!selected && requestedAudio && accepted.includes("aac")) {
      const codec = await requestedAudio.getCodec();
      const config = await requestedAudio.getDecoderConfig();
      if ((codec === "ac3" || codec === "eac3") && config
        && config.numberOfChannels > 0 && config.numberOfChannels <= 8
        && config.sampleRate > 0 && config.sampleRate <= 96000) {
        const [decoder, encoder] = await Promise.all([
          import("@mediabunny/ac3"), import("@mediabunny/aac-encoder"),
        ]);
        decoder.registerAc3Decoder();
        encoder.registerAacEncoder();
        convertAudio = true;
        selected = { track: requestedAudio, codec: "aac", config: { codec: "mp4a.40.2", sampleRate: config.sampleRate, numberOfChannels: config.numberOfChannels } };
        playableAudio.push(selected);
      }
    }
    if (!selected) throw new FixedRemuxError("unsupported-audio", safeAudioCodecLabel(await requestedAudio?.getCodec()));
    const { track: selectedAudio, config: audioConfig, codec: audioCodec } = selected;
    const audioTracks = await safeAudioTrackList(playableAudio.map(({ track }) => track), [selectedAudio.id]);

    const videoSink = new EncodedPacketSink(videoTrack);
    // Starting at zero needs no cue/index lookup (which can fetch the file tail).
    const videoStart = request.startSeconds === 0 ? await videoSink.getFirstKeyPacket() : await videoSink.getKeyPacket(request.startSeconds);
    const firstVideo = videoStart ?? await videoSink.getFirstKeyPacket();
    if (!firstVideo) throw new FixedRemuxError("invalid-media");
    const audioSink = new EncodedPacketSink(selectedAudio);
    const firstAudio = await audioSink.getPacket(firstVideo.timestamp) ?? await audioSink.getFirstPacket();
    if (!firstAudio) throw new FixedRemuxError("unsupported-audio");

    const duration = await input.getDurationFromMetadata([videoTrack, selectedAudio]);
    const mimeType = `video/mp4; codecs="${videoConfig.codec},${audioConfig.codec}"`;
    // The configured codec strings are also the strings passed into the output
    // muxer; no codec is inferred from the URL or advertised optimistically.
    scope.postMessage({
      type: "metadata",
      durationSeconds: Number.isFinite(duration) && duration !== null && duration >= 0 ? duration : null,
      mimeType,
      audioTracks,
      selectedAudioTrackId: selectedAudio.id,
      audioProcessing: convertAudio ? "dolby-to-aac" : "copy",
    });

    progressTimer = setInterval(() => {
      if (!disposed) scope.postMessage({ type: "progress", phase: activeReads > 0 ? "downloading" : waitingForCredit ? "waiting" : "remuxing" });
    }, 1000);
    const videoSource = new EncodedVideoPacketSource(videoCodec);
    const audioSource = convertAudio ? new AudioSampleSource({ codec: "aac", bitrate: 192_000 }) : new EncodedAudioPacketSource(audioCodec);
    let expectedPosition = 0;
    const outputPosition = { value: 0 };
    const target = new StreamTarget(new WritableStream<StreamTargetChunk>({
      write: async ({ data, position }) => {
        if (disposed) return;
        // Fragmented output is monotonic. Treat an unexpected patch write as a
        // processing failure rather than buffering or reordering the file.
        if (position !== expectedPosition) throw new FixedRemuxError("invalid-media");
        expectedPosition += data.byteLength;
        outputPosition.value = expectedPosition;
        for (let offset = 0; offset < data.byteLength; offset += VOD_REMUX_MAX_CHUNK_BYTES) {
          if (disposed) return;
          const copy = data.slice(offset, Math.min(offset + VOD_REMUX_MAX_CHUNK_BYTES, data.byteLength));
          const buffer = copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength) as ArrayBuffer;
          scope.postMessage({ type: "chunk", buffer }, [buffer]);
          waitingForCredit = true;
          try { await gate?.wait(); } finally { waitingForCredit = false; }
        }
      },
    }));
    output = new Output({ format: new Mp4OutputFormat({ fastStart: "fragmented", minimumFragmentDuration: 0.5 }), target });
    output.addVideoTrack(videoSource, { decoderConfig: videoConfig });
    if (convertAudio) output.addAudioTrack(audioSource);
    else output.addAudioTrack(audioSource, { decoderConfig: audioConfig, primingPacket: firstAudio });
    await output.start();

    if (convertAudio) {
      await pumpConvertedAudio(videoSink, firstVideo, videoSource, videoConfig,
        new AudioSampleSink(selectedAudio), audioSource as AudioSampleSource, () => disposed, outputPosition);
    } else {
      await pumpPackets(
        videoSink, firstVideo, videoSource, videoConfig,
        audioSink, firstAudio, audioSource as EncodedAudioPacketSource, audioConfig,
        () => disposed, outputPosition,
      );
    }
    if (disposed) return;
    await output.finalize();
    if (!disposed) scope.postMessage({ type: "end" });
    await cleanup();
  }
}

async function pumpPackets(
  videoSink: EncodedPacketSink,
  firstVideo: EncodedPacket,
  videoSource: EncodedVideoPacketSource,
  videoConfig: VideoDecoderConfig,
  audioSink: EncodedPacketSink,
  firstAudio: EncodedPacket,
  audioSource: EncodedAudioPacketSource,
  audioConfig: AudioDecoderConfig,
  isDisposed: () => boolean,
  outputPosition: { value: number },
): Promise<void> {
  let video: EncodedPacket | null = firstVideo;
  let audio: EncodedPacket | null = firstAudio;
  let bufferedPacketBytes = 0;
  while (!isDisposed() && (video || audio)) {
    // Merge by presentation time while preserving each track's decode order.
    // This lets the muxer close short fragments without one track running far
    // ahead and retaining an unbounded queue of the other track's packets.
    if (video && (!audio || video.timestamp <= audio.timestamp)) {
      if (video.data.byteLength > MAX_PACKET_BYTES) throw new FixedRemuxError("invalid-media");
      const beforeWrite = outputPosition.value;
      await videoSource.add(video, { decoderConfig: videoConfig });
      if (outputPosition.value !== beforeWrite) {
        bufferedPacketBytes = 0;
      } else {
        bufferedPacketBytes += video.data.byteLength;
        if (bufferedPacketBytes > MAX_BUFFERED_PACKET_BYTES) throw new FixedRemuxError("invalid-media");
      }
      video = await videoSink.getNextPacket(video);
    } else if (audio) {
      if (audio.data.byteLength > MAX_PACKET_BYTES) throw new FixedRemuxError("invalid-media");
      const beforeWrite = outputPosition.value;
      await audioSource.add(audio, { decoderConfig: audioConfig });
      if (outputPosition.value !== beforeWrite) {
        bufferedPacketBytes = 0;
      } else {
        bufferedPacketBytes += audio.data.byteLength;
        if (bufferedPacketBytes > MAX_BUFFERED_PACKET_BYTES) throw new FixedRemuxError("invalid-media");
      }
      audio = await audioSink.getNextPacket(audio);
    }
  }
}

/** Copy video and convert only unsupported Dolby audio on the device. */
async function pumpConvertedAudio(
  videoSink: EncodedPacketSink, firstVideo: EncodedPacket,
  videoSource: EncodedVideoPacketSource, videoConfig: VideoDecoderConfig,
  audioSink: AudioSampleSink, audioSource: AudioSampleSource,
  isDisposed: () => boolean, outputPosition: { value: number },
): Promise<void> {
  const samples = audioSink.samples(firstVideo.timestamp);
  let audio: AudioSample | undefined;
  let video: EncodedPacket | null = firstVideo;
  let retainedBytes = 0;
  try {
    audio = (await samples.next()).value ?? undefined;
    while (!isDisposed() && (video || audio)) {
      const before = outputPosition.value;
      let bytes: number;
      if (video && (!audio || video.timestamp <= audio.timestamp)) {
        bytes = video.data.byteLength;
        if (bytes > MAX_PACKET_BYTES) throw new FixedRemuxError("invalid-media");
        await videoSource.add(video, { decoderConfig: videoConfig });
        video = await videoSink.getNextPacket(video);
      } else {
        bytes = audio!.numberOfFrames * audio!.numberOfChannels * 4;
        if (bytes > MAX_PACKET_BYTES) throw new FixedRemuxError("invalid-media");
        await audioSource.add(audio!);
        audio!.close();
        audio = undefined;
        audio = (await samples.next()).value ?? undefined;
      }
      retainedBytes = outputPosition.value !== before ? 0 : retainedBytes + bytes;
      if (retainedBytes > MAX_BUFFERED_PACKET_BYTES) throw new FixedRemuxError("invalid-media");
    }
  } finally {
    audio?.close();
    await samples.return();
  }
}

function createRangedReadStream(source: VodRangeSource, start: number, end: number, onReading: (active: boolean) => void): ReadableStream<Uint8Array> {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start
    || end - start > MAX_SOURCE_REQUEST_BYTES) throw new FixedRemuxError("invalid-media");
  let cursor = start;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (cursor >= end) { controller.close(); return; }
      const nextEnd = Math.min(end, cursor + SOURCE_RANGE_BYTES);
      onReading(true);
      let bytes: Uint8Array;
      try { bytes = await source.read(cursor, nextEnd); }
      finally { onReading(false); }
      if (bytes.byteLength !== nextEnd - cursor) {
        controller.error(new FixedRemuxError("invalid-media"));
        return;
      }
      cursor = nextEnd;
      controller.enqueue(bytes);
    },
  });
}

function isSupportedVideoConfig(
  config: VideoDecoderConfig | null,
  codec: "avc" | "hevc",
): config is VideoDecoderConfig {
  if (!config || !config.codec || !Number.isFinite(config.codedWidth) || !Number.isFinite(config.codedHeight)) return false;
  if (config.codedWidth! <= 0 || config.codedHeight! <= 0) return false;
  return codec === "avc"
    ? /^avc1\.[0-9a-f]{6}$/i.test(config.codec)
    : /^(?:hvc1|hev1)\.[a-z0-9.]+$/i.test(config.codec);
}

function isSupportedAudioConfig(config: AudioDecoderConfig | null, codec: VodRemuxAudioCodec): config is AudioDecoderConfig {
  return !!config && (codec === "aac" ? /^mp4a\.40\.[0-9]+$/i.test(config.codec) : config.codec === VOD_REMUX_AUDIO_MIME_CODECS[codec])
    && Number.isSafeInteger(config.sampleRate) && config.sampleRate > 0
    && Number.isSafeInteger(config.numberOfChannels) && config.numberOfChannels > 0;
}

async function safeAudioTrackList(tracks: InputAudioTrack[], preferredIds: Array<number | undefined>): Promise<VodRemuxAudioTrack[]> {
  const preferred = preferredIds.filter((id): id is number => id !== undefined);
  const chosen = tracks.slice(0, VOD_REMUX_MAX_AUDIO_TRACKS);
  for (const id of preferred) {
    const track = tracks.find((candidate) => candidate.id === id);
    if (track && !chosen.some((candidate) => candidate.id === id)) {
      const replaceIndex = chosen.length >= VOD_REMUX_MAX_AUDIO_TRACKS ? chosen.length - 1 : chosen.length;
      chosen[replaceIndex] = track;
    }
  }
  const result: VodRemuxAudioTrack[] = [];
  for (const track of chosen) {
    const language = await track.getLanguageCode();
    result.push({
      id: track.id,
      label: `Audio ${track.number}`,
      language: /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/.test(language) ? language : "und",
    });
  }
  return result;
}

function safeAudioCodecLabel(codec: string | null | undefined): VodRemuxAudioLabel {
  if (codec && Object.hasOwn(VOD_REMUX_AUDIO_MIME_CODECS, codec)) return codec.toUpperCase() as VodRemuxAudioLabel;
  if (codec === "vorbis") return "VORBIS";
  if (codec?.startsWith("pcm-")) return "PCM";
  return "unknown";
}

class FixedRemuxError extends Error {
  constructor(readonly reason: VodRemuxFailureReason, readonly audioCodec?: VodRemuxAudioLabel) { super(reason); }
}

function classifyFailure(error: unknown): VodRemuxFailureReason {
  if (error instanceof FixedRemuxError) return error.reason;
  if (error instanceof VodRangeSourceError) {
    if (error.reason === "redirect") return "provider-redirect";
    if (error.reason === "timeout") return "provider-timeout";
    if (error.reason === "status") return "range-unsupported";
    if (error.reason === "metadata") return "range-metadata";
    if (error.reason === "range" || error.reason === "size") return "range-invalid";
    return "cors-range";
  }
  return "processing-failed";
}

function isAbortError(error: unknown): boolean {
  return !!error && typeof error === "object" && "name" in error && error.name === "AbortError";
}
