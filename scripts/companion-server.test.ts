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

async function callRoute(method, path, body) {
  const result = { status: 0, headers: {}, body: "" };
  const response = {
    writeHead(status, headers) { result.status = status; result.headers = headers; },
    end(value = "") { result.body = String(value); },
  };
  await route(request(method, body), response, new URL(`http://relay.test${path}`));
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
});
