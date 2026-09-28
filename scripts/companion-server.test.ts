// @ts-nocheck
import { describe, expect, it, vi } from "vitest";

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

function request(method, value) {
  return {
    method,
    async *[Symbol.asyncIterator]() { yield JSON.stringify(value); },
  };
}

async function callRoute(method, path, body, origin) {
  const result = { status: 0, headers: {}, body: "" };
  const response = {
    writeHead(status, headers) { result.status = status; result.headers = headers; },
    end(value = "") { result.body = String(value); },
  };
  const input = request(method, body);
  input.headers = { host: "relay.test", ...(origin ? { origin } : {}) };
  await route(input, response, new URL(`http://relay.test${path}`));
  return { ...result, json: () => JSON.parse(result.body) };
}

describe("LAN relay playback route", () => {
  it("accepts a movie, rejects a fingerprint mismatch, and rejects an episode outside its series", async () => {
    const connected = await callRoute("POST", "/api/connect", {
      playlistUrl: "https://iptv.invalid/get.php?username=synthetic&password=fixture",
    });
    const session = connected.json();
    expect(connected.status).toBe(200);
    expect(session.sourceFingerprint).toMatch(/^vod_/);
    expect(JSON.stringify(session)).not.toContain("fixture");

    const postPlay = (selection) => callRoute("POST", "/api/pair/play", { sessionId: session.sessionId, selection });
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

    const eventResponse = await callRoute("GET", `/api/pair/events?sessionId=${encodeURIComponent(session.sessionId)}&after=0`);
    expect(eventResponse.json().events).toHaveLength(1);
    expect(eventResponse.json().events[0]).toMatchObject({ action: "play", selection: { kind: "movie", id: "11" } });
    expect(eventResponse.body).not.toMatch(/password|streamUrl|fixture/);
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
