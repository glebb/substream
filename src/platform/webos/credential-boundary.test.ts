import { afterEach, expect, it, vi } from "vitest";
import { createAppRuntime } from "../../bootstrap/runtime.ts";
import { fetchProviderPlaylist } from "../browser/provider-fetch.ts";
import { TmdbClient } from "../tmdb/client.ts";
import { OpenSubtitlesClient } from "../opensubtitles/client.ts";
import { createCompanionController } from "../companion/controller.ts";
import { XtreamClient } from "../xtream/client.ts";

afterEach(() => vi.unstubAllGlobals());

it("routes LG client credentials only to their intended services on success and failure", async () => {
  vi.stubGlobal("PalmSystem", {});
  const calls: Array<{ url: URL; headers: Headers; body: string }> = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, headers: new Headers(init?.headers), body: String(init?.body ?? "") });
    if (url.hostname === "provider.example.test") {
      if (calls.length === 1) throw new Error("synthetic private request error");
      return new Response("#EXTM3U");
    }
    return new Response(JSON.stringify({ data: [], results: [] }), { headers: { "Content-Type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetch);
  const runtime = createAppRuntime();
  const playlist = "https://provider.example.test/list?username=fixture-user&password=fixture-password";
  await expect(fetchProviderPlaylist(playlist, {}, runtime.transport.fetch)).rejects.toThrow("Playlist request failed");
  await fetchProviderPlaylist(playlist, {}, runtime.transport.fetch);
  await new TmdbClient({ readAccessToken: "fixture-tmdb-token" }, runtime.transport.fetch).resolve("Example", "movie");
  await new OpenSubtitlesClient("fixture-subtitle-key", runtime.transport.fetch).search({ query: "Example", languages: ["en"] });

  expect(runtime.platform).toBe("webos");
  expect(runtime.capabilities.supportsCompanion).toBe(true);
  expect(runtime.capabilities.supportsLiveRelay).toBe(false);
  expect(calls.length).toBeGreaterThanOrEqual(4);
  for (const { url, headers, body } of calls) {
    expect(["provider.example.test", "api.themoviedb.org", "api.opensubtitles.com"]).toContain(url.hostname);
    if (url.hostname === "provider.example.test") {
      expect(url.searchParams.get("password")).toBe("fixture-password");
      expect(headers.has("Authorization")).toBe(false);
      expect(headers.has("Api-Key")).toBe(false);
    } else {
      expect(url.searchParams.has("password")).toBe(false);
      expect(body).not.toContain("fixture-password");
      if (url.hostname === "api.themoviedb.org") {
        expect(headers.get("Authorization")).toBe("Bearer fixture-tmdb-token");
        expect(headers.has("Api-Key")).toBe(false);
      } else {
        expect(headers.get("Api-Key")).toBe("fixture-subtitle-key");
        expect(headers.has("Authorization")).toBe(false);
      }
    }
  }
});

it("composes LG companion playback with service-scoped auth and locally resolved streams", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("PalmSystem", {});
  const values = new Map<string, string>([
    ["substream.playlist-url", "https://provider.example.test/get.php?username=fixture-user&password=fixture-password"],
    ["substream.companion-url", "http://companion.example.test:8787"],
    ["substream.tmdb-credentials", "fixture-tmdb-token"],
    ["substream.opensubtitles-api-key", "fixture-subtitle-key"],
  ]);
  const preferences = {
    get: (key: string) => values.get(key) ?? null,
    set: (key: string, value: string) => { values.set(key, value); },
    remove: (key: string) => { values.delete(key); },
  };
  const calls: Array<{ url: URL; method: string; headers: Headers; body: string }> = [];
  let pendingPollSignal: AbortSignal | undefined;
  let releasePendingPoll: ((response: Response) => void) | undefined;
  let pendingPollWasAborted = false;
  let eventPolls = 0;
  const playlist = values.get("substream.playlist-url")!;
  const fingerprint = XtreamClient.fromPlaylistUrl(playlist)!.pairingFingerprint();
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const body = String(init?.body ?? "");
    calls.push({ url, method: init?.method ?? "GET", headers, body });
    if (url.pathname === "/api/connect") {
      const request = JSON.parse(body) as { deviceId: string; deviceName: string; sourceFingerprint: string };
      return new Response(JSON.stringify({
        protocolVersion: 4, ...request, tvCredential: "a".repeat(64), pairingCode: "12345678",
        pairingExpiresAt: Date.now() + 300_000, expiresAt: Date.now() + 1_800_000,
        capabilities: { localMedia: true }, paired: true,
      }), { headers: { "Content-Type": "application/json" } });
    }
    if (url.pathname === "/api/pair/events" && eventPolls++ === 0) {
      return new Response(JSON.stringify({ protocolVersion: 4, paired: true, retentionGap: null, events: [
        { sequence: 1, action: "play", selection: {
          kind: "movie", id: "42", title: "Synthetic Film", year: 2022, extension: "mkv", sourceFingerprint: fingerprint,
          streamUrl: "https://attacker.example.test/stream?password=must-not-be-used", password: "must-not-be-used",
        } },
        { sequence: 2, action: "play", selection: {
          kind: "movie", id: "99", title: "Wrong Provider", year: null, extension: "mp4", sourceFingerprint: "vod_other",
        } },
      ] }), { headers: { "Content-Type": "application/json" } });
    }
    if (url.pathname === "/api/pair/ack") {
      const sequence = (JSON.parse(body) as { sequence: number }).sequence;
      return new Response(JSON.stringify({ protocolVersion: 4, acknowledged: sequence }), { headers: { "Content-Type": "application/json" } });
    }
    if (url.pathname === "/api/pair/events") {
      pendingPollSignal = init?.signal ?? undefined;
      init?.signal?.addEventListener("abort", () => { pendingPollWasAborted = true; }, { once: true });
      return await new Promise<Response>((resolve) => {
        releasePendingPoll = resolve;
      });
    }
    throw new Error("Unexpected synthetic companion request");
  });
  const runtime = createAppRuntime({ preferences, transport: { fetch } });
  const controller = createCompanionController(() => playlist, runtime);
  const commands: Array<{ kind: string; title?: { streamUrl: string } }> = [];
  controller.onCommand((command) => commands.push(command as typeof commands[number]));

  try {
    expect(runtime.platform).toBe("webos");
    expect(runtime.capabilities.supportsCompanion).toBe(true);
    controller.configure({ enabled: true, server: "http://companion.example.test:8787", sourceFingerprint: fingerprint });
    for (let index = 0; index < 20 && eventPolls === 0; index++) await Promise.resolve();
    for (let index = 0; index < 20; index++) await Promise.resolve();

    expect(controller.getSnapshot()).toMatchObject({ state: "available", server: "http://companion.example.test:8787" });
    expect(commands).toHaveLength(1);
    expect(commands[0]?.kind).toBe("play");
    const localStream = new URL(commands[0]!.title!.streamUrl);
    expect(localStream.hostname).toBe("provider.example.test");
    expect(localStream.pathname).toContain("/movie/fixture-user/fixture-password/42.mkv");
    expect(controller.getSnapshot().error).toContain("different provider connection");
    expect(calls.map(({ url }) => url.hostname)).toEqual(["companion.example.test", "companion.example.test", "companion.example.test"]);

    const connect = calls.find((call) => call.url.pathname === "/api/connect")!;
    const connectPayload = JSON.parse(connect.body) as Record<string, unknown>;
    expect(connectPayload).toEqual(expect.objectContaining({
      protocolVersion: 4,
      sourceFingerprint: fingerprint,
      capabilities: { localMedia: true },
    }));
    expect(Object.keys(connectPayload).sort()).toEqual(["capabilities", "deviceId", "deviceName", "protocolVersion", "sourceFingerprint"]);
    for (const call of calls) {
      expect(call.url.searchParams.has("password")).toBe(false);
      expect(call.body).not.toContain("fixture-password");
      expect(call.body).not.toContain("fixture-user");
      expect(call.body).not.toContain("fixture-tmdb-token");
      expect(call.body).not.toContain("fixture-subtitle-key");
      if (call.url.pathname !== "/api/connect") {
        expect(call.headers.get("Authorization")).toBe(`Bearer ${"a".repeat(64)}`);
        expect(call.body).not.toContain("streamUrl");
      }
    }

    await vi.advanceTimersByTimeAsync(250);
    for (let index = 0; index < 20 && !pendingPollSignal; index++) await Promise.resolve();
    expect(pendingPollSignal).toBeDefined();
  } finally {
    controller.dispose();
    releasePendingPoll?.(new Response(JSON.stringify({ protocolVersion: 4, paired: true, retentionGap: null, events: [{
      sequence: 3, action: "play", selection: { kind: "movie", id: "43", title: "Late Event", year: null, extension: "mp4", sourceFingerprint: fingerprint },
    }] }), { headers: { "Content-Type": "application/json" } }));
    for (let index = 0; index < 20; index++) await Promise.resolve();
    expect(pendingPollWasAborted).toBe(true);
    vi.useRealTimers();
  }
});
