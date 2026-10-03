import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createCompanionServer } from "./companion-server.mjs";

const origin = "http://localhost:5173";
const protocolVersion = 4;
let server;
let base;

afterEach(async () => {
  if (server?.listening) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  server = undefined;
});

async function json(path, { method = "GET", body, credential, headers = {} } = {}) {
  const response = await fetch(base + path, {
    method,
    headers: { ...(body instanceof Uint8Array ? { "content-type": "application/octet-stream" } : body !== undefined ? { "content-type": "application/json" } : {}), ...(credential ? { authorization: `Bearer ${credential}` } : {}), ...(method !== "GET" ? { origin } : {}), ...headers },
    ...(body !== undefined ? { body: body instanceof Uint8Array ? body : JSON.stringify(body) } : {}),
  });
  return response;
}

async function pair() {
  const deviceId = randomUUID().replace(/-/g, "");
  const createdResponse = await json("/api/connect", { method: "POST", body: { protocolVersion, sourceFingerprint: "", capabilities: { localMedia: true }, deviceId, deviceName: "Synthetic TV" } });
  expect(createdResponse.status).toBe(200);
  const created = await createdResponse.json();
  const redeemedResponse = await json("/api/pair/redeem", { method: "POST", body: { protocolVersion, code: created.pairingCode } });
  expect(redeemedResponse.status).toBe(200);
  const redeemed = await redeemedResponse.json();
  return { deviceId, tvCredential: created.tvCredential, browserCredential: redeemed.browserCredential };
}

