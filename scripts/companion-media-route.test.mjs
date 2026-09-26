import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { prepareMedia } = vi.hoisted(() => ({ prepareMedia: vi.fn() }));
vi.mock("./media-compat.mjs", () => ({ prepareMedia }));
const { route } = await import("./companion-server.mjs");

function responseStub() {
  return { status: 0, headers: {}, body: "", writeHead(status, headers = {}) { this.status = status; this.headers = headers; }, end(body = "") { this.body = String(body); } };
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
});
