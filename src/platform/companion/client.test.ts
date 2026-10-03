import { describe, expect, it } from "vitest";
import { vi } from "vitest";

vi.mock("../package-defaults.ts", () => ({ packageDefaults: {
  companionServerUrl: "http://192.0.2.44:8787",
} }));

import { acknowledgeCompanionEvents, companionDeviceIdentity, companionDeviceLabel, companionEvents, companionSelectionTitle, companionServerUrl, connectCompanionService, getCompanionConnection, redeemCompanionCode, resetCompanionPairing, saveCompanionDeviceLabel, saveCompanionServerUrl, sendCompanionPlayback, sendStopLocalCompanionPlayback, stageLocalMedia, storedCompanionTvCredential, storeCompanionTvCredential } from "./client.ts";

describe("companion client", () => {
  const identity = { deviceId: "a".repeat(32), deviceName: "Test TV" };
  it.each(["fetch", "json", "reset"])("times out a stalled %s on Tizen 3 without AbortController and permits retry", async (stage) => {
    vi.useFakeTimers();
    vi.stubGlobal("AbortController", undefined);
    const hung = new Promise<never>(() => {});
    const request = vi.fn<() => Promise<unknown>>(async () => stage === "json" ? { ok: true, json: () => hung } : hung);
    vi.stubGlobal("fetch", request);
    try {
      const operation = stage === "reset"
        ? resetCompanionPairing("http://192.0.2.44:8787", "a".repeat(64))
        : connectCompanionService("http://192.0.2.44:8787", "vod_test", identity);
      const rejected = expect(operation).rejects.toThrow("Companion service did not respond within 10 seconds.");
      await vi.advanceTimersByTimeAsync(10_000);
      await rejected;
      expect(vi.getTimerCount()).toBe(0);
      request.mockImplementation(async () => ({ ok: true, json: async () => ({
        protocolVersion: 4, ...identity, tvCredential: "a".repeat(64), pairingCode: "01234567", pairingExpiresAt: 10,
        expiresAt: 20, paired: false, sourceFingerprint: "vod_test", capabilities: { localMedia: true },
      }) }));
      await expect(connectCompanionService("http://192.0.2.44:8787", "vod_test", identity)).resolves.toMatchObject(identity);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); vi.unstubAllGlobals(); }
  });
  it("uses the non-secret companion address embedded from local configuration", () => {
    expect(companionServerUrl()).toBe("http://192.0.2.44:8787");
  });

  it("falls back to the packaged address when local storage access is denied", () => {
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked storage details"); } });
    try {
      expect(companionServerUrl()).toBe("http://192.0.2.44:8787");
    } finally { vi.unstubAllGlobals(); }
  });

  it("saves only a validated relay origin", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) });
    try {
      expect(saveCompanionServerUrl(" http://192.0.2.55:8787/path?q=1 ")).toBe("http://192.0.2.55:8787");
      expect(values.get("substream.companion-url")).toBe("http://192.0.2.55:8787");
      expect(saveCompanionServerUrl("https://relay.home.arpa:8787")).toBe("https://relay.home.arpa:8787");
      expect(() => saveCompanionServerUrl("http://user:pass@192.0.2.55:8787")).toThrow("cannot contain credentials");
    } finally { vi.unstubAllGlobals(); }
  });

  it("keeps a stable per-TV identity and scopes its reconnect credential by relay origin", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) });
    try {
      const first = companionDeviceIdentity();
      expect(companionDeviceIdentity()).toEqual(first);
      expect(first.deviceName).toMatch(/^TV-[A-F0-9]{4}$/);
      storeCompanionTvCredential("https://relay.home.arpa:8787", "a".repeat(64));
      expect(storedCompanionTvCredential("https://relay.home.arpa:8787")).toBe("a".repeat(64));
      expect(storedCompanionTvCredential("https://other.home.arpa:8787")).toBe("");
      saveCompanionDeviceLabel(first.deviceId, "Kitchen");
      expect(companionDeviceLabel(first.deviceId, first.deviceName)).toBe("Kitchen");
    } finally { vi.unstubAllGlobals(); }
  });

  it("distinguishes an unreachable relay from a reachable relay with no TV", async () => {
    const browserCredential = "b".repeat(64);
    vi.stubGlobal("fetch", async () => { throw new Error("private network detail"); });
    try { await expect(getCompanionConnection("http://192.0.2.44:8787", browserCredential)).rejects.toMatchObject({ kind: "unreachable" }); }
    finally { vi.unstubAllGlobals(); }
    vi.stubGlobal("fetch", async () => ({ status: 404, ok: false, json: async () => ({ error: "No TV is connected." }) }));
    try { await expect(getCompanionConnection("http://192.0.2.44:8787", browserCredential)).rejects.toMatchObject({ kind: "no-tv" }); }
    finally { vi.unstubAllGlobals(); }
  });

  it("sends the browser credential when reading active TV status", async () => {
    let authorization = "";
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      authorization = (init?.headers as Record<string, string>)?.authorization ?? "";
      return { status: 200, ok: true, json: async () => ({ protocolVersion: 4, ...identity, expiresAt: Date.now() + 10_000, sourceFingerprint: "vod_test", capabilities: { localMedia: true } }) };
    });
    try {
      const credential = "b".repeat(64);
      await expect(getCompanionConnection("http://192.0.2.44:8787", credential)).resolves.toMatchObject({ sourceFingerprint: "vod_test" });
      expect(authorization).toBe(`Bearer ${credential}`);
    } finally { vi.unstubAllGlobals(); }
  });

  it("sends the current TV credential when rotating its session", async () => {
    let authorization = "";
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      authorization = (init?.headers as Record<string, string>)?.authorization ?? "";
      return { ok: true, json: async () => ({
        ...identity, tvCredential: "a".repeat(64), pairingCode: "01234567", pairingExpiresAt: Date.now() + 60_000, paired: false,
        protocolVersion: 4, expiresAt: Date.now() + 30 * 60_000, sourceFingerprint: "vod_test", capabilities: { localMedia: true },
      }) };
    });
    try {
      const previous = "t".repeat(64);
      await connectCompanionService("http://192.0.2.44:8787", "vod_test", identity, previous);
      expect(authorization).toBe(`Bearer ${previous}`);
    } finally { vi.unstubAllGlobals(); }
  });

  it("registers only a validated account-aware source fingerprint", async () => {
    let body = "";
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      body = String(init?.body ?? "");
      return { ok: true, json: async () => ({ protocolVersion: 4, ...identity, tvCredential: "a".repeat(64), pairingCode: "01234567", pairingExpiresAt: 10, expiresAt: 20, sourceFingerprint: "vod_test", capabilities: { localMedia: true }, paired: false }) };
    });
    try {
      await connectCompanionService("http://192.0.2.44:8787", "vod_test", identity);
      expect(JSON.parse(body)).toEqual({ protocolVersion: 4, sourceFingerprint: "vod_test", capabilities: { localMedia: true }, deviceId: identity.deviceId, deviceName: identity.deviceName });
      expect(body).not.toMatch(/username|password|playlistUrl|streamUrl|iptv\.invalid/);
      await expect(connectCompanionService("http://192.0.2.44:8787", "https://iptv.invalid/get.php?username=user&password=secret", identity))
        .rejects.toThrow("Provider source identity is invalid.");
    } finally { vi.unstubAllGlobals(); }
  });

  it("sanitizes malformed network response errors", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: false, json: async () => { throw new Error("https://private.invalid/token=secret"); } }));
    try {
      await expect(connectCompanionService("http://192.0.2.44:8787", "vod_test", identity))
        .rejects.toThrow("Companion service response was unavailable or invalid.");
      await expect(sendCompanionPlayback("http://192.0.2.44:8787", "session", { kind: "movie", id: "42", title: "Example", year: null, extension: "mp4", sourceFingerprint: "vod_x" }))
        .rejects.toThrow("Could not send playback to the TV.");
    } finally { vi.unstubAllGlobals(); }
  });

  it.each([
    [400, "Companion protocol version is unsupported.", "TV app and LAN service versions do not match."],
    [400, "Local media capability negotiation is required.", "TV app and LAN service versions do not match."],
    [404, "Companion connection could not be established.", "The LAN service rejected this TV's saved pairing."],
    [403, "Request origin is not allowed.", "The LAN service rejected this app's origin."],
    [503, "The relay has reached its TV connection limit.", "The LAN service has reached its TV connection limit."],
    [500, "https://private.invalid/token=secret", "TV connection could not be established."],
  ])("reports safe actionable connection errors for status %s", async (status, error, message) => {
    vi.stubGlobal("fetch", async () => ({ status, ok: false, json: async () => ({ error }) }));
    try {
      await expect(connectCompanionService("http://192.0.2.44:8787", "vod_test", identity)).rejects.toThrow(message);
    } finally { vi.unstubAllGlobals(); }
  });

  it("rejects a null handshake without leaking an internal validation error", async () => {
    vi.stubGlobal("fetch", async () => ({ status: 200, ok: true, json: async () => null }));
    try {
      await expect(connectCompanionService("http://192.0.2.44:8787", "vod_test", identity)).rejects.toThrow("TV connection could not be established.");
    } finally { vi.unstubAllGlobals(); }
  });

  it("uses one-time redemption and scoped bearer credentials without putting them in URLs", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, ...(init ? { init } : {}) });
      if (url.endsWith("/api/pair/redeem")) return { ok: true, json: async () => ({ protocolVersion: 4, ...identity, browserCredential: "b".repeat(64), expiresAt: 123, sourceFingerprint: "vod_test", capabilities: { localMedia: true } }) };
      if (url.endsWith("/api/pair/play")) return { ok: true, json: async () => ({ protocolVersion: 4, accepted: true }) };
      if (url.endsWith("/api/pair/ack")) return { ok: true, json: async () => ({ protocolVersion: 4, acknowledged: 9 }) };
      return { ok: true, json: async () => ({ protocolVersion: 4, events: [], paired: true }) };
    });
    try {
      const paired = await redeemCompanionCode("http://relay.test", "12345678");
      const selectionWithUntrustedExtras = { kind: "movie", id: "42", title: "Example", year: null, extension: "mp4", sourceFingerprint: "vod_test", streamUrl: "https://private.invalid/token=secret", tvCredential: "secret" } as unknown as Parameters<typeof sendCompanionPlayback>[2];
      await sendCompanionPlayback("http://relay.test", paired.browserCredential, selectionWithUntrustedExtras);
      await companionEvents("http://relay.test", "t".repeat(64), 0);
      await acknowledgeCompanionEvents("http://relay.test", "t".repeat(64), 9);
      expect(calls.map(({ url }) => url)).toEqual([
        "http://relay.test/api/pair/redeem", "http://relay.test/api/pair/play", "http://relay.test/api/pair/events?after=0&protocolVersion=4&wait=25000",
        "http://relay.test/api/pair/ack",
      ]);
      expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({ protocolVersion: 4, code: "12345678" });
      expect(JSON.parse(String(calls[1]?.init?.body))).toMatchObject({ protocolVersion: 4, selection: { kind: "movie", id: "42" } });
      expect(calls[1]?.init?.headers).toMatchObject({ authorization: `Bearer ${paired.browserCredential}` });
      expect(calls[2]?.init?.headers).toMatchObject({ authorization: `Bearer ${"t".repeat(64)}` });
      expect(calls[3]?.init?.headers).toMatchObject({ authorization: `Bearer ${"t".repeat(64)}` });
      expect(JSON.parse(String(calls[3]?.init?.body))).toEqual({ protocolVersion: 4, sequence: 9 });
      expect(JSON.stringify(calls)).not.toContain("streamUrl");
      expect(JSON.stringify(calls)).not.toContain("private.invalid");
      expect(JSON.stringify(calls)).not.toContain('"tvCredential"');
    } finally { vi.unstubAllGlobals(); }
  });

  it("resets one TV pairing using only that TV credential", async () => {
    let call: { url: string; init?: RequestInit } | undefined;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      call = { url, ...(init ? { init } : {}) };
      return { ok: true, json: async () => ({ protocolVersion: 4, deviceId: identity.deviceId, pairingCode: "87654321", pairingExpiresAt: Date.now() + 300_000 }) };
    });
    try {
      await expect(resetCompanionPairing("https://relay.test", "t".repeat(64))).resolves.toMatchObject({ deviceId: identity.deviceId, pairingCode: "87654321" });
      expect(call?.url).toBe("https://relay.test/api/pair/reset");
      expect(call?.init?.headers).toMatchObject({ authorization: `Bearer ${"t".repeat(64)}` });
      expect(JSON.parse(String(call?.init?.body))).toEqual({ protocolVersion: 4 });
    } finally { vi.unstubAllGlobals(); }
  });

  it("rejects a mismatched or invalid acknowledgement response", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: true, json: async () => ({ protocolVersion: 4, acknowledged: 8 }) }));
    try { await expect(acknowledgeCompanionEvents("http://relay.test", "t".repeat(64), 9)).rejects.toThrow("Could not acknowledge"); }
    finally { vi.unstubAllGlobals(); }
    await expect(acknowledgeCompanionEvents("http://relay.test", "t".repeat(64), -1)).rejects.toThrow("Could not acknowledge");
  });

  it("rejects an unsupported events schema and strips unsafe event fields", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: true, json: async () => ({ protocolVersion: 4, paired: true, events: [{
      sequence: 1, selection: { kind: "movie", id: "42", title: "Example", year: null, extension: "mp4", sourceFingerprint: "vod_test", streamUrl: "https://private.invalid/token=secret", browserCredential: "secret" },
    }] }) }));
    try {
      const result = await companionEvents("http://relay.test", "t".repeat(64), 0);
      expect("selection" in result.events[0]! ? result.events[0].selection : null).not.toHaveProperty("streamUrl");
      expect("selection" in result.events[0]! ? result.events[0].selection : null).not.toHaveProperty("browserCredential");
    } finally { vi.unstubAllGlobals(); }
    vi.stubGlobal("fetch", async () => ({ ok: true, json: async () => ({ protocolVersion: 1, events: [], paired: true }) }));
    try { await expect(companionEvents("http://relay.test", "t".repeat(64), 0)).rejects.toThrow("response was unavailable or invalid"); }
    finally { vi.unstubAllGlobals(); }
  });

  it("bounds long-poll duration and forwards cancellation to fetch", async () => {
    let requestUrl = "";
    let requestInit: RequestInit | undefined;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      requestUrl = url;
      requestInit = init;
      return { ok: true, json: async () => ({ protocolVersion: 4, paired: false, events: [] }) };
    });
    const controller = new AbortController();
    try {
      await companionEvents("http://relay.test", "t".repeat(64), 9, { waitMs: 90_000, signal: controller.signal });
      expect(requestUrl).toContain("after=9&protocolVersion=4&wait=25000");
      expect(requestInit?.signal).toBe(controller.signal);
    } finally { vi.unstubAllGlobals(); }
  });

  it("turns a safe selection into a local provider title without a stream URL", () => {
    const title = companionSelectionTitle({ kind: "movie", id: "42", title: "Example (2024)", year: 2024, extension: "mkv", sourceFingerprint: "vod_x" });
    expect(title).toMatchObject({ id: "xtream:movie:42", title: "Example", year: 2024, group: "Search", streamUrl: "" });
  });

  it("rejects malformed provider IDs", () => {
    expect(companionSelectionTitle({ kind: "movie", id: "42/secret", title: "Example", year: null, extension: "mp4", sourceFingerprint: "vod_x" })).toBeNull();
  });

  it("converts a TV episode command without accepting a stream URL", () => {
    const title = companionSelectionTitle({ kind: "episode", id: "101", seriesId: "7", title: "Example S01E02", year: 2024, season: 1, episode: 2, extension: "mkv", sourceFingerprint: "vod_x" });
    expect(title).toMatchObject({ id: "xtream:episode:101", contentType: "series", season: 1, episode: 2, streamUrl: "" });
  });

  it("resumes after a lost upload acknowledgement from the server-reported offset", async () => {
    const bytes = Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const file = Object.assign(new Blob([bytes]), { name: "synthetic.mp4" }) as File;
    const uploaded: number[][] = [];
    let firstPut = true;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (url.endsWith("/api/local-media/sessions")) return { ok: true, json: async () => ({ sessionId: "c".repeat(32), state: "uploading", expectedSize: 10, uploadOffset: 0, expiresAt: 1, chunkBytes: 4 }) };
      if (url.includes("/chunks?offset=")) {
        const chunk = Array.from(new Uint8Array(await new Response(init?.body).arrayBuffer()));
        uploaded.push(chunk);
        if (firstPut) { firstPut = false; return { ok: false, status: 503, json: async () => ({}) }; }
        return { ok: true, json: async () => ({ uploadOffset: Number(new URL(url).searchParams.get("offset")) + chunk.length }) };
      }
      if (url.endsWith("/status")) return { ok: true, json: async () => ({ sessionId: "c".repeat(32), state: "uploading", expectedSize: 10, uploadOffset: 4, expiresAt: 1 }) };
      if (url.endsWith("/finalize")) return { ok: true, json: async () => ({ sessionId: "c".repeat(32), state: "ready", expectedSize: 10, uploadOffset: 10, expiresAt: 1 }) };
      return { ok: true, json: async () => ({ stopped: true }) };
    });
    try {
      await expect(stageLocalMedia("http://relay.test", "b".repeat(64), file, () => undefined)).resolves.toMatchObject({ state: "ready", uploadOffset: 10 });
      expect(uploaded).toEqual([[0, 1, 2, 3], [4, 5, 6, 7], [8, 9]]);
    } finally { vi.unstubAllGlobals(); }
  });

  it("sends a stop command without putting credentials or tickets in the URL", async () => {
    const captured: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => { captured.push({ url, ...(init ? { init } : {}) }); return { ok: true, json: async () => ({ protocolVersion: 4, accepted: true }) }; });
    try {
      await sendStopLocalCompanionPlayback("http://relay.test", "b".repeat(64), "d".repeat(32));
      expect(captured[0]?.url).toBe("http://relay.test/api/pair/stop-local");
      expect(captured[0]?.init?.headers).toMatchObject({ authorization: `Bearer ${"b".repeat(64)}` });
      expect(JSON.parse(String(captured[0]?.init?.body))).toEqual({ protocolVersion: 4, sessionId: "d".repeat(32) });
    } finally { vi.unstubAllGlobals(); }
  });
});
