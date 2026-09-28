import { describe, expect, it } from "vitest";
import { vi } from "vitest";

vi.mock("../package-defaults.ts", () => ({ packageDefaults: {
  companionServerUrl: "http://192.0.2.44:8787",
} }));

import { acknowledgeCompanionEvents, companionEvents, companionSelectionTitle, companionServerUrl, connectCompanionService, getCompanionConnection, redeemCompanionCode, saveCompanionServerUrl, sendCompanionPlayback } from "./client.ts";

describe("companion client", () => {
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
      expect(() => saveCompanionServerUrl("http://user:pass@192.0.2.55:8787")).toThrow("cannot contain credentials");
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
      return { status: 200, ok: true, json: async () => ({ protocolVersion: 2, expiresAt: Date.now() + 10_000, sourceFingerprint: "vod_test" }) };
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
        tvCredential: "a".repeat(64), pairingCode: "01234567", pairingExpiresAt: Date.now() + 60_000,
        protocolVersion: 2, expiresAt: Date.now() + 30 * 60_000, sourceFingerprint: "vod_test",
      }) };
    });
    try {
      const previous = "t".repeat(64);
      await connectCompanionService("http://192.0.2.44:8787", "vod_test", previous);
      expect(authorization).toBe(`Bearer ${previous}`);
    } finally { vi.unstubAllGlobals(); }
  });

  it("registers only a validated account-aware source fingerprint", async () => {
    let body = "";
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      body = String(init?.body ?? "");
      return { ok: true, json: async () => ({ protocolVersion: 2, tvCredential: "a".repeat(64), pairingCode: "01234567", pairingExpiresAt: 10, expiresAt: 20, sourceFingerprint: "vod_test" }) };
    });
    try {
      await connectCompanionService("http://192.0.2.44:8787", "vod_test");
      expect(JSON.parse(body)).toEqual({ protocolVersion: 2, sourceFingerprint: "vod_test" });
      expect(body).not.toMatch(/username|password|playlistUrl|streamUrl|iptv\.invalid/);
      await expect(connectCompanionService("http://192.0.2.44:8787", "https://iptv.invalid/get.php?username=user&password=secret"))
        .rejects.toThrow("A valid Xtream source is required");
    } finally { vi.unstubAllGlobals(); }
  });

  it("sanitizes malformed network response errors", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: false, json: async () => { throw new Error("https://private.invalid/token=secret"); } }));
    try {
      await expect(connectCompanionService("http://192.0.2.44:8787", "vod_test"))
        .rejects.toThrow("Companion service response was unavailable or invalid.");
      await expect(sendCompanionPlayback("http://192.0.2.44:8787", "session", { kind: "movie", id: "42", title: "Example", year: null, extension: "mp4", sourceFingerprint: "vod_x" }))
        .rejects.toThrow("Could not send playback to the TV.");
    } finally { vi.unstubAllGlobals(); }
  });

  it("uses one-time redemption and scoped bearer credentials without putting them in URLs", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, ...(init ? { init } : {}) });
      if (url.endsWith("/api/pair/redeem")) return { ok: true, json: async () => ({ protocolVersion: 2, browserCredential: "b".repeat(64), expiresAt: 123, sourceFingerprint: "vod_test" }) };
      if (url.endsWith("/api/pair/play")) return { ok: true, json: async () => ({ protocolVersion: 2, accepted: true }) };
      if (url.endsWith("/api/pair/ack")) return { ok: true, json: async () => ({ protocolVersion: 2, acknowledged: 9 }) };
      return { ok: true, json: async () => ({ protocolVersion: 2, events: [], paired: true }) };
    });
    try {
      const paired = await redeemCompanionCode("http://relay.test", "12345678");
      const selectionWithUntrustedExtras = { kind: "movie", id: "42", title: "Example", year: null, extension: "mp4", sourceFingerprint: "vod_test", streamUrl: "https://private.invalid/token=secret", tvCredential: "secret" } as unknown as Parameters<typeof sendCompanionPlayback>[2];
      await sendCompanionPlayback("http://relay.test", paired.browserCredential, selectionWithUntrustedExtras);
      await companionEvents("http://relay.test", "t".repeat(64), 0);
      await acknowledgeCompanionEvents("http://relay.test", "t".repeat(64), 9);
      expect(calls.map(({ url }) => url)).toEqual([
        "http://relay.test/api/pair/redeem", "http://relay.test/api/pair/play", "http://relay.test/api/pair/events?after=0&protocolVersion=2&wait=25000",
        "http://relay.test/api/pair/ack",
      ]);
      expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({ protocolVersion: 2, code: "12345678" });
      expect(JSON.parse(String(calls[1]?.init?.body))).toMatchObject({ protocolVersion: 2, selection: { kind: "movie", id: "42" } });
      expect(calls[1]?.init?.headers).toMatchObject({ authorization: `Bearer ${paired.browserCredential}` });
      expect(calls[2]?.init?.headers).toMatchObject({ authorization: `Bearer ${"t".repeat(64)}` });
      expect(calls[3]?.init?.headers).toMatchObject({ authorization: `Bearer ${"t".repeat(64)}` });
      expect(JSON.parse(String(calls[3]?.init?.body))).toEqual({ protocolVersion: 2, sequence: 9 });
      expect(JSON.stringify(calls)).not.toContain("streamUrl");
      expect(JSON.stringify(calls)).not.toContain("private.invalid");
      expect(JSON.stringify(calls)).not.toContain('"tvCredential"');
    } finally { vi.unstubAllGlobals(); }
  });

  it("rejects a mismatched or invalid acknowledgement response", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: true, json: async () => ({ protocolVersion: 2, acknowledged: 8 }) }));
    try { await expect(acknowledgeCompanionEvents("http://relay.test", "t".repeat(64), 9)).rejects.toThrow("Could not acknowledge"); }
    finally { vi.unstubAllGlobals(); }
    await expect(acknowledgeCompanionEvents("http://relay.test", "t".repeat(64), -1)).rejects.toThrow("Could not acknowledge");
  });

  it("rejects an unsupported events schema and strips unsafe event fields", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: true, json: async () => ({ protocolVersion: 2, paired: true, events: [{
      sequence: 1, selection: { kind: "movie", id: "42", title: "Example", year: null, extension: "mp4", sourceFingerprint: "vod_test", streamUrl: "https://private.invalid/token=secret", browserCredential: "secret" },
    }] }) }));
    try {
      const result = await companionEvents("http://relay.test", "t".repeat(64), 0);
      expect(result.events[0]?.selection).not.toHaveProperty("streamUrl");
      expect(result.events[0]?.selection).not.toHaveProperty("browserCredential");
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
      return { ok: true, json: async () => ({ protocolVersion: 2, paired: false, events: [] }) };
    });
    const controller = new AbortController();
    try {
      await companionEvents("http://relay.test", "t".repeat(64), 9, { waitMs: 90_000, signal: controller.signal });
      expect(requestUrl).toContain("after=9&protocolVersion=2&wait=25000");
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
});
