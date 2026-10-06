// @ts-nocheck
import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
const SOURCE_FINGERPRINT = "vod_syn";

const { route, getRelayMetrics } = await import("./companion-server.mjs");
let previousTvCredential = "";
let lastPairedTvCredential = "";
let lastPairedDeviceId = "";
let lastPairedDeviceName = "";
let deviceCounter = 0;

function request(method, value) {
  const input = new EventEmitter();
  input.method = method;
  input.headers = {};
  input.socket = { remoteAddress: "127.0.0.1" };
  input.destroy = () => {};
  input[Symbol.asyncIterator] = async function* () { yield JSON.stringify(value); };
  return input;
}

async function callRoute(method, path, body, origin, authorization, extraHeaders = {}) {
  const result = { status: 0, headers: {}, body: "" };
  const response = Object.assign(new EventEmitter(), {
    writableFinished: false,
    writableEnded: false,
    writeHead(status, headers) { result.status = status; result.headers = headers; },
    end(value = "") { result.body = String(value); this.writableEnded = true; this.writableFinished = true; this.emit("finish"); this.emit("close"); },
  });
  const routeBody = method === "POST" && path === "/api/connect"
    ? { ...body, capabilities: body?.capabilities ?? { localMedia: true }, deviceId: body?.deviceId ?? "a".repeat(32), deviceName: body?.deviceName ?? "Synthetic TV" }
    : body;
  const input = request(method, routeBody);
  input.headers = { host: "relay.test", ...(origin ? { origin } : {}), ...(authorization ? { authorization } : {}) };
  input.socket = { remoteAddress: "127.0.0.1" };
  Object.assign(input.headers, extraHeaders);
  await route(input, response, new URL(`http://relay.test${path}`));
  return { ...result, input, response, json: () => JSON.parse(result.body) };
}

function pendingEvents(session, wait = 25_000) {
  const result = { status: 0, headers: {}, body: "" };
  const input = request("GET");
  input.headers = { host: "relay.test", authorization: `Bearer ${session.tvCredential}` };
  const response = Object.assign(new EventEmitter(), {
    writableFinished: false,
    writableEnded: false,
    writeHead(status, headers) { result.status = status; result.headers = headers; },
    end(value = "") { result.body = String(value); this.writableEnded = true; this.writableFinished = true; this.emit("finish"); this.emit("close"); },
  });
  const completed = route(input, response, new URL(`http://relay.test/api/pair/events?after=0&wait=${wait}`))
    .then(() => ({ ...result, input, response, json: () => JSON.parse(result.body) }));
  return { input, response, completed };
}

async function callRouteWithRequest(input, path) {
  const result = { status: 0, headers: {}, body: "" };
  const response = {
    writeHead(status, headers) { result.status = status; result.headers = headers; },
    end(value = "") { result.body = String(value); },
  };
  await route(input, response, new URL(`http://relay.test${path}`));
  return { ...result, json: () => JSON.parse(result.body) };
}

async function pairedBrowser() {
  deviceCounter += 1;
  const deviceId = deviceCounter.toString(16).padStart(32, "0");
  const connected = await callRoute("POST", "/api/connect", {
    protocolVersion: 4, sourceFingerprint: SOURCE_FINGERPRINT, deviceId, deviceName: `Synthetic TV ${deviceCounter}`,
  });
  const session = connected.json();
  lastPairedTvCredential = session.tvCredential;
  lastPairedDeviceId = session.deviceId;
  lastPairedDeviceName = session.deviceName;
  const redeemed = await callRoute("POST", "/api/pair/redeem", { protocolVersion: 4, code: session.pairingCode }, "http://localhost:5173");
  return `Bearer ${redeemed.json().browserCredential}`;
}

