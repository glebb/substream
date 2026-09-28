// @ts-nocheck
import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
vi.mock("./companion-service.mjs", async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    resolveXtreamEpisode: vi.fn(async (connection, seriesId, episodeId) => seriesId === "7" && episodeId === "101"
      ? { id: episodeId, kind: "episode", title: "Synthetic Show S01E01", year: null, extension: "mkv", sourceFingerprint: connection.sourceFingerprint }
      : null),
  };
});

const { route } = await import("./companion-server.mjs");
let previousTvCredential = "";

function request(method, value) {
  const input = new EventEmitter();
  input.method = method;
  input.headers = {};
  input.socket = { remoteAddress: "127.0.0.1" };
  input.destroy = () => {};
  input[Symbol.asyncIterator] = async function* () { yield JSON.stringify(value); };
  return input;
}

async function callRoute(method, path, body, origin, authorization) {
  const result = { status: 0, headers: {}, body: "" };
  const response = Object.assign(new EventEmitter(), {
    writableFinished: false,
    writableEnded: false,
    writeHead(status, headers) { result.status = status; result.headers = headers; },
    end(value = "") { result.body = String(value); this.writableEnded = true; this.writableFinished = true; this.emit("finish"); this.emit("close"); },
  });
  const input = request(method, body);
  input.headers = { host: "relay.test", ...(origin ? { origin } : {}), ...(authorization ? { authorization } : {}) };
  input.socket = { remoteAddress: "127.0.0.1" };
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
  const connected = await callRoute("POST", "/api/connect", {
    playlistUrl: "https://iptv.invalid/get.php?username=synthetic&password=fixture",
  }, undefined, previousTvCredential ? `Bearer ${previousTvCredential}` : undefined);
  const session = connected.json();
  previousTvCredential = session.tvCredential;
  const redeemed = await callRoute("POST", "/api/pair/redeem", { code: session.pairingCode }, "http://localhost:5173");
  return `Bearer ${redeemed.json().browserCredential}`;
}

