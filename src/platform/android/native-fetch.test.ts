import { afterEach, describe, expect, it, vi } from "vitest";
import { androidFetch } from "./native-fetch.ts";

afterEach(() => vi.unstubAllGlobals());

describe("Android direct network bridge", () => {
  it("sends credentials only to the requested provider and reconstructs its response", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const windowLike: Record<string, unknown> = {
      SubstreamNative: { postMessage: (json: string) => {
        const message = JSON.parse(json) as { session: string; payload: Record<string, unknown> };
        sent.push(message as unknown as Record<string, unknown>);
        setTimeout(() => {
          const callback = (windowLike.__substreamAndroid as { onEvent(event: unknown): void }).onEvent;
          callback({ v: 1, session: message.session, type: "response", payload: { requestId: message.payload.requestId, status: 200, headers: { "content-type": "application/json" }, body: "{\"ok\":true}" } });
        }, 0);
      } },
    };
    vi.stubGlobal("window", windowLike);
    const response = await androidFetch("https://provider.example/player_api.php", { headers: { Authorization: "Bearer synthetic-fixture" } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    const message = sent[0] as { payload: { url: string; headers: Record<string, string> } };
    expect(message.payload.url).toBe("https://provider.example/player_api.php");
    expect(message.payload.headers.authorization).toBe("Bearer synthetic-fixture");
    expect(JSON.stringify(sent)).not.toContain("substream");
  });

  it("keeps simultaneous requests subscribed until each response arrives", async () => {
    const requests: Array<{ session: string; payload: { requestId: string; url: string } }> = [];
    const windowLike: Record<string, unknown> = {
      SubstreamNative: { postMessage: (json: string) => { requests.push(JSON.parse(json)); } },
    };
    vi.stubGlobal("window", windowLike);
    const first = androidFetch("https://provider.example/first");
    const second = androidFetch("https://provider.example/second");
    expect(requests).toHaveLength(2);
    const callback = (windowLike.__substreamAndroid as { onEvent(event: unknown): void }).onEvent;
    for (const request of requests.slice().reverse()) callback({
      v: 1, session: request.session, type: "response",
      payload: { requestId: request.payload.requestId, status: 200, body: request.payload.url },
    });
    expect(await (await first).text()).toBe("https://provider.example/first");
    expect(await (await second).text()).toBe("https://provider.example/second");
  });

  it("preserves binary response bytes from the native host", async () => {
    const requests: Array<{ session: string; payload: { requestId: string } }> = [];
    const windowLike: Record<string, unknown> = {
      SubstreamNative: { postMessage: (json: string) => { requests.push(JSON.parse(json)); } },
    };
    vi.stubGlobal("window", windowLike);
    const responsePromise = androidFetch("https://image.example/poster.jpg");
    const callback = (windowLike.__substreamAndroid as { onEvent(event: unknown): void }).onEvent;
    const request = requests[0]!;
    const expected = new Uint8Array([0, 0xff, 0xd8, 0x00, 0x80, 0xff]);
    const binary = String.fromCharCode(...expected);
    callback({ v: 1, session: request.session, type: "response", payload: {
      requestId: request.payload.requestId, status: 200, headers: { "content-type": "image/jpeg" },
      bodyBase64: btoa(binary), body: "corrupted-utf8-fallback",
    } });
    expect(Array.from(new Uint8Array(await (await responsePromise).arrayBuffer()))).toEqual(Array.from(expected));
  });
});
