import { afterEach, describe, expect, it, vi } from "vitest";
import { createLiveRelaySession, LiveRelaySession } from "./client.ts";
import type { LiveRelayConfig } from "./config.ts";
import type { RelaySessionCreateResponse } from "../../core/live-relay/protocol.ts";

const base = "https://relay.example.test";
const config: LiveRelayConfig = { serviceUrl: base, deviceCredential: "d".repeat(64) };
const id = "a".repeat(32);
const cap = "c".repeat(64);

function sessionResponse() {
  return {
    protocolVersion: 1, sessionId: id, capability: cap, state: "ready", leaseExpiresAt: 123_000,
    mediaUrl: `${base}/v1/sessions/${id}/hls/index.m3u8?cap=${cap}`,
    cueUrl: `${base}/v1/sessions/${id}/cues`, statusUrl: `${base}/v1/sessions/${id}/status`,
    trackUrl: `${base}/v1/sessions/${id}/subtitle-track`, heartbeatUrl: `${base}/v1/sessions/${id}/heartbeat`,
    playbackStartedUrl: `${base}/v1/sessions/${id}/playback-started`,
    deleteUrl: `${base}/v1/sessions/${id}`,
  };
}

function cueBatch(sequence = 1) {
  return { cues: [{ seq: sequence, epoch: 0, trackId: "fi-1", startMs: 900, endMs: 2_500, clear: false, imageId: "img-1", screenWidth: 1920, screenHeight: 1080, x: 100, y: 800, width: 400, height: 100 }], nextCursor: sequence, reset: false };
}

