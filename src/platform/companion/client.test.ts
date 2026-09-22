import { describe, expect, it } from "vitest";
import { vi } from "vitest";

vi.mock("../package-defaults.ts", () => ({ packageDefaults: {
  companionServerUrl: "http://192.0.2.44:8787",
} }));

import { companionSelectionTitle, companionServerUrl, connectCompanionService, getCompanionConnection, saveCompanionServerUrl, sendCompanionPlayback } from "./client.ts";

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
    vi.stubGlobal("fetch", async () => { throw new Error("private network detail"); });
    try { await expect(getCompanionConnection("http://192.0.2.44:8787")).rejects.toMatchObject({ kind: "unreachable" }); }
    finally { vi.unstubAllGlobals(); }
    vi.stubGlobal("fetch", async () => ({ status: 404, ok: false, json: async () => ({ error: "No TV is connected." }) }));
    try { await expect(getCompanionConnection("http://192.0.2.44:8787")).rejects.toMatchObject({ kind: "no-tv" }); }
    finally { vi.unstubAllGlobals(); }
  });

  it("sanitizes malformed network response errors", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: false, json: async () => { throw new Error("https://private.invalid/token=secret"); } }));
    try {
      await expect(connectCompanionService("http://192.0.2.44:8787", "https://iptv.invalid/get.php?username=u&password=p"))
        .rejects.toThrow("Companion service response was unavailable or invalid.");
      await expect(sendCompanionPlayback("http://192.0.2.44:8787", "session", { kind: "movie", id: "42", title: "Example", year: null, extension: "mp4", sourceFingerprint: "vod_x" }))
        .rejects.toThrow("Could not send playback to the TV.");
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