describe("local companion media route", () => {
  it("pairs without an IPTV source, stages bytes, supports range/HEAD, and stops through the TV event queue", async () => {
    server = createCompanionServer();
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    const credentials = await pair();
    const data = Uint8Array.from({ length: 19 }, (_value, index) => index * 7);
    expect((await json("/api/connect", { method: "POST", body: { protocolVersion, sourceFingerprint: "", deviceId: randomUUID().replace(/-/g, ""), deviceName: "Missing capability" } })).status).toBe(400);
    const createResponse = await json("/api/local-media/sessions", { method: "POST", credential: credentials.browserCredential, body: { expectedSize: data.length, name: "synthetic.mp4" } });
    expect(createResponse.status).toBe(201);
    const created = await createResponse.json();
    expect((await json(`/api/local-media/sessions/${created.sessionId}/status`, { credential: "f".repeat(64) })).status).toBe(404);
    expect((await json(`/api/local-media/${created.sessionId}?ticket=${"f".repeat(64)}`)).status).toBe(404);
    const concurrent = await Promise.all([0, 1].map(() => json(`/api/local-media/sessions/${created.sessionId}/chunks?offset=0`, { method: "PUT", credential: credentials.browserCredential, body: data.slice(0, 8) })));
    expect(concurrent.map((response) => response.status).sort()).toEqual([200, 409]);
    expect((await json(`/api/local-media/sessions/${created.sessionId}/chunks?offset=8`, { method: "PUT", credential: credentials.browserCredential, body: data.slice(8) })).status).toBe(200);
    const finalized = await json(`/api/local-media/sessions/${created.sessionId}/finalize`, { method: "POST", credential: credentials.browserCredential, body: {} });
    expect(finalized.status).toBe(200);
    const subtitleText = "1\n00:00:01,000 --> 00:00:02,000\nSynthetic cue\n";
    expect((await json(`/api/local-media/sessions/${created.sessionId}/subtitle`, { method: "PUT", credential: credentials.browserCredential, body: { text: subtitleText, label: "synthetic.srt", language: "fi", enabled: true, offsetSeconds: 0.5 } })).status).toBe(200);
    const dispatched = await json("/api/pair/play-local", { method: "POST", credential: credentials.browserCredential, body: { protocolVersion, sessionId: created.sessionId, metadata: { title: "Synthetic" } } });
    expect(dispatched.status).toBe(200);
    const eventsResponse = await json("/api/pair/events?after=0&wait=0", { credential: credentials.tvCredential });
    const [playEvent] = (await eventsResponse.json()).events;
    expect(playEvent.action).toBe("play-local");
    const subtitleUrl = `/api/local-media/${created.sessionId}/subtitle?ticket=${playEvent.localMedia.ticket}`;
    expect((await json(`/api/local-media/${created.sessionId}/subtitle?ticket=${"f".repeat(64)}`)).status).toBe(404);
    expect(await (await json(subtitleUrl)).json()).toMatchObject({ text: subtitleText, language: "fi", enabled: true, offsetSeconds: 0.5, version: 1 });
    const mediaUrl = `/api/local-media/${created.sessionId}?ticket=${playEvent.localMedia.ticket}`;
    const ranged = await fetch(base + mediaUrl, { headers: { range: "bytes=5-11" } });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get("content-range")).toBe(`bytes 5-11/${data.length}`);
    expect(new Uint8Array(await ranged.arrayBuffer())).toEqual(data.slice(5, 12));
    const suffix = await fetch(base + mediaUrl, { headers: { range: "bytes=-4" } });
    expect(suffix.status).toBe(206);
    expect(new Uint8Array(await suffix.arrayBuffer())).toEqual(data.slice(-4));
    const head = await fetch(base + mediaUrl, { method: "HEAD", headers: { range: "bytes=5-11" } });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(data.length));
    expect((await fetch(base + mediaUrl, { headers: { range: "bytes=100-" } })).status).toBe(416);
    expect((await fetch(base + mediaUrl, { headers: { range: "bytes=0-1,4-5" } })).status).toBe(416);
    const originalNow = Date.now;
    Date.now = () => originalNow() + 6 * 60 * 1000;
    try { expect((await fetch(base + mediaUrl)).status).toBe(404); }
    finally { Date.now = originalNow; }
    expect((await json("/api/pair/stop-local", { method: "POST", credential: credentials.browserCredential, body: { protocolVersion, sessionId: created.sessionId } })).status).toBe(200);
    const stopEvents = await json("/api/pair/events?after=1&wait=0", { credential: credentials.tvCredential });
    expect((await stopEvents.json()).events).toEqual([{ sequence: 2, action: "stop-local", sessionId: created.sessionId }]);
    expect((await json(`/api/local-media/sessions/${created.sessionId}/state`, { method: "POST", credential: credentials.tvCredential, body: { protocolVersion, state: "stopped" } })).status).toBe(200);
    expect((await json(`/api/local-media/sessions/${created.sessionId}/status`, { credential: credentials.browserCredential })).status).toBe(404);
  });
  it.skipIf(spawnSync("ffmpeg", ["-version"]).status !== 0 || spawnSync("ffprobe", ["-version"]).status !== 0)("prepares incompatible synthetic audio, serves MP4 ranges and preserves source upload identity", async () => {
    const dir = await mkdtemp(join(tmpdir(), "substream-tv-route-test-"));
    try {
      const fixture = join(dir, "synthetic.mkv");
      const generated = spawnSync("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=128x72:rate=24:duration=1", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "libmp3lame", "-shortest", fixture], { stdio: "ignore" });
      expect(generated.status).toBe(0);
      const data = new Uint8Array(await readFile(fixture));
      server = createCompanionServer();
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      base = `http://127.0.0.1:${server.address().port}`;
      const credentials = await pair();
      const createResponse = await json("/api/local-media/sessions", { method: "POST", credential: credentials.browserCredential, body: { expectedSize: data.length, name: "synthetic.mkv" } });
      const created = await createResponse.json();
      expect((await json(`/api/local-media/sessions/${created.sessionId}/chunks?offset=0`, { method: "PUT", credential: credentials.browserCredential, body: data })).status).toBe(200);
      const finalized = await json(`/api/local-media/sessions/${created.sessionId}/finalize`, { method: "POST", credential: credentials.browserCredential, body: { tvCompatibility: true } });
      expect(finalized.status).toBe(200);
      expect(await finalized.json()).toMatchObject({ state: "ready", expectedSize: data.length, uploadOffset: data.length });
      expect((await json("/api/pair/play-local", { method: "POST", credential: credentials.browserCredential, body: { protocolVersion, sessionId: created.sessionId, metadata: { title: "Synthetic" } } })).status).toBe(200);
      const [event] = (await (await json("/api/pair/events?after=0&wait=0", { credential: credentials.tvCredential })).json()).events;
      const url = `/api/local-media/${created.sessionId}?ticket=${event.localMedia.ticket}`;
      const response = await fetch(base + url);
      expect(response.headers.get("content-type")).toBe("video/mp4");
      const output = new Uint8Array(await response.arrayBuffer());
      expect(String.fromCharCode(...output.slice(4, 8))).toBe("ftyp");
      expect(response.headers.get("content-length")).toBe(String(output.length));
      expect(event.localMedia.size).toBe(output.length);
      const range = await fetch(base + url, { headers: { range: "bytes=7-31" } });
      expect(range.headers.get("content-range")).toBe(`bytes 7-31/${output.length}`);
      expect(new Uint8Array(await range.arrayBuffer())).toEqual(output.slice(7, 32));
      expect((await json(`/api/local-media/sessions/${created.sessionId}/status`, { method: "DELETE", credential: credentials.browserCredential })).status).toBe(200);
      expect((await fetch(base + url)).status).toBe(404);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }, 15000);

});
