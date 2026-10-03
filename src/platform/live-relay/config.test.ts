import { describe, expect, it } from "vitest";
import { clearLiveRelayConfig, loadLiveRelayConfig, normalizeLiveRelayConfig, relayChannelId, saveLiveRelayConfig } from "./config.ts";

const credential = "a".repeat(64);

describe("live relay configuration", () => {
  it("stores a validated HTTPS origin and device credential explicitly", () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => { values.delete(key); } };
    const result = saveLiveRelayConfig({ serviceUrl: " https://relay.example.test/ ", deviceCredential: credential }, storage);
    expect(result).toEqual({ enabled: false, serviceUrl: "https://relay.example.test", deviceCredential: credential, allowLanHttp: false, channelMappings: {}, offsetMs: 0, diagnosticsEnabled: true });
    expect(loadLiveRelayConfig(storage)).toEqual(result);
    clearLiveRelayConfig(storage);
    expect(loadLiveRelayConfig(storage)).toBeNull();
  });

  it("rejects non-HTTPS public endpoints, URL credentials, and malformed device credentials", () => {
    expect(() => normalizeLiveRelayConfig({ serviceUrl: "http://relay.example.test", deviceCredential: credential })).toThrow("HTTPS origin");
    expect(() => normalizeLiveRelayConfig({ serviceUrl: "https://user:pass@relay.example.test", deviceCredential: credential })).toThrow("credentials");
    expect(() => normalizeLiveRelayConfig({ serviceUrl: "https://relay.example.test", deviceCredential: "secret" })).toThrow("device credential");
    expect(normalizeLiveRelayConfig({ serviceUrl: "http://127.0.0.1:8787", deviceCredential: credential }).serviceUrl).toBe("http://127.0.0.1:8787");
  });

  it("defaults hosted playback off and preserves explicit LAN, mapping, timing, and diagnostics options", () => {
    expect(normalizeLiveRelayConfig({ serviceUrl: "https://relay.example.test", deviceCredential: credential })).toMatchObject({
      enabled: false, allowLanHttp: false, channelMappings: {}, offsetMs: 0, diagnosticsEnabled: true,
    });
    const value = normalizeLiveRelayConfig({
      enabled: true, serviceUrl: "http://192.168.1.20:8787", allowLanHttp: true, deviceCredential: credential,
      channelMappings: { "123": "channel-123" }, offsetMs: 500, diagnosticsEnabled: false,
    });
    expect(value).toMatchObject({ enabled: true, allowLanHttp: true, channelMappings: { "123": "channel-123" }, offsetMs: 500, diagnosticsEnabled: false });
    expect(relayChannelId(value, 123)).toBe("channel-123");
    expect(relayChannelId(value, 124)).toBeNull();
  });

  it("automatically routes Multi-Sub titles while preferring explicit mappings", () => {
    const value = normalizeLiveRelayConfig({
      enabled: true, serviceUrl: "https://relay.example.test", deviceCredential: credential,
      channelMappings: { "42": "manual-channel" },
    });
    expect(relayChannelId(value, 42, "News Multi-Sub HD")).toBe("manual-channel");
    expect(relayChannelId(value, 43, "News multi sub")).toBe("stream-43");
    expect(relayChannelId(value, 44, "News HD")).toBeNull();
  });

  it("allows opted-in HTTP only for RFC1918 IPv4 addresses and bounds mapping and timing values", () => {
    expect(() => normalizeLiveRelayConfig({ serviceUrl: "http://192.168.1.20:8787", deviceCredential: credential })).toThrow("private LAN IPv4");
    expect(() => normalizeLiveRelayConfig({ serviceUrl: "http://8.8.8.8:8787", allowLanHttp: true, deviceCredential: credential })).toThrow("private LAN IPv4");
    expect(() => normalizeLiveRelayConfig({ serviceUrl: "http://169.254.1.20:8787", allowLanHttp: true, deviceCredential: credential })).toThrow("private LAN IPv4");
    expect(() => normalizeLiveRelayConfig({ serviceUrl: "https://relay.example.test", deviceCredential: credential, offsetMs: 10_001 })).toThrow("whole number");
    expect(() => normalizeLiveRelayConfig({ serviceUrl: "https://relay.example.test", deviceCredential: credential, channelMappings: { "bad id": "x" } })).toThrow("Channel mappings");
  });
});