describe("LAN relay playback route", () => {
  it("long-polls until an authenticated browser command is queued", async () => {
    const authorization = await pairedBrowser();
    const current = await callRoute("GET", "/api/active", undefined, undefined, authorization);
    const pending = pendingEvents({ tvCredential: previousTvCredential });
    await vi.waitFor(() => expect(pending.input.listenerCount("aborted")).toBe(1));
    const selection = { kind: "movie", id: "31", title: "Synthetic", year: null, extension: "mp4", sourceFingerprint: current.json().sourceFingerprint };
    expect((await callRoute("POST", "/api/pair/play", { protocolVersion: 1, selection }, undefined, authorization)).status).toBe(200);
    const result = await pending.completed;
    expect(result.status).toBe(200);
    expect(result.json().events).toMatchObject([{ sequence: 1, action: "play", selection: { id: "31" } }]);
    expect(pending.input.listenerCount("aborted")).toBe(0);
    expect(pending.response.listenerCount("close")).toBe(0);
  });

  it("times out and removes disconnected waiters", async () => {
    await pairedBrowser();
    const tvCredential = previousTvCredential;
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

  it("ends a pending poll when the TV session is replaced", async () => {
    await pairedBrowser();
    const tvCredential = previousTvCredential;
    const pending = pendingEvents({ tvCredential });
    await vi.waitFor(() => expect(pending.input.listenerCount("aborted")).toBe(1));
    const replacement = await callRoute("POST", "/api/connect", { playlistUrl: "https://iptv.invalid/get.php?username=synthetic&password=fixture" }, undefined, `Bearer ${tvCredential}`);
    previousTvCredential = replacement.json().tvCredential;
    const result = await pending.completed;
    expect(result.status).toBe(404);
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

  it("accepts a movie, rejects a fingerprint mismatch, and rejects an episode outside its series", async () => {
    const connected = await callRoute("POST", "/api/connect", {
      playlistUrl: "https://iptv.invalid/get.php?username=synthetic&password=fixture",
    }, undefined, previousTvCredential ? `Bearer ${previousTvCredential}` : undefined);
    const session = connected.json();
    previousTvCredential = session.tvCredential;
    expect(connected.status).toBe(200);
    expect(session.sourceFingerprint).toMatch(/^vod_/);
    expect(JSON.stringify(session)).not.toContain("fixture");

    expect(session.tvCredential).toMatch(/^[a-f0-9]{64}$/);
    expect(session.pairingCode).toMatch(/^\d{8}$/);
    const redeemed = await callRoute("POST", "/api/pair/redeem", { code: session.pairingCode }, "http://localhost:5173");
    const browserCredential = redeemed.json().browserCredential;
    expect(browserCredential).toMatch(/^[a-f0-9]{64}$/);
    expect((await callRoute("POST", "/api/pair/redeem", { code: session.pairingCode }, "http://localhost:5173")).status).toBe(400);
    const postPlay = (selection, protocolVersion = 1) => callRoute("POST", "/api/pair/play", { protocolVersion, selection }, undefined, `Bearer ${browserCredential}`);
    const base = { title: "Synthetic Movie", year: 2024, extension: "mp4", sourceFingerprint: session.sourceFingerprint };
    const movie = await postPlay({ ...base, kind: "movie", id: "11", streamUrl: "https://private.invalid/token=fixture", tvCredential: "fixture" });
    expect(movie.status).toBe(200);
    expect(movie.json()).toEqual({ protocolVersion: 1, accepted: true });

    expect((await postPlay({ ...base, kind: "movie", id: "13" }, 2)).status).toBe(400);

    const mismatch = await postPlay({ ...base, kind: "movie", id: "12", sourceFingerprint: "vod_mismatch" });
    expect(mismatch.status).toBe(400);

    const foreignEpisode = await postPlay({ ...base, kind: "episode", id: "101", seriesId: "8", title: "Synthetic Show S01E01" });
    expect(foreignEpisode.status).toBe(400);
    expect(foreignEpisode.body).not.toContain("synthetic");
    expect(foreignEpisode.body).not.toContain("fixture");

    const deniedEvents = await callRoute("GET", "/api/pair/events?after=0", undefined, undefined, `Bearer ${browserCredential}`);
    expect(deniedEvents.status).toBe(404);
    const eventResponse = await callRoute("GET", "/api/pair/events?after=0", undefined, undefined, `Bearer ${session.tvCredential}`);
    expect(eventResponse.json().protocolVersion).toBe(1);
    expect(eventResponse.json().events).toHaveLength(1);
    expect(eventResponse.json().events[0]).toMatchObject({ action: "play", selection: { kind: "movie", id: "11" } });
    expect(eventResponse.body).not.toMatch(/password|streamUrl|fixture|private\.invalid|tvCredential/);
  });

  it("keeps TV credentials private, replaces old sessions, and rejects browser credentials for TV polling", async () => {
    const firstConnection = await callRoute("POST", "/api/connect", { playlistUrl: "https://iptv.invalid/get.php?username=synthetic&password=fixture" }, undefined, `Bearer ${previousTvCredential}`);
    expect(firstConnection.status).toBe(200);
    const first = firstConnection.json();
    previousTvCredential = first.tvCredential;
    const unpairedActive = await callRoute("GET", "/api/active");
    expect(unpairedActive.status).toBe(404);
    expect(unpairedActive.body).not.toContain(first.sourceFingerprint);
    expect(unpairedActive.body).not.toContain(String(first.expiresAt));
    expect(unpairedActive.body).not.toContain(first.tvCredential);
    expect(unpairedActive.body).not.toContain(first.pairingCode);
    expect((await callRoute("GET", "/api/active", undefined, undefined, `Bearer ${first.tvCredential}`)).status).toBe(404);
    const firstPair = await callRoute("POST", "/api/pair/redeem", { code: first.pairingCode }, "http://localhost:5173");
    const active = await callRoute("GET", "/api/active", undefined, undefined, `Bearer ${firstPair.json().browserCredential}`);
    expect(active.status).toBe(200);
    expect(active.body).not.toContain(first.tvCredential);
    expect(active.body).not.toContain(firstPair.json().browserCredential);
    expect(active.json()).not.toHaveProperty("sessionId");
    const deniedReplacement = await callRoute("POST", "/api/connect", { playlistUrl: "https://iptv.invalid/get.php?username=synthetic&password=fixture" });
    expect(deniedReplacement.status).toBe(404);
    expect(deniedReplacement.body).not.toMatch(/session|credential|fingerprint/i);
    expect((await callRoute("GET", "/api/active", undefined, undefined, `Bearer ${firstPair.json().browserCredential}`)).json()).toMatchObject(active.json());
    const second = (await callRoute("POST", "/api/connect", { playlistUrl: "https://iptv.invalid/get.php?username=synthetic&password=fixture" }, undefined, `Bearer ${first.tvCredential}`)).json();
    previousTvCredential = second.tvCredential;
    const oldRedeem = await callRoute("POST", "/api/pair/redeem", { code: first.pairingCode }, "http://localhost:5173");
    expect(oldRedeem.status).toBe(400);
    const currentRedeem = await callRoute("POST", "/api/pair/redeem", { code: second.pairingCode }, "http://localhost:5173");
    expect(currentRedeem.status).toBe(200);
    expect((await callRoute("GET", "/api/pair/events?after=0", undefined, undefined, `Bearer ${first.tvCredential}`)).status).toBe(404);
    expect((await callRoute("GET", "/api/pair/events?after=0", undefined, undefined, `Bearer ${currentRedeem.json().browserCredential}`)).status).toBe(404);
    expect((await callRoute("GET", "/api/pair/events?after=0&wait=0", undefined, undefined, `Bearer ${second.tvCredential}`)).status).toBe(200);
  });

  it("does not expose relay catalogue or search APIs", async () => {
    expect((await callRoute("GET", "/api/catalogue")).status).toBe(404);
    expect((await callRoute("GET", "/api/search?q=synthetic")).status).toBe(404);
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
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects state-changing requests from origins outside the configured allow-list", async () => {
    const response = await callRoute("POST", "/api/connect", {
      playlistUrl: "https://iptv.invalid/get.php?username=synthetic&password=fixture",
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
