import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { prepareMedia } = vi.hoisted(() => ({ prepareMedia: vi.fn() }));
vi.mock("./media-compat.mjs", () => ({ prepareMedia }));
const { route, getRelayMetrics } = await import("./companion-server.mjs");

function responseStub() {
  const response = Object.assign(new EventEmitter(), {
    status: 0, headers: {}, body: "", writableEnded: false,
    writeHead(status, headers = {}) { this.status = status; this.headers = headers; },
    write(chunk) { this.body += Buffer.from(chunk).toString(); return true; },
    end(body = "") { if (body?.length) this.body += Buffer.from(body).toString(); this.writableEnded = true; this.emit("finish"); this.emit("close"); },
  });
  return response;
}

function request(method, payload, headers = {}, remoteAddress = "127.0.0.1") {
  return { method, headers: { host: "localhost:8787", origin: "http://localhost:5173", ...headers }, socket: { remoteAddress }, async *[Symbol.asyncIterator]() { yield JSON.stringify(payload); } };
}

describe("companion media compatibility route", () => {
  afterEach(() => prepareMedia.mockReset());

  it("keeps stream URLs private and returns an opaque HLS path", async () => {
    const sourceUrl = "https://media.example.invalid/movie/secret-token.mkv";
    const process = { once: vi.fn() };
    const cleanup = vi.fn(async () => undefined);
    prepareMedia.mockResolvedValue({ directory: "/tmp/synthetic-media", playlist: "/tmp/synthetic-media/index.m3u8", plan: { convertAudio: true, duration: 3323 }, startSeconds: 87, process, cleanup });
    const response = responseStub();

    await route(request("POST", { streamUrl: sourceUrl, supportsEac3: false, startSeconds: 87 }), response, new URL("http://localhost:8787/api/media/prepare"));

    expect(response.status).toBe(200);
    expect(response.body).not.toContain(sourceUrl);
    const value = JSON.parse(response.body);
    expect(value).toMatchObject({ audioConverted: true, durationSeconds: 3323, startSeconds: 87 });
    expect(value.url).toMatch(/^\/api\/media\/[a-f0-9]{36}\/index\.m3u8$/);
    expect(prepareMedia).toHaveBeenCalledWith(sourceUrl, { supportsEac3: false, supportsAc3: false, supportsH264: false, startSeconds: 87 });
    const removed = responseStub();
    await route(request("DELETE", {}), removed, new URL(`http://localhost:8787/api/media/${value.url.split("/")[3]}`));
    expect(removed.status).toBe(204);
  });

  it("rejects saturated FFmpeg starts and releases capacity after process failure or cleanup", async () => {
    const makeProcess = () => {
      const listeners = [];
      return {
        exitCode: null,
        signalCode: null,
        once: (_event, listener) => listeners.push(listener),
        close(code = 1) { this.exitCode = code; for (const listener of listeners) listener(code, null); },
      };
    };
    const firstProcess = makeProcess();
    const secondProcess = makeProcess();
    const cleanup = vi.fn(async () => undefined);
    const job = (process) => ({ directory: "/tmp/synthetic-media", playlist: "/tmp/missing-playlist", plan: { convertAudio: true }, process, cleanup });
    const pending = [];
    prepareMedia.mockImplementation((sourceUrl) => new Promise((resolve) => pending.push({ sourceUrl, resolve })));

    const first = responseStub();
    const second = responseStub();
    const firstRoute = route(request("POST", { streamUrl: "https://media.example.invalid/one.mkv" }), first, new URL("http://localhost:8787/api/media/prepare"));
    const secondRoute = route(request("POST", { streamUrl: "https://media.example.invalid/two.mkv" }, {}, "::1"), second, new URL("http://localhost:8787/api/media/prepare"));
    await vi.waitFor(() => expect(prepareMedia).toHaveBeenCalledTimes(2));

    const saturated = responseStub();
    await route(request("POST", { streamUrl: "https://media.example.invalid/three.mkv" }), saturated, new URL("http://localhost:8787/api/media/prepare"));
    expect(saturated.status).toBe(503);
    expect(saturated.body).not.toContain("media.example.invalid");
    expect(prepareMedia).toHaveBeenCalledTimes(2);
    pending[0].resolve(job(firstProcess));
    pending[1].resolve(job(secondProcess));
    await Promise.all([firstRoute, secondRoute]);

    firstProcess.close(1);
    prepareMedia.mockResolvedValueOnce(job(makeProcess()));
    const available = responseStub();
    await route(request("POST", { streamUrl: "https://media.example.invalid/three.mkv" }), available, new URL("http://localhost:8787/api/media/prepare"));
    expect(available.status).toBe(200);
    const thirdToken = JSON.parse(available.body).url.split("/")[3];
    const thirdCleanup = responseStub();
    await route(request("DELETE", {}), thirdCleanup, new URL(`http://localhost:8787/api/media/${thirdToken}`));

    const secondToken = JSON.parse(second.body).url.split("/")[3];
    cleanup.mockRejectedValueOnce(new Error("synthetic cleanup failure"));
    const secondCleanup = responseStub();
    await route(request("DELETE", {}), secondCleanup, new URL(`http://localhost:8787/api/media/${secondToken}`));
    expect(secondCleanup.status).toBe(204);
    const firstToken = JSON.parse(first.body).url.split("/")[3];
    const firstCleanup = responseStub();
    await route(request("DELETE", {}), firstCleanup, new URL(`http://localhost:8787/api/media/${firstToken}`));
    expect(firstCleanup.status).toBe(204);
  });

  it("rejects requests that are not same-origin", async () => {
    const response = responseStub();
    await route(request("POST", { streamUrl: "https://media.example.invalid/a.mkv" }, { origin: "https://attacker.invalid" }), response, new URL("http://localhost:8787/api/media/prepare"));
    expect(response.status).toBe(403);
    expect(prepareMedia).not.toHaveBeenCalled();
  });

  it("rejects LAN peers forging local headers for media POST, GET, and DELETE", async () => {
    const directory = await mkdtemp(join(tmpdir(), "substream-peer-test-"));
    const playlist = join(directory, "index.m3u8");
    await writeFile(playlist, "#EXTM3U\n");
    const cleanup = vi.fn(async () => rm(directory, { recursive: true, force: true }));
    prepareMedia.mockResolvedValue({ directory, playlist, plan: { convertAudio: true }, process: { once: vi.fn() }, cleanup });
    const created = responseStub();
    await route(request("POST", { streamUrl: "https://media.example.invalid/a.mkv", supportsEac3: false }), created, new URL("http://localhost:8787/api/media/prepare"));
    const mediaPath = JSON.parse(created.body).url;
    const token = mediaPath.split("/")[3];

    const remotePost = responseStub();
    await route(request("POST", { streamUrl: "https://media.example.invalid/a.mkv" }, {}, "192.168.1.44"), remotePost, new URL("http://localhost:8787/api/media/prepare"));
    expect(remotePost.status).toBe(403);

    const remoteGet = responseStub();
    await route({ method: "GET", headers: { host: "localhost:8787", "sec-fetch-site": "same-origin" }, socket: { remoteAddress: "192.168.1.44" } }, remoteGet, new URL(`http://localhost:8787${mediaPath}`));
    expect(remoteGet.status).toBe(403);

    const remoteDelete = responseStub();
    await route(request("DELETE", {}, {}, "192.168.1.44"), remoteDelete, new URL(`http://localhost:8787/api/media/${token}`));
    expect(remoteDelete.status).toBe(403);
    expect(cleanup).not.toHaveBeenCalled();

    const localDelete = responseStub();
    await route(request("DELETE", {}), localDelete, new URL(`http://localhost:8787/api/media/${token}`));
    expect(localDelete.status).toBe(204);
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("serves HLS requests without Origin when Sec-Fetch-Site is same-origin and cleans up on DELETE", async () => {
    const directory = await mkdtemp(join(tmpdir(), "substream-route-test-"));
    const playlist = join(directory, "index.m3u8");
    await writeFile(playlist, "#EXTM3U\n#EXTINF:4,\nsegment00000.ts\n");
    const cleanup = vi.fn(async () => rm(directory, { recursive: true, force: true }));
    prepareMedia.mockResolvedValue({ directory, playlist, plan: { convertAudio: true }, process: { once: vi.fn() }, cleanup });
    const created = responseStub();
    await route(request("POST", { streamUrl: "https://media.example.invalid/a.mkv", supportsEac3: false }), created, new URL("http://localhost:8787/api/media/prepare"));
    const mediaPath = JSON.parse(created.body).url;
    const token = mediaPath.split("/")[3];

    const mediaResponse = responseStub();
    await route({ method: "GET", headers: { host: "localhost:8787", "sec-fetch-site": "same-origin" }, socket: { remoteAddress: "127.0.0.1" } }, mediaResponse, new URL(`http://localhost:8787${mediaPath}`));
    expect(mediaResponse.status).toBe(200);
    expect(mediaResponse.body).toContain("#EXTM3U");

    // Model FFmpeg's atomic temp_file playlist swap: the path is briefly
    // absent even though a complete previous manifest can still be served.
    await rm(playlist, { force: true });
    const duringReplace = responseStub();
    await route({ method: "GET", headers: { host: "localhost:8787", "sec-fetch-site": "same-origin" }, socket: { remoteAddress: "127.0.0.1" } }, duringReplace, new URL(`http://localhost:8787${mediaPath}`));
    expect(duringReplace.status).toBe(200);
    expect(duringReplace.body).toContain("#EXTM3U");

    const removed = responseStub();
    await route(request("DELETE", {}, { origin: "http://localhost:5173" }), removed, new URL(`http://localhost:8787/api/media/${token}`));
    expect(removed.status).toBe(204);
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("streams synthetic HLS segment bytes and records only aggregate sanitized metrics", async () => {
    const directory = await mkdtemp(join(tmpdir(), "substream-stream-test-"));
    const playlist = join(directory, "index.m3u8");
    const segment = join(directory, "segment00000.ts");
    await writeFile(playlist, "#EXTM3U\n#EXTINF:4,\nsegment00000.ts\n");
    await writeFile(segment, Buffer.alloc(256 * 1024, 0x5a));
    const cleanup = vi.fn(async () => rm(directory, { recursive: true, force: true }));
    prepareMedia.mockResolvedValue({ directory, playlist, plan: { convertAudio: true }, process: { once: vi.fn() }, cleanup });
    const created = responseStub();
    await route(request("POST", { streamUrl: "https://media.example.invalid/fixture.mkv" }), created, new URL("http://localhost:8787/api/media/prepare"));
    const token = JSON.parse(created.body).url.split("/")[3];
    const response = responseStub();
    const streamPath = `/api/media/${token}/segment00000.ts`;
    await route({ method: "GET", headers: { host: "localhost:8787", "sec-fetch-site": "same-origin" }, socket: { remoteAddress: "127.0.0.1" } }, response, new URL(`http://localhost:8787${streamPath}`));
    await vi.waitFor(() => expect(response.writableEnded).toBe(true));
    expect(response.status).toBe(200);
    expect(response.headers["content-length"]).toBe(256 * 1024);
    expect(response.body).toHaveLength(256 * 1024);
    expect(response.body).not.toContain("media.example.invalid");
    expect(getRelayMetrics().media_segment_served).toBeGreaterThan(0);
    expect(JSON.stringify(getRelayMetrics())).not.toMatch(/127\.0\.0\.1|media\.example/);
    const removed = responseStub();
    await route(request("DELETE", {}), removed, new URL(`http://localhost:8787/api/media/${token}`));
  });

  it("enforces the per-client conversion quota and exposes no client identifiers in metrics", async () => {
    prepareMedia.mockResolvedValue({ direct: true, plan: { convertAudio: false } });
    for (let index = 0; index < 12; index += 1) {
      const response = responseStub();
      await route(request("POST", { streamUrl: "https://media.example.invalid/fixture.mkv" }, { origin: "http://127.0.0.1:5173" }, "::1"), response, new URL("http://localhost:8787/api/media/prepare"));
      expect(response.status).toBe(200);
    }
    const limited = responseStub();
    await route(request("POST", { streamUrl: "https://media.example.invalid/fixture.mkv" }, { origin: "http://127.0.0.1:5173" }, "::1"), limited, new URL("http://localhost:8787/api/media/prepare"));
    expect(limited.status).toBe(429);
    expect(limited.body).not.toMatch(/media\.example|::1/);
    expect(getRelayMetrics().media_conversion_quota_limited).toBeGreaterThan(0);
    expect(JSON.stringify(getRelayMetrics())).not.toMatch(/media\.example|::1/);
  });
});