describe("LAN relay playback route", () => {
  it("accepts packaged TV origins only on TV routes and preserves credential checks", async () => {
    let credential;
    for (const origin of ["file://", "null"]) {
      const preflight = await callRoute("OPTIONS", "/api/connect", undefined, origin, undefined, { "access-control-request-method": "POST" });
      expect(preflight.status).toBe(204);
      expect(preflight.headers["access-control-allow-origin"]).toBe(origin);
      const connected = await callRoute("POST", "/api/connect", {
        protocolVersion: 4, deviceId: "7c".repeat(16), deviceName: "Packaged synthetic TV", sourceFingerprint: "vod_syn",
      }, origin, credential ? `Bearer ${credential}` : undefined);
      expect(connected.status).toBe(200);
      expect(connected.headers["access-control-allow-origin"]).toBe(origin);
      credential = connected.json().tvCredential;
      const events = await callRoute("GET", "/api/pair/events?wait=0&protocolVersion=4", undefined, origin, `Bearer ${credential}`);
      expect(events.status).toBe(200);
      expect(events.headers["access-control-allow-origin"]).toBe(origin);
      expect((await callRoute("POST", "/api/pair/ack", { protocolVersion: 4, sequence: 0 }, origin)).status).toBe(404);
      expect((await callRoute("POST", "/api/pair/ack", { protocolVersion: 4, sequence: 0 }, origin, `Bearer ${credential}`)).status).toBe(200);
      for (const path of ["/api/pair/redeem", "/api/pair/play", "/api/local-media/sessions", "/api/media/prepare"]) {
        const blocked = await callRoute("POST", path, {}, origin, `Bearer ${credential}`);
        expect(blocked.status).toBe(403);
        expect(blocked.headers["access-control-allow-origin"]).toBeUndefined();
        expect((await callRoute("OPTIONS", path, undefined, origin, undefined, { "access-control-request-method": "POST" })).status).toBe(403);
      }
      expect((await callRoute("OPTIONS", "/api/connect", undefined, origin, undefined, { "access-control-request-method": "DELETE" })).status).toBe(403);
      expect((await callRoute("POST", `/api/local-media/sessions/${"e".repeat(32)}/lease`, {}, origin)).status).toBe(404);
      expect((await callRoute("POST", `/api/local-media/sessions/${"e".repeat(32)}/state`, {}, origin)).status).toBe(404);
    }
  });

  it("logs connection rejection metadata without exposing request secrets", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const rejected = await callRoute("POST", "/api/connect", {
        protocolVersion: 3, capabilities: { localMedia: true },
        sourceFingerprint: "vod_private", deviceName: "Private TV name",
        pairingCode: "98765432", playlistUrl: "https://private.invalid/token=secret",
      }, undefined, "Bearer synthetic-secret");
      expect(rejected.status).toBe(400);
      expect(log).toHaveBeenCalledWith('[companion-connect] {"tvProtocol":3,"localMedia":true,"hasSavedCredential":true,"status":400,"result":"protocol-mismatch","relayProtocol":4}');
      expect(JSON.stringify(log.mock.calls)).not.toMatch(/vod_private|Private TV|98765432|private\.invalid|synthetic-secret/);
    } finally { log.mockRestore(); }
  });

  it("logs accepted and rejected connection preflights without request data", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      expect((await callRoute("OPTIONS", "/api/connect", undefined, "null", undefined, { "access-control-request-method": "POST" })).status).toBe(204);
      expect(log).toHaveBeenCalledWith('[companion-connect] {"result":"preflight-accepted","status":204}');
      expect((await callRoute("OPTIONS", "/api/connect", undefined, "https://private.invalid", "Bearer synthetic-secret", { "access-control-request-method": "POST" })).status).toBe(403);
      expect(log).toHaveBeenCalledWith('[companion-connect] {"status":403,"result":"origin-rejected","relayProtocol":4}');
      expect(JSON.stringify(log.mock.calls)).not.toMatch(/private\.invalid|synthetic-secret/);
    } finally { log.mockRestore(); }
  });

  it("coalesces concurrent EPG fetches and serves the cached bounded payload", async () => {
    const originalFetch = globalThis.fetch;
    let resolveFetch;
    const fixture = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00]);
    const fetchMock = vi.fn(() => new Promise((resolve) => { resolveFetch = resolve; }));
    globalThis.fetch = fetchMock;
    try {
      const firstPromise = callRoute("GET", "/api/nordic-epg", undefined, "http://localhost:5173");
      const secondPromise = callRoute("GET", "/api/nordic-epg", undefined, "http://localhost:5173");
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
      resolveFetch(new Response(fixture, { status: 200, headers: { "content-type": "application/gzip" } }));
      const [first, second] = await Promise.all([firstPromise, secondPromise]);
      expect(first.status).toBe(200);
      expect(first.body).toBe(fixture.toString());
      expect(second.body).toBe(first.body);
      expect(first.headers["cache-control"]).toContain("max-age=300");
      const cached = await callRoute("GET", "/api/nordic-epg", undefined, "http://localhost:5173");
      expect(cached.body).toBe(first.body);
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(getRelayMetrics().epg_singleflight_waiter).toBeGreaterThan(0);
      expect(getRelayMetrics().epg_cache_hit).toBeGreaterThan(0);
      expect(JSON.stringify(getRelayMetrics())).not.toMatch(/localhost|epgshare|https?:/i);
    } finally { globalThis.fetch = originalFetch; }
  });

  it("rejects oversized EPG payloads with a credential-safe error", async () => {
    const originalFetch = globalThis.fetch;
    const originalNow = Date.now;
    Date.now = () => originalNow() + 6 * 60 * 1000;
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      headers: { get: () => String(8 * 1024 * 1024 + 1) },
      body: new Response("").body,
    }));
    try {
      const response = await callRoute("GET", "/api/nordic-epg", undefined, "http://localhost:5173");
      expect(response.status).toBe(502);
      expect(response.json()).toEqual({ error: "Nordic EPG is unavailable." });
      expect(response.body).not.toMatch(/epgshare|token|password/i);
    } finally { globalThis.fetch = originalFetch; Date.now = originalNow; }
  });

  it("long-polls until an authenticated browser command is queued", async () => {
    const authorization = await pairedBrowser();
    const current = await callRoute("GET", "/api/active", undefined, undefined, authorization);
    const pending = pendingEvents({ tvCredential: lastPairedTvCredential });
    await vi.waitFor(() => expect(pending.input.listenerCount("aborted")).toBe(1));
    const selection = { kind: "movie", id: "31", title: "Synthetic", year: null, extension: "mp4", sourceFingerprint: current.json().sourceFingerprint };
    expect((await callRoute("POST", "/api/pair/play", { protocolVersion: 4, selection }, undefined, authorization)).status).toBe(200);
    const result = await pending.completed;
    expect(result.status).toBe(200);
    expect(result.json().events).toMatchObject([{ sequence: 1, action: "play", selection: { id: "31" } }]);
    expect(pending.input.listenerCount("aborted")).toBe(0);
    expect(pending.response.listenerCount("close")).toBe(0);
  });

  it("retains delivered events until a valid TV acknowledgement, then reports pruned history", async () => {
    const browserAuthorization = await pairedBrowser();
    const tvCredential = lastPairedTvCredential;
    const tvAuthorization = `Bearer ${tvCredential}`;
    const active = await callRoute("GET", "/api/active", undefined, undefined, browserAuthorization);
    const selection = { kind: "movie", id: "51", title: "Synthetic replay", year: null, extension: "mp4", sourceFingerprint: active.json().sourceFingerprint };
    expect((await callRoute("POST", "/api/pair/play", { protocolVersion: 4, selection }, undefined, browserAuthorization)).status).toBe(200);

    expect((await callRoute("POST", "/api/pair/ack", { protocolVersion: 4, sequence: 1 }, undefined, "Bearer " + "f".repeat(64))).status).toBe(404);
    expect((await callRoute("POST", "/api/pair/ack", { protocolVersion: 4, sequence: 1 }, undefined, browserAuthorization)).status).toBe(404);
    expect((await callRoute("POST", "/api/pair/ack", { protocolVersion: 4, sequence: -1 }, undefined, tvAuthorization)).status).toBe(400);
    expect((await callRoute("POST", "/api/pair/ack", { protocolVersion: 4, sequence: 2 }, undefined, tvAuthorization)).status).toBe(400);
    // The relay must not let a TV acknowledge a command until an events response delivered it.
    expect((await callRoute("POST", "/api/pair/ack", { protocolVersion: 4, sequence: 1 }, undefined, tvAuthorization)).status).toBe(400);

    const first = await callRoute("GET", "/api/pair/events?after=0&wait=0", undefined, undefined, tvAuthorization);
    const replay = await callRoute("GET", "/api/pair/events?after=0&wait=0", undefined, undefined, tvAuthorization);
    expect(first.json().events).toMatchObject([{ sequence: 1, selection: { id: "51" } }]);
    expect(replay.json().events).toEqual(first.json().events);
    const ack = await callRoute("POST", "/api/pair/ack", { protocolVersion: 4, sequence: 1 }, undefined, tvAuthorization);
    expect(ack.status).toBe(200);
    expect(ack.json()).toMatchObject({ acknowledged: 1 });

    const pruned = await callRoute("GET", "/api/pair/events?after=1&wait=0", undefined, undefined, tvAuthorization);
    expect(pruned.json()).toMatchObject({ events: [], retentionGap: null });
    const staleCursor = await callRoute("GET", "/api/pair/events?after=0&wait=0", undefined, undefined, tvAuthorization);
    expect(staleCursor.json()).toMatchObject({ events: [], retentionGap: { throughSequence: 1, firstAvailableSequence: 2 } });
  });

  it("reports queue retention gaps and resumes with retained events", async () => {
    const browserAuthorization = await pairedBrowser();
    const tvAuthorization = `Bearer ${lastPairedTvCredential}`;
    const active = await callRoute("GET", "/api/active", undefined, undefined, browserAuthorization);
    const selection = { kind: "movie", id: "52", title: "Synthetic overflow", year: null, extension: "mp4", sourceFingerprint: active.json().sourceFingerprint };
    for (let index = 0; index < 21; index += 1) {
      expect((await callRoute("POST", "/api/pair/play", { protocolVersion: 4, selection }, undefined, browserAuthorization)).status).toBe(200);
    }
    const response = await callRoute("GET", "/api/pair/events?after=0&wait=0", undefined, undefined, tvAuthorization);
    expect(response.json().retentionGap).toEqual({ throughSequence: 1, firstAvailableSequence: 2 });
    expect(response.json().events).toHaveLength(20);
    expect(response.json().events[0].sequence).toBe(2);
    expect(response.json().events.at(-1).sequence).toBe(21);
    expect((await callRoute("POST", "/api/pair/ack", { protocolVersion: 4, sequence: 1 }, undefined, tvAuthorization)).status).toBe(200);
    const resumed = await callRoute("GET", "/api/pair/events?after=1&wait=0", undefined, undefined, tvAuthorization);
    expect(resumed.json().retentionGap).toBeNull();
    expect(resumed.json().events[0].sequence).toBe(2);
    expect(resumed.json().events).toHaveLength(20);
  });

  it("times out and removes disconnected waiters", async () => {
    await pairedBrowser();
    const tvCredential = lastPairedTvCredential;
    const timed = pendingEvents({ tvCredential }, 8);
    const timeoutResult = await timed.completed;
    expect(timeoutResult.status).toBe(200);
    expect(timeoutResult.json()).toMatchObject({ events: [], paired: true });
    expect(timed.input.listenerCount("aborted")).toBe(0);

    const disconnected = pendingEvents({ tvCredential });
    await vi.waitFor(() => expect(disconnected.input.listenerCount("aborted")).toBe(1));
    disconnected.input.emit("aborted");
    await disconnected.completed;
    expect(disconnected.input.listenerCount("aborted")).toBe(0);
    expect(disconnected.response.listenerCount("close")).toBe(0);
  });

  it("keeps a paired TV identity and browser credential stable across renewal", async () => {
    const browserAuthorization = await pairedBrowser();
    const tvCredential = lastPairedTvCredential;
    const pending = pendingEvents({ tvCredential });
    await vi.waitFor(() => expect(pending.input.listenerCount("aborted")).toBe(1));
    const renewal = await callRoute("POST", "/api/connect", {
      protocolVersion: 4, sourceFingerprint: SOURCE_FINGERPRINT, deviceId: lastPairedDeviceId, deviceName: lastPairedDeviceName,
    }, undefined, `Bearer ${tvCredential}`);
    expect(renewal.status).toBe(200);
    expect(renewal.json()).toMatchObject({ paired: true, deviceId: lastPairedDeviceId, tvCredential });
    expect(renewal.json().pairingCode).toBe("");
    const active = await callRoute("GET", "/api/active", undefined, undefined, browserAuthorization);
    expect(active.status).toBe(200);
    expect(active.json().deviceId).toBe(lastPairedDeviceId);
    const selection = { kind: "movie", id: "77", title: "Renewed", year: null, extension: "mp4", sourceFingerprint: SOURCE_FINGERPRINT };
    expect((await callRoute("POST", "/api/pair/play", { protocolVersion: 4, selection }, undefined, browserAuthorization)).status).toBe(200);
    const result = await pending.completed;
    expect(result.status).toBe(200);
    expect(result.json().events).toMatchObject([{ selection: { id: "77" } }]);
    expect(pending.input.listenerCount("aborted")).toBe(0);
  });

  it("rejects declared and streamed oversized request bodies before parsing them", async () => {
    let declaredBodyRead = false;
    let declaredDestroyed = false;
    const declared = {
      method: "POST",
      headers: { host: "relay.test", "content-length": String(128 * 1024 + 1) },
      socket: { remoteAddress: "127.0.0.1" },
      destroy() { declaredDestroyed = true; },
      async *[Symbol.asyncIterator]() { declaredBodyRead = true; yield "{}"; },
    };
    const declaredResult = await callRouteWithRequest(declared, "/api/pair/select");
    expect(declaredResult.status).toBe(400);
    expect(declaredDestroyed).toBe(true);
    expect(declaredBodyRead).toBe(false);

    let streamedDestroyed = false;
    let chunksRead = 0;
    const streamed = {
      method: "POST",
      headers: { host: "relay.test" },
      socket: { remoteAddress: "127.0.0.1" },
      destroy() { streamedDestroyed = true; },
      async *[Symbol.asyncIterator]() {
        chunksRead += 1; yield Buffer.alloc(128 * 1024, 0x20);
        chunksRead += 1; yield Buffer.from(" ");
        chunksRead += 1; yield Buffer.from("ignored");
      },
    };
    const streamedResult = await callRouteWithRequest(streamed, "/api/pair/select");
    expect(streamedResult.status).toBe(400);
    expect(streamedDestroyed).toBe(true);
    expect(chunksRead).toBe(2);
  });

  it("accepts identifier-only movie and episode commands and rejects a fingerprint mismatch", async () => {
    const connected = await callRoute("POST", "/api/connect", {
      protocolVersion: 4, sourceFingerprint: SOURCE_FINGERPRINT,
    }, undefined, previousTvCredential ? `Bearer ${previousTvCredential}` : undefined);
    const session = connected.json();
    previousTvCredential = session.tvCredential;
    expect(connected.status).toBe(200);
    expect(session.sourceFingerprint).toBe(SOURCE_FINGERPRINT);
    expect(connected.body).not.toMatch(/username|password|playlistUrl|iptv\.invalid/);

    expect(session.tvCredential).toMatch(/^[a-f0-9]{64}$/);
    expect(session.pairingCode).toMatch(/^\d{8}$/);
    const redeemed = await callRoute("POST", "/api/pair/redeem", { protocolVersion: 4, code: session.pairingCode }, "http://localhost:5173");
    const browserCredential = redeemed.json().browserCredential;
    expect(browserCredential).toMatch(/^[a-f0-9]{64}$/);
    expect((await callRoute("POST", "/api/pair/redeem", { protocolVersion: 4, code: session.pairingCode }, "http://localhost:5173")).status).toBe(400);
    const postPlay = (selection, protocolVersion = 4) => callRoute("POST", "/api/pair/play", { protocolVersion, selection }, undefined, `Bearer ${browserCredential}`);
    const base = { title: "Synthetic Movie", year: 2024, extension: "mp4", sourceFingerprint: session.sourceFingerprint };
    const movie = await postPlay({ ...base, kind: "movie", id: "11", streamUrl: "https://private.invalid/token=fixture", tvCredential: "fixture" });
    expect(movie.status).toBe(200);
    expect(movie.json()).toEqual({ protocolVersion: 4, accepted: true });

    expect((await postPlay({ ...base, kind: "movie", id: "13" }, 2)).status).toBe(400);

    const mismatch = await postPlay({ ...base, kind: "movie", id: "12", sourceFingerprint: "vod_mismatch" });
    expect(mismatch.status).toBe(400);

    const episode = await postPlay({ ...base, kind: "episode", id: "101", seriesId: "8", title: "Synthetic Show S01E01", season: 1, episode: 1, extension: "mkv" });
    expect(episode.status).toBe(200);

    const deniedEvents = await callRoute("GET", "/api/pair/events?after=0", undefined, undefined, `Bearer ${browserCredential}`);
    expect(deniedEvents.status).toBe(404);
    const eventResponse = await callRoute("GET", "/api/pair/events?after=0", undefined, undefined, `Bearer ${session.tvCredential}`);
    expect(eventResponse.json().protocolVersion).toBe(4);
    expect(eventResponse.json().events).toHaveLength(2);
    expect(eventResponse.json().events[0]).toMatchObject({ action: "play", selection: { kind: "movie", id: "11" } });
    expect(eventResponse.body).not.toMatch(/username|password|playlistUrl|streamUrl|private\.invalid|tvCredential/);
    expect(eventResponse.json().events.at(-1)).toMatchObject({ action: "play", selection: { kind: "episode", id: "101", seriesId: "8", season: 1, episode: 1, extension: "mkv", sourceFingerprint: SOURCE_FINGERPRINT } });
  });

  it("keeps per-TV credentials private and rejects browser credentials for TV polling", async () => {
    const device = { deviceId: "d".repeat(32), deviceName: "Credential Test TV" };
    const firstConnection = await callRoute("POST", "/api/connect", { protocolVersion: 4, sourceFingerprint: SOURCE_FINGERPRINT, ...device });
    expect(firstConnection.status).toBe(200);
    const first = firstConnection.json();
    previousTvCredential = first.tvCredential;
    const unpairedActive = await callRoute("GET", "/api/active");
    expect(unpairedActive.status).toBe(404);
    expect(unpairedActive.body).not.toContain(first.sourceFingerprint);
    expect(unpairedActive.body).not.toContain(String(first.expiresAt));
    expect(unpairedActive.body).not.toContain(first.tvCredential);
    expect(unpairedActive.body).not.toMatch(/\b\d{8}\b/);
    expect((await callRoute("GET", "/api/active", undefined, undefined, `Bearer ${first.tvCredential}`)).status).toBe(404);
    const firstPair = await callRoute("POST", "/api/pair/redeem", { protocolVersion: 4, code: first.pairingCode }, "http://localhost:5173");
    const active = await callRoute("GET", "/api/active", undefined, undefined, `Bearer ${firstPair.json().browserCredential}`);
    expect(active.status).toBe(200);
    expect(active.body).not.toContain(first.tvCredential);
    expect(active.body).not.toContain(firstPair.json().browserCredential);
    expect(active.json()).not.toHaveProperty("sessionId");
    const deniedReplacement = await callRoute("POST", "/api/connect", { protocolVersion: 4, sourceFingerprint: SOURCE_FINGERPRINT, ...device });
    expect(deniedReplacement.status).toBe(404);
    expect(deniedReplacement.body).not.toMatch(/session|credential|fingerprint/i);
    expect((await callRoute("GET", "/api/active", undefined, undefined, `Bearer ${firstPair.json().browserCredential}`)).json()).toMatchObject(active.json());
    const renewed = await callRoute("POST", "/api/connect", { protocolVersion: 4, sourceFingerprint: SOURCE_FINGERPRINT, ...device }, undefined, `Bearer ${first.tvCredential}`);
    expect(renewed.json()).toMatchObject({ deviceId: device.deviceId, paired: true, tvCredential: first.tvCredential });
    expect((await callRoute("GET", "/api/active", undefined, undefined, `Bearer ${firstPair.json().browserCredential}`)).status).toBe(200);
    expect((await callRoute("GET", "/api/pair/events?after=0", undefined, undefined, `Bearer ${firstPair.json().browserCredential}`)).status).toBe(404);
    expect((await callRoute("GET", "/api/pair/events?after=0&wait=0", undefined, undefined, `Bearer ${first.tvCredential}`)).status).toBe(200);
  });

  it("does not expose relay catalogue or search APIs", async () => {
    expect((await callRoute("GET", "/api/catalogue")).status).toBe(404);
    expect((await callRoute("GET", "/api/search?q=synthetic")).status).toBe(404);
  });

  it("keeps multiple named TV identities and command queues isolated", async () => {
    const firstDevice = { deviceId: "b".repeat(32), deviceName: "Living room" };
    const secondDevice = { deviceId: "c".repeat(32), deviceName: "Bedroom" };
    const first = (await callRoute("POST", "/api/connect", { protocolVersion: 4, sourceFingerprint: SOURCE_FINGERPRINT, ...firstDevice })).json();
    const second = (await callRoute("POST", "/api/connect", { protocolVersion: 4, sourceFingerprint: SOURCE_FINGERPRINT, ...secondDevice })).json();
    expect(first).toMatchObject(firstDevice);
    expect(second).toMatchObject(secondDevice);

    const firstBrowser = `Bearer ${(await callRoute("POST", "/api/pair/redeem", { protocolVersion: 4, code: first.pairingCode }, "http://localhost:5173")).json().browserCredential}`;
    const secondBrowser = `Bearer ${(await callRoute("POST", "/api/pair/redeem", { protocolVersion: 4, code: second.pairingCode }, "http://localhost:5173")).json().browserCredential}`;
    expect((await callRoute("GET", "/api/active", undefined, undefined, firstBrowser)).json().deviceId).toBe(firstDevice.deviceId);
    expect((await callRoute("GET", "/api/active", undefined, undefined, secondBrowser)).json().deviceId).toBe(secondDevice.deviceId);

    const selection = { kind: "movie", id: "808", title: "Targeted", year: null, extension: "mp4", sourceFingerprint: SOURCE_FINGERPRINT };
    expect((await callRoute("POST", "/api/pair/play", { protocolVersion: 4, selection }, undefined, firstBrowser)).status).toBe(200);
    const firstEvents = await callRoute("GET", "/api/pair/events?after=0&wait=0", undefined, undefined, `Bearer ${first.tvCredential}`);
    const secondEvents = await callRoute("GET", "/api/pair/events?after=0&wait=0", undefined, undefined, `Bearer ${second.tvCredential}`);
    expect(firstEvents.json().events).toMatchObject([{ selection: { id: "808" } }]);
    expect(secondEvents.json().events).toEqual([]);

    const reset = await callRoute("POST", "/api/pair/reset", { protocolVersion: 4 }, undefined, `Bearer ${first.tvCredential}`);
    expect(reset.status).toBe(200);
    expect(reset.json()).toMatchObject({ deviceId: firstDevice.deviceId, pairingCode: expect.stringMatching(/^\d{8}$/) });
    expect((await callRoute("GET", "/api/active", undefined, undefined, firstBrowser)).status).toBe(404);
    expect((await callRoute("GET", "/api/active", undefined, undefined, secondBrowser)).status).toBe(200);
  });

  it("exposes the public guide only as a credential-free CORS bridge", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      headers: { get: (name) => name === "content-length" ? "3" : null },
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const result = await callRoute("GET", "/api/nordic-epg", undefined, "http://localhost:5173");
      expect(result.status).toBe(200);
      expect(result.headers).toMatchObject({ "content-type": "application/gzip", "access-control-allow-origin": "http://localhost:5173" });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects state-changing requests from origins outside the configured allow-list", async () => {
    const response = await callRoute("POST", "/api/connect", {
      protocolVersion: 4, sourceFingerprint: SOURCE_FINGERPRINT,
    }, "https://attacker.invalid");
    expect(response.status).toBe(403);
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("answers preflight only for configured browser origins", async () => {
    const allowed = await callRoute("OPTIONS", "/api/connect", undefined, "http://localhost:5173");
    const rejected = await callRoute("OPTIONS", "/api/connect", undefined, "https://attacker.invalid");
    expect(allowed.status).toBe(204);
    expect(allowed.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
    expect(rejected.status).toBe(403);
    expect(rejected.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
