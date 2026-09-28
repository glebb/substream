// @ts-nocheck
import { describe, expect, it, vi } from "vitest";
import { loadXtreamCatalogue } from "./companion-service.mjs";

vi.mock("./companion-service.mjs", async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    loadXtreamCatalogue: vi.fn(async () => []),
    resolveXtreamEpisode: vi.fn(async (connection, seriesId, episodeId) => seriesId === "7" && episodeId === "101"
      ? { id: episodeId, kind: "episode", title: "Synthetic Show S01E01", year: null, extension: "mkv", sourceFingerprint: connection.sourceFingerprint }
      : null),
  };
});

const { route } = await import("./companion-server.mjs");
let previousTvCredential = "";

function request(method, value) {
  return {
    method,
    async *[Symbol.asyncIterator]() { yield JSON.stringify(value); },
  };
}

async function callRoute(method, path, body, origin, authorization) {
  const result = { status: 0, headers: {}, body: "" };
  const response = {
    writeHead(status, headers) { result.status = status; result.headers = headers; },
    end(value = "") { result.body = String(value); },
  };
  const input = request(method, body);
  input.headers = { host: "relay.test", ...(origin ? { origin } : {}), ...(authorization ? { authorization } : {}) };
  input.socket = { remoteAddress: "127.0.0.1" };
  await route(input, response, new URL(`http://relay.test${path}`));
  return { ...result, json: () => JSON.parse(result.body) };
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
    });
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
    const postPlay = (selection) => callRoute("POST", "/api/pair/play", { selection }, undefined, `Bearer ${browserCredential}`);
    const base = { title: "Synthetic Movie", year: 2024, extension: "mp4", sourceFingerprint: session.sourceFingerprint };
    const movie = await postPlay({ ...base, kind: "movie", id: "11" });
    expect(movie.status).toBe(200);
    expect(movie.json()).toEqual({ accepted: true });

    const mismatch = await postPlay({ ...base, kind: "movie", id: "12", sourceFingerprint: "vod_mismatch" });
    expect(mismatch.status).toBe(400);

    const foreignEpisode = await postPlay({ ...base, kind: "episode", id: "101", seriesId: "8", title: "Synthetic Show S01E01" });
    expect(foreignEpisode.status).toBe(400);
    expect(foreignEpisode.body).not.toContain("synthetic");
    expect(foreignEpisode.body).not.toContain("fixture");

    const deniedEvents = await callRoute("GET", "/api/pair/events?after=0", undefined, undefined, `Bearer ${browserCredential}`);
    expect(deniedEvents.status).toBe(404);
    const eventResponse = await callRoute("GET", "/api/pair/events?after=0", undefined, undefined, `Bearer ${session.tvCredential}`);
    expect(eventResponse.json().events).toHaveLength(1);
    expect(eventResponse.json().events[0]).toMatchObject({ action: "play", selection: { kind: "movie", id: "11" } });
    expect(eventResponse.body).not.toMatch(/password|streamUrl|fixture/);
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
    expect((await callRoute("GET", "/api/pair/events?after=0", undefined, undefined, `Bearer ${second.tvCredential}`)).status).toBe(200);
  });

  it("single-flights initial and refresh catalogue loads per paired session", async () => {
    let resolveLoad;
    let calls = 0;
    loadXtreamCatalogue.mockReset().mockImplementation(() => {
      calls += 1;
      return new Promise((resolve) => { resolveLoad = resolve; });
    });
    const authorization = await pairedBrowser();
    const initial = [
      callRoute("GET", "/api/catalogue", undefined, undefined, authorization),
      callRoute("GET", "/api/catalogue?refresh=1", undefined, undefined, authorization),
      callRoute("GET", "/api/search?q=example", undefined, undefined, authorization),
    ];
    await vi.waitFor(() => expect(calls).toBe(1));
    resolveLoad([{ id: "1", kind: "movie", title: "Example", searchTitle: "example", year: null, extension: "mp4", category: "Films", sourceFingerprint: "vod_fixture" }]);
    const firstResults = await Promise.all(initial);
    expect(firstResults.map((result) => result.status)).toEqual([200, 200, 200]);
    expect(calls).toBe(1);

    let resolveRefresh;
    loadXtreamCatalogue.mockImplementation(() => {
      calls += 1;
      return new Promise((resolve) => { resolveRefresh = resolve; });
    });
    const refreshing = callRoute("GET", "/api/catalogue?refresh=1", undefined, undefined, authorization);
    await vi.waitFor(() => expect(calls).toBe(2));
    const joinedRefresh = callRoute("GET", "/api/catalogue", undefined, undefined, authorization);
    resolveRefresh([]);
    expect((await Promise.all([refreshing, joinedRefresh])).map((result) => result.status)).toEqual([200, 200]);
    expect(calls).toBe(2);
  });

  it("clears failed catalogue loads so the next caller can retry", async () => {
    let calls = 0;
    loadXtreamCatalogue.mockReset().mockImplementation(async () => {
      calls += 1;
      if (calls === 1) throw new Error("https://provider.invalid/?username=secret&password=secret");
      return [];
    });
    const authorization = await pairedBrowser();
    const failed = await callRoute("GET", "/api/catalogue", undefined, undefined, authorization);
    expect(failed.status).toBe(502);
    expect(failed.body).not.toMatch(/provider\.invalid|secret/);
    expect((await callRoute("GET", "/api/catalogue", undefined, undefined, authorization)).status).toBe(200);
    expect(calls).toBe(2);
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
