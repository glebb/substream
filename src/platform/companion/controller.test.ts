import { afterEach, describe, expect, it, vi } from "vitest";
import type { PreferencesRepository, TransportRepository } from "../../contracts/repository.ts";
import { createCompanionController } from "./controller.ts";

const syntheticServer = "http://192.0.2.40:8787";
const syntheticDeviceId = "0123456789abcdef0123456789abcdef";
const syntheticCredential = "a".repeat(64);
const syntheticSessionId = "abcdef0123456789abcdef0123456789";

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 32; index += 1) await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("createCompanionController runtime adapters", () => {
  it("uses injected preferences and transport for identity, credential, polling, and acknowledgment", async () => {
    vi.useFakeTimers();
    const values = new Map<string, string>([["substream.companion-device-identity", JSON.stringify({
      deviceId: syntheticDeviceId,
      deviceName: "Synthetic TV",
    })]]);
    const preferences: PreferencesRepository = {
      get: vi.fn((key) => values.get(key) ?? null),
      set: vi.fn((key, value) => { values.set(key, value); }),
      remove: vi.fn((key) => { values.delete(key); }),
    };
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, ...(init ? { init } : {}) });
      if (url.endsWith("/api/connect")) {
        return jsonResponse({
          protocolVersion: 4,
          deviceId: syntheticDeviceId,
          deviceName: "Synthetic TV",
          tvCredential: syntheticCredential,
          pairingCode: "12345678",
          pairingExpiresAt: Date.now() + 60_000,
          expiresAt: Date.now() + 120_000,
          sourceFingerprint: "",
          capabilities: { localMedia: true },
          paired: true,
        });
      }
      if (url.includes("/api/pair/events?")) {
        return jsonResponse({
          protocolVersion: 4,
          paired: true,
          retentionGap: null,
          events: [{ sequence: 1, action: "stop-local", sessionId: syntheticSessionId }],
        });
      }
      if (url.endsWith("/api/pair/ack")) {
        const body = JSON.parse(String(init?.body)) as { sequence?: number };
        return jsonResponse({ protocolVersion: 4, acknowledged: body.sequence });
      }
      throw new Error("Unexpected synthetic request route");
    });

    const globalFetch = vi.fn(() => { throw new Error("global fetch must not be used"); });
    const localStorage = {
      getItem: vi.fn(() => { throw new Error("global localStorage must not be used"); }),
      setItem: vi.fn(() => { throw new Error("global localStorage must not be used"); }),
      removeItem: vi.fn(() => { throw new Error("global localStorage must not be used"); }),
    };
    vi.stubGlobal("fetch", globalFetch);
    vi.stubGlobal("localStorage", localStorage);

    const transport: TransportRepository = { fetch };
    const controller = createCompanionController(() => "", { preferences, transport });
    const commands = vi.fn();
    controller.onCommand(commands);
    try {
      controller.configure({ enabled: false, server: syntheticServer, sourceFingerprint: "" });
      await flushMicrotasks();
      expect(fetch).not.toHaveBeenCalled();
      expect(globalFetch).not.toHaveBeenCalled();

      controller.configure({ enabled: true, server: syntheticServer, sourceFingerprint: "" });
      await flushMicrotasks();

      expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
        `${syntheticServer}/api/connect`,
        expect.stringContaining("/api/pair/events?after=0"),
        `${syntheticServer}/api/pair/ack`,
      ]);
      expect(requests[1]?.init?.headers).toEqual({ authorization: `Bearer ${syntheticCredential}` });
      expect(requests[2]?.init?.headers).toEqual({
        "content-type": "application/json",
        authorization: `Bearer ${syntheticCredential}`,
      });
      expect(values.get(`substream.companion-tv-credential:${syntheticServer}`)).toBe(syntheticCredential);
      expect(preferences.set).toHaveBeenCalledWith(`substream.companion-tv-credential:${syntheticServer}`, syntheticCredential);
      expect(commands).toHaveBeenCalledWith({ kind: "stop-local", sessionId: syntheticSessionId });
      expect(globalFetch).not.toHaveBeenCalled();
      expect(localStorage.getItem).not.toHaveBeenCalled();
      expect(localStorage.setItem).not.toHaveBeenCalled();
      expect(localStorage.removeItem).not.toHaveBeenCalled();
    } finally {
      controller.dispose();
    }
    expect(vi.getTimerCount()).toBe(0);
  });
});
