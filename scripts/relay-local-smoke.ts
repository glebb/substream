import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer, get, type Server, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRelayFixture } from "./create-relay-fixture.ts";
import { validateRelayConfig } from "../services/live-subtitle-relay/config.ts";
import { createRelayServer } from "../services/live-subtitle-relay/service.ts";
import { FfmpegRelayWorkerFactory } from "../services/live-subtitle-relay/ingest.ts";
import { createLiveRelaySession, type LiveRelaySession } from "../src/platform/live-relay/client.ts";
import type { RelayCue } from "../src/core/live-relay/protocol.ts";

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return "http://127.0.0.1:" + address.port;
}
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
let stage = "fixture";

/** Full local lifecycle: synthetic HTTP source -> FFmpeg -> HTTP API -> real client. */
async function smoke(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "substream-relay-local-"));
  const children = new Set<ChildProcess>();
  let upstream: Server | undefined;
  let relay: Awaited<ReturnType<typeof createRelayServer>> | undefined;
  let session: LiveRelaySession | undefined;
  let connections = 0;
  let activeConnections = 0;
  try {
    const fixture = join(directory, "fixture.ts");
    await createRelayFixture(fixture);
    stage = "synthetic-source-start";
    upstream = createServer((_request, response) => {
      connections++; activeConnections++;
      response.writeHead(200, { "content-type": "video/mp2t" });
      const child = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-stream_loop", "-1", "-re", "-i", fixture,
        "-map", "0", "-c", "copy", "-f", "mpegts", "pipe:1"], { stdio: ["ignore", "pipe", "ignore"] });
      children.add(child);
      child.stdout!.pipe(response);
      response.once("close", () => { activeConnections--; child.kill("SIGTERM"); });
      child.once("exit", () => children.delete(child));
    });
    const sourceUrl = (await listen(upstream)) + "/synthetic.ts";
    stage = "service-start";
    const token = randomBytes(32).toString("hex");
    const sessionRoot = join(directory, "sessions");
    // Loopback allowance is injected ONLY into this synthetic local test.
    // No production config or network address validation is relaxed.
    relay = await createRelayServer(validateRelayConfig({ apiToken: token, channels: { synthetic: sourceUrl }, sessionRoot }), {
      workerFactory: new FfmpegRelayWorkerFactory({ openUpstream: async (url: string) => {
        assert.equal(url, sourceUrl);
        return new Promise<IncomingMessage>((resolve, reject) => { get(sourceUrl, resolve).once("error", reject); });
      } }),
    });
    const serviceUrl = await listen(relay);
    assert.equal((await fetch(serviceUrl + "/healthz")).status, 200);
    assert.equal((await fetch(serviceUrl + "/v1/sessions", { method: "POST", body: "{}" })).status, 401);
    process.stdout.write("Local relay running against synthetic HTTP stream; testing playback session…\n");
    stage = "session-create";
    session = await createLiveRelaySession({ serviceUrl, deviceCredential: token }, "synthetic", "fi");
    const collected: RelayCue[] = [];
    const deadline = Date.now() + 35_000;
    let ready = false;
    stage = "cue-discovery";
    while (Date.now() < deadline) {
      const status = await session.status();
      assert.notEqual(status.state, "failed", "Synthetic relay worker failed");
      ready ||= status.state === "ready";
      const batch = await session.cues();
      collected.push(...batch.cues);
      await session.heartbeat();
      if (ready && collected.filter((cue) => !cue.clear).length >= 2 && collected.some((cue) => cue.clear)) break;
      await pause(500);
    }
    assert.ok(ready, "Relay did not prepare HLS");
    assert.ok(collected.filter((cue) => !cue.clear).length >= 2, "No synthetic PNG subtitle cues");
    assert.equal(connections, 1, "Relay opened more than one upstream connection");
    stage = "playlist";
    const startupStatus = await session.status();
    const startupSequence = startupStatus.startupSequence;
    assert.ok(typeof startupSequence === "number", "Relay did not publish its pinned startup sequence");
    const playlistResponse = await fetch(session.mediaUrl);
    assert.equal(playlistResponse.status, 200);
    const playlist = await playlistResponse.text();
    assert.ok(playlist.includes(`#EXT-X-MEDIA-SEQUENCE:${startupSequence}`), "Late first playlist did not use the pinned startup sequence");
    assert.equal(playlist.match(/#EXTINF:/g)?.length, 3, "Startup playlist did not prebuffer three finalized segments");
    assert.ok(!playlist.includes("#EXT-X-ENDLIST"), "Pinned startup playlist must remain live for AVPlay");
    const repeatedPlaylist = await (await fetch(session.mediaUrl)).text();
    assert.ok(repeatedPlaylist.includes(`#EXT-X-MEDIA-SEQUENCE:${startupSequence}`), "Startup playlist moved before playback acknowledgement");
    const mediaRow = playlist.split(/\r?\n/).find((row) => row && !row.startsWith("#"));
    assert.ok(mediaRow);
    const media = await fetch(new URL(mediaRow, serviceUrl));
    stage = "segment";
    assert.equal(media.status, 200); assert.ok((await media.arrayBuffer()).byteLength > 188);
    await session.markPlaybackStarted();
    const resumedPlaylist = await (await fetch(session.mediaUrl)).text();
    const resumedSequence = Number(resumedPlaylist.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/)?.[1]);
    assert.ok(Number.isSafeInteger(resumedSequence) && resumedSequence >= startupSequence && resumedSequence <= startupSequence + 1,
      "Live playlist resumed beyond the pinned segment without a contiguous handoff");
    const imageId = collected.find((cue) => cue.imageId)?.imageId;
    assert.ok(imageId);
    stage = "image";
    const image = await fetch(session.cueImageUrl(imageId));
    assert.equal(image.status, 200); assert.equal(image.headers.get("content-type"), "image/png");
    const unauthorizedImage = new URL(session.cueImageUrl(imageId)); unauthorizedImage.search = "";
    assert.equal((await fetch(unauthorizedImage)).status, 401);
    stage = "track-off";
    await session.selectTrack(null);
    assert.equal((await session.status()).selectedTrackId, null);
    stage = "teardown";
    await session.dispose(); session = undefined;
    for (let attempt = 0; activeConnections && attempt < 20; attempt++) await pause(100);
    assert.equal(activeConnections, 0, "Upstream connection survived session teardown");
    assert.deepEqual(await readdir(sessionRoot), [], "Session files survived teardown");
    process.stdout.write("Local end-to-end smoke passed: authentication, pinned startup and contiguous live handoff, single upstream, HLS bytes, subtitle PNGs/cues, track off, heartbeat, and cleanup.\n");
  } finally {
    await session?.dispose().catch(() => undefined);
    if (relay) await relay.shutdown();
    for (const child of children) child.kill("SIGTERM");
    if (upstream) await new Promise<void>((resolve) => { upstream!.close(() => resolve()); upstream!.closeAllConnections(); });
    await rm(directory, { recursive: true, force: true });
  }
}

smoke().catch((error: unknown) => {
  // Only fixed client messages are safe to forward. Underlying network errors
  // and arbitrary error messages are deliberately excluded.
  const safeClientMessages = ["Could not start live subtitle relay session.", "Live subtitle relay response was invalid.",
    "Live subtitle relay did not respond within 10 seconds.", "Could not read live subtitle relay status.", "Could not read live subtitle cues."];
  const detail = error instanceof Error && safeClientMessages.includes(error.message) ? " " + error.message : "";
  process.stderr.write("Local synthetic relay smoke failed at " + stage + "." + detail + " Run relay tests and check FFmpeg/libx264 availability.\n");
  process.exitCode = 1;
});
