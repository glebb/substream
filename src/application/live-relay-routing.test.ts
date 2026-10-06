import { describe, expect, it, vi } from "vitest";
import { resolveLiveRelayChannel } from "./live-relay-routing.ts";
import { createLiveRelaySession } from "../platform/live-relay/client.ts";
import { LivePlaybackController } from "./live-playback-controller.ts";
import type { RelayMediaPlayer } from "../platform/media-player.ts";

const config = { enabled: true, serviceUrl: "https://relay.example.test", deviceCredential: "a".repeat(64) };

describe("Finnish single-upstream subtitle discovery", () => {
  it.each(["FI: MTV Viihde FHD", "FI: Sky Showtime 1 FHD", "FI: Sky Showtime 2 FHD [Multi-Sub]", "FI: TV5 FHD"])("delegates %s to dynamic discovery inside the relay stream", (name) => {
    expect(resolveLiveRelayChannel(config, 42, name)).toEqual({ channelId: "stream-42", evidence: "server-dvb-discovery" });
  });
  it("retains explicit mapping and opt-out precedence", () => {
    expect(resolveLiveRelayChannel({ ...config, channelMappings: { "42": "manual" } }, 42, "FI: MTV Viihde FHD")).toEqual({ channelId: "manual", evidence: "manual-mapping" });
    expect(resolveLiveRelayChannel({ ...config, enabled: false }, 42, "FI: MTV Viihde FHD").channelId).toBeNull();
    expect(resolveLiveRelayChannel(null, 42, "FI: MTV Viihde FHD").channelId).toBeNull();
  });
  it("preserves unknown routes and legacy marked channels outside the Finnish scope", () => {
    expect(resolveLiveRelayChannel(config, 42, "SE: Movies FHD")).toEqual({ channelId: null, evidence: "no-match" });
    expect(resolveLiveRelayChannel(config, "../invalid", "FI: Movies FHD").channelId).toBeNull();
    expect(resolveLiveRelayChannel(config, 42, "SE: Movies [Multi-Sub]")).toEqual({ channelId: "stream-42", evidence: "title-keyword" });
  });
  it("starts relay playback without a preceding provider request on Chromium 47", async () => {
    const request = vi.fn(async () => new Response('{}', { status: 503 }));
    vi.stubGlobal("fetch", request);
    vi.stubGlobal("XMLHttpRequest", vi.fn(() => { throw new Error("Provider preflight is forbidden"); }));
    vi.stubGlobal("AbortController", undefined);
    try {
      const route = resolveLiveRelayChannel(config, 42, "FI: MTV Viihde FHD");
      const hosted = { setEventHandlers: vi.fn(), start: vi.fn(async () => {}), close: vi.fn(async () => {}) } as unknown as RelayMediaPlayer;
      const direct = vi.fn(() => null);
      const controller = new LivePlaybackController({ directStreamUrl: "https://provider.example/live/synthetic-user/synthetic-password/42.m3u8",
        createRelay: () => route.channelId ? hosted : null, createDirect: direct, onPlayer: () => {} });
      await controller.start();
      expect(hosted.start).toHaveBeenCalledOnce(); expect(direct).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled(); expect(XMLHttpRequest).not.toHaveBeenCalled();
      await controller.close();
    } finally { vi.unstubAllGlobals(); }
  });
  it("sends only a stable ID and service credential to the relay, including startup failure", async () => {
    const channelId = resolveLiveRelayChannel(config, 42, "FI: MTV Viihde FHD").channelId;
    const request = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response('{}', { status: 503 }));
    vi.stubGlobal("fetch", request);
    try {
      await expect(createLiveRelaySession(config, channelId!, "fi")).rejects.toThrow("Could not start live subtitle relay session");
      const [destination, init] = request.mock.calls[0]!;
      expect(String(destination)).toBe("https://relay.example.test/v1/sessions");
      expect(JSON.parse(String(init?.body))).toEqual({ channelId: "stream-42", preferredLanguage: "fi" });
      expect(JSON.stringify(request.mock.calls)).not.toContain("provider.example");
    } finally { vi.unstubAllGlobals(); }
  });
});
