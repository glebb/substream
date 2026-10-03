import assert from 'node:assert/strict';
import { loadRelayConfig } from '../services/live-subtitle-relay/config.ts';
import { createLiveRelaySession, type LiveRelaySession } from '../src/platform/live-relay/client.ts';

// This is an explicitly invoked provider check, never a unit-test fixture.
// Stop other IPTV playback first when the account allows only one connection.
let stage = 'configuration';
let session: LiveRelaySession | undefined;
async function check(): Promise<void> {
  const config = await loadRelayConfig(process.env.RELAY_CONFIG_FILE || '');
  const channel = process.argv[2] || '';
  assert.ok(config.channels[channel]);
  const endpoint = new URL(process.env.RELAY_CHECK_URL || '');
  assert.equal(endpoint.protocol, 'https:');
  assert.equal(endpoint.href, endpoint.origin + '/');
  const request = (url: string) => fetch(url, { signal: AbortSignal.timeout(10_000) });
  stage = 'https-health';
  assert.equal((await request(endpoint.origin + '/healthz')).status, 200);
  stage = 'session-create';
  session = await createLiveRelaySession({ serviceUrl: endpoint.origin, deviceCredential: config.apiToken }, channel, 'fi');
  let imageId: string | undefined;
  let ready = false;
  let tracks = 0;
  stage = 'subtitles-and-preparation';
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const status = await session.status();
    assert.notEqual(status.state, 'failed');
    ready = status.state === 'ready';
    tracks = status.tracks.length;
    const batch = await session.cues();
    imageId ||= batch.cues.find(cue => !cue.clear && cue.imageId)?.imageId;
    await session.heartbeat();
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.ok(ready);
  stage = 'media';
  const playlistResponse = await request(session.mediaUrl);
  assert.equal(playlistResponse.status, 200);
  const playlist = await playlistResponse.text();
  assert.equal(playlist.match(/#EXTINF:/g)?.length, 3);
  const row = playlist.split(/\r?\n/).find(line => line && !line.startsWith('#'));
  assert.ok(row);
  const segment = await request(new URL(row, session.mediaUrl).href);
  assert.equal(segment.status, 200);
  assert.ok((await segment.arrayBuffer()).byteLength > 188);
  await session.markPlaybackStarted();
  assert.equal((await session.status()).playbackStarted, true);
  // A real programme may have no dialogue during startup. Begin the playback
  // protocol once media is ready, then continue the longer caption sample.
  stage = 'subtitle-cues';
  const cueDeadline = Date.now() + 90_000;
  while (!imageId && Date.now() < cueDeadline) {
    const status = await session.status();
    assert.notEqual(status.state, 'failed');
    tracks = status.tracks.length;
    const batch = await session.cues();
    imageId = batch.cues.find(cue => !cue.clear && cue.imageId)?.imageId;
    await session.heartbeat();
    if (!imageId) await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.ok(imageId);
  stage = 'subtitle-image';
  const image = await request(session.cueImageUrl(imageId));
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/png');
  const bytes = new Uint8Array(await image.arrayBuffer());
  assert.deepEqual(Array.from(bytes.slice(0, 8)), [137, 80, 78, 71, 13, 10, 26, 10]);
  const withoutCapability = new URL(session.cueImageUrl(imageId));
  withoutCapability.search = '';
  assert.equal((await request(withoutCapability.href)).status, 401);
  stage = 'track-off';
  await session.selectTrack(null);
  assert.equal((await session.status()).selectedTrackId, null);
  stage = 'teardown';
  const deletedUrl = session.wire.statusUrl;
  await session.dispose();
  session = undefined;
  assert.equal((await request(deletedUrl)).status, 404);
  console.log(`Hosted provider check passed: trusted HTTPS, ${tracks} subtitle tracks, pinned startup, media bytes, playback acknowledgement, PNG, capability rejection, track off, heartbeat and session deletion.`);
}

try {
  await check();
} catch {
  // Underlying errors can contain credentials or signed media URLs.
  console.error(`Hosted provider check failed at ${stage}; no raw network details logged.`);
  process.exitCode = 1;
} finally {
  if (session) {
    try { await session.dispose(); }
    catch { console.error('Hosted check teardown failed; wait for the session lease to expire before further playback.'); process.exitCode = 1; }
  }
}