function ok(value: unknown, status = 200): Response {
  return new Response(value === undefined ? null : JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

class FakeXhr {
  static instances: FakeXhr[] = [];
  status = 0;
  responseText = "";
  timeout = 0;
  aborted = false;
  method = "GET";
  url = "";
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  onabort: (() => void) | null = null;
  onprogress: ((event: ProgressEvent) => void) | null = null;
  constructor() { FakeXhr.instances.push(this); }
  open(method: string, url: string) { this.method = method; this.url = url; }
  setRequestHeader() {}
  getResponseHeader() { return null; }
  send() {
    if (this.method === "DELETE") { this.status = 204; this.onload?.(); }
  }
  abort() { this.aborted = true; this.onabort?.(); }
}

describe("live relay client", () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("creates a session with explicit bearer auth and uses returned same-origin URLs", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, ...(init ? { init } : {}) });
      if (url.endsWith("/v1/sessions")) return ok(sessionResponse());
      if (url.endsWith("/status")) return ok({ sessionId: id, state: "ready", tracks: [{ id: "fi-1", language: "fi", label: "Suomi" }], selectedTrackId: "fi-1", timingOrigin: 123.5, videoPtsOrigin90k: 900_000 });
      if (url.includes("/cues?")) return ok(cueBatch());
      if (url.endsWith("/subtitle-track")) return ok({ selected: true });
      if (url.endsWith("/playback-started")) return ok({ playbackStarted: true });
      if (url.endsWith("/heartbeat")) return ok({ leaseExpiresAt: 456_000 });
      if (url.endsWith(id)) return ok({ closed: true });
      return ok({});
    });
    const session = await createLiveRelaySession(config, "skyshowtime", "fi");
    try {
      expect(session.mediaUrl).toContain("?cap=");
      await expect(session.status()).resolves.toMatchObject({ state: "ready", timingOrigin: 123.5, videoPtsOrigin90k: 900_000, tracks: [{ language: "fi" }] });
      await expect(session.cues()).resolves.toMatchObject({ nextCursor: 1, cues: [{ imageId: "img-1" }] });
      await session.selectTrack("fi-1");
      await session.markPlaybackStarted();
      await expect(session.heartbeat()).resolves.toEqual({ leaseExpiresAt: 456_000 });
      expect(session.cueImageUrl("img-1")).toBe(`${base}/v1/sessions/${id}/images/img-1?cap=${cap}`);
      expect(() => session.cueImageUrl("../secret")).toThrow("image reference is invalid");
      await session.dispose();
      const create = calls[0]!;
      expect(create.url).toBe(`${base}/v1/sessions`);
      expect(create.init?.headers).toMatchObject({ authorization: `Bearer ${config.deviceCredential}` });
      expect(JSON.parse(String(create.init?.body))).toEqual({ channelId: "skyshowtime", preferredLanguage: "fi" });
      expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
        "/v1/sessions", `/v1/sessions/${id}/status`, `/v1/sessions/${id}/cues`, `/v1/sessions/${id}/subtitle-track`,
        `/v1/sessions/${id}/playback-started`, `/v1/sessions/${id}/heartbeat`, `/v1/sessions/${id}`,
      ]);
      expect(calls.slice(1).every((call) => (call.init?.headers as Record<string, string>).authorization === `Bearer ${config.deviceCredential}`)).toBe(true);
      expect(calls.every((call) => !call.url.includes(config.deviceCredential) && !call.url.includes(cap))).toBe(true);
      expect(calls[2]?.url).toContain("afterSequence=0");
      expect(JSON.parse(String(calls[3]?.init?.body))).toEqual({ trackId: "fi-1" });
    } finally { if (!calls.some((call) => call.init?.method === "DELETE")) await session.dispose().catch(() => undefined); }
  });

  it("rejects cross-origin capabilities, malformed cues, and arbitrary network error text", async () => {
    vi.stubGlobal("fetch", async (url: string) => url.endsWith("/v1/sessions")
      ? ok({ ...sessionResponse(), mediaUrl: `${base}/v1/sessions/${id}/hls/index.m3u8?cap=${"e".repeat(64)}`, cueUrl: "https://evil.example/cues" }) : ok({}));
    await expect(createLiveRelaySession(config, "channel-1")).rejects.toThrow("Could not start live subtitle relay session.");
    vi.stubGlobal("fetch", async (url: string) => url.endsWith("/v1/sessions")
      ? ok({ ...sessionResponse(), mediaUrl: `${base}/v1/sessions/${id}/hls/index.m3u8?cap=${"e".repeat(64)}` }) : ok({}));
    await expect(createLiveRelaySession(config, "channel-1")).rejects.toThrow("Could not start live subtitle relay session.");
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.endsWith("/v1/sessions")) return ok(sessionResponse());
      if (url.includes("/cues?")) return ok({ cues: [{ ...cueBatch().cues[0], imageId: "../../private" }], nextCursor: 1, reset: false });
      throw new Error("https://private.example/signed?token=secret");
    });
    const session = await createLiveRelaySession(config, "channel-1");
    try {
      await expect(session.cues()).rejects.toThrow("Could not read live subtitle cues.");
      await expect(session.status()).rejects.toThrow("Could not read live subtitle relay status.");
      vi.stubGlobal("fetch", async (url: string) => url.includes("/cues?") ? ok({ cues: [{ ...cueBatch().cues[0], width: 1025, height: 1025 }], nextCursor: 1, reset: false }) : ok({}));
      await expect(session.cues()).rejects.toThrow("Could not read live subtitle cues.");
    } finally { await session.dispose().catch(() => undefined); }
  });

  it("accepts older status fixtures that omit the optional video PTS anchor", async () => {
    vi.stubGlobal("fetch", async (url: string) => url.endsWith("/v1/sessions") ? ok(sessionResponse())
      : url.endsWith("/status") ? ok({ sessionId: id, state: "preparing", tracks: [], selectedTrackId: null }) : ok({ closed: true }));
    const session = await createLiveRelaySession(config, "channel-1");
    try {
      const status = await session.status();
      expect(status.state).toBe("preparing");
      expect(status).not.toHaveProperty("videoPtsOrigin90k");
    } finally { await session.dispose(); }
  });

  it("accepts explicit DVB clear cues with zero geometry", async () => {
    vi.stubGlobal("fetch", async (url: string) => url.endsWith("/v1/sessions") ? ok(sessionResponse())
      : url.includes("/cues?") ? ok({ cues: [{ seq: 1, epoch: 0, trackId: "fi-1", startMs: 1200, clear: true, screenWidth: 0, screenHeight: 0, x: 0, y: 0, width: 0, height: 0 }], nextCursor: 1, reset: false })
        : ok({ closed: true }));
    const session = await createLiveRelaySession(config, "channel-1");
    try { await expect(session.cues()).resolves.toMatchObject({ cues: [{ clear: true, width: 0, height: 0 }] }); }
    finally { await session.dispose(); }
  });

  it("keeps cue polls serial and stops scheduling when disposed", async () => {
    vi.useFakeTimers();
    let resolveFirst!: (response: Response) => void;
    let requests = 0;
    vi.stubGlobal("fetch", (url: string) => {
      if (url.endsWith("/v1/sessions")) return Promise.resolve(ok(sessionResponse()));
      if (url.includes("/cues?")) {
        requests += 1;
        if (requests === 1) return new Promise<Response>((resolve) => { resolveFirst = resolve; });
        return Promise.resolve(ok({ cues: [], nextCursor: requests, reset: false }));
      }
      return Promise.resolve(ok({ closed: true }));
    });
    const session = await createLiveRelaySession(config, "channel-1");
    const batches: number[] = [];
    session.startCuePolling((batch) => batches.push(batch.nextCursor), undefined, 300);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(requests).toBe(1);
    resolveFirst(ok({ cues: [], nextCursor: 1, reset: false }));
    await vi.advanceTimersByTimeAsync(0);
    expect(batches).toEqual([1]);
    await vi.advanceTimersByTimeAsync(300);
    expect(requests).toBe(2);
    await session.dispose();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(requests).toBe(2);
  });

  it("cancels a pending request on a generation signal, including without AbortController", async () => {
    const controller = new AbortController();
    vi.stubGlobal("AbortController", undefined);
    vi.stubGlobal("fetch", async () => ok(sessionResponse()));
    const session = await createLiveRelaySession(config, "channel-1");
    vi.stubGlobal("fetch", (url: string) => url.endsWith(`/${id}`) ? Promise.resolve(ok({ closed: true })) : new Promise<Response>(() => {}));
    const pending = session.status({ signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow("request was cancelled");
    await session.dispose().catch(() => undefined);
  });

  it("physically aborts a Tizen 3 XHR when a cue poll is disposed", async () => {
    FakeXhr.instances = [];
    vi.stubGlobal("AbortController", undefined);
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    const session = new LiveRelaySession(config, sessionResponse() as RelaySessionCreateResponse);
    session.startCuePolling(() => undefined);
    await Promise.resolve();
    expect(FakeXhr.instances).toHaveLength(1);
    await session.dispose();
    expect(FakeXhr.instances[0]?.aborted).toBe(true);
    expect(FakeXhr.instances[1]?.method).toBe("DELETE");
  });

  it("physically aborts an XHR at the bounded request deadline", async () => {
    vi.useFakeTimers();
    FakeXhr.instances = [];
    vi.stubGlobal("AbortController", undefined);
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    const session = new LiveRelaySession(config, sessionResponse() as RelaySessionCreateResponse);
    const pending = session.status();
    const rejected = expect(pending).rejects.toThrow("did not respond within 10 seconds");
    await vi.advanceTimersByTimeAsync(10_000);
    await rejected;
    expect(FakeXhr.instances[0]?.aborted).toBe(true);
    await session.dispose();
  });

  it("does not advance the cue cursor when an old generation responds late", async () => {
    FakeXhr.instances = [];
    vi.stubGlobal("AbortController", undefined);
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    const session = new LiveRelaySession(config, sessionResponse() as RelaySessionCreateResponse);
    const stopFirst = session.startCuePolling(() => undefined);
    const oldRequest = FakeXhr.instances[0]!;
    stopFirst();
    oldRequest.status = 200;
    oldRequest.responseText = JSON.stringify({ cues: [], nextCursor: 77, reset: false });
    oldRequest.onload?.();
    session.startCuePolling(() => undefined);
    const newRequest = FakeXhr.instances[1]!;
    expect(new URL(newRequest.url).searchParams.get("afterSequence")).toBe("0");
    await session.dispose();
  });

  it("rejects oversized JSON before parsing it", async () => {
    const parseBody = vi.fn(async () => "{}");
    vi.stubGlobal("fetch", async () => ({ ok: true, status: 200, headers: { get: () => String(1024 * 1024 + 1) }, text: parseBody }));
    await expect(createLiveRelaySession(config, "channel-1")).rejects.toThrow("Could not start live subtitle relay session.");
    expect(parseBody).not.toHaveBeenCalled();
  });
});
