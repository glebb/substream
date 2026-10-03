import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRelayConfig } from '../services/live-subtitle-relay/config.ts';
import { FfmpegRelayWorkerFactory, type RelayWorker } from '../services/live-subtitle-relay/ingest.ts';

// Explicit real-provider test, intended for an isolated egress namespace.
// No raw account responses, stream URLs, keys or underlying errors are logged.
let stage = 'configuration';
let worker: RelayWorker | undefined;
let directory: string | undefined;
try {
  const config = await loadRelayConfig(process.env.RELAY_CONFIG_FILE || '');
  stage = 'vpn-exit';
  const exitResponse = await fetch('https://am.i.mullvad.net/json', { signal: AbortSignal.timeout(20_000) });
  assert.equal(exitResponse.status, 200);
  const exit = await exitResponse.json() as { mullvad_exit_ip?: boolean; country?: string };
  assert.equal(exit.mullvad_exit_ip, true);
  console.log('Mullvad egress confirmed; Finnish exit=' + (exit.country === 'Finland') + '.');
  const source = new URL(Object.values(config.channels)[0]!);
  const pieces = source.pathname.split('/');
  const live = pieces.indexOf('live');
  assert.ok(live >= 0);
  const api = new URL(pieces.slice(0, live).join('/') + '/player_api.php', source.origin);
  const credentials = { username: decodeURIComponent(pieces[live + 1]!), password: decodeURIComponent(pieces[live + 2]!) };
  api.search = new URLSearchParams(credentials).toString();
  stage = 'provider-account';
  const accountResponse = await fetch(api, { signal: AbortSignal.timeout(20_000) });
  console.log('Provider account HTTP status=' + accountResponse.status + '.');
  assert.equal(accountResponse.status, 200);
  const account = await accountResponse.json() as { user_info?: { auth?: number | string; active_cons?: number | string } };
  assert.equal(String(account.user_info?.auth), '1');
  if (Number(account.user_info?.active_cons) > 0) {
    console.log('Skipped live stream test: provider reports existing playback.');
    process.exitCode = 2;
  } else {
    stage = 'channel-selection';
    api.search = new URLSearchParams({ ...credentials, action: 'get_live_streams' }).toString();
    const recordsResponse = await fetch(api, { signal: AbortSignal.timeout(20_000) });
    assert.equal(recordsResponse.status, 200);
    const records = await recordsResponse.json() as Array<{ name: string; stream_id: string | number }>;
    const candidates = records.filter(record => /showtime\s*1\b/i.test(record.name) && config.channels['stream-' + record.stream_id]);
    const row = candidates.find(record => /\bFI\b|\bFIN\b|\bFINLAND\b/i.test(record.name)) ?? candidates[0];
    assert.ok(row);
    const channelId = 'stream-' + row.stream_id;
    directory = await mkdtemp(join(tmpdir(), 'substream-egress-'));
    stage = 'live-stream';
    worker = await new FfmpegRelayWorkerFactory().create({
      sessionId: 'egress-check', sessionDirectory: directory, upstreamUrl: config.channels[channelId]!,
      allowedRedirectHosts: config.allowedRedirectHosts, allowPublicRedirects: config.allowPublicRedirects === true,
      preferredLanguage: 'fi',
    });
    console.log('Provider live connection established through Mullvad.');
    stage = 'media-and-captions';
    const deadline = Date.now() + 90_000;
    let imageId: string | undefined;
    let cursor = 0;
    while (Date.now() < deadline) {
      assert.notEqual(worker.state, 'failed');
      const batch = worker.cues(cursor);
      cursor = batch.nextCursor;
      imageId ||= batch.cues.find(cue => !cue.clear && cue.imageId)?.imageId;
      if (worker.state === 'ready' && imageId) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    console.log('Safe pipeline state=' + worker.state + '; tracks=' + worker.tracks().length
      + '; subtitleImage=' + !!imageId + '; inputIdleMs=' + (worker.inputIdleMs ?? -1) + '.');
    assert.equal(worker.state, 'ready');
    assert.ok(imageId);
    const image = await worker.image(imageId);
    assert.ok(image);
    assert.deepEqual(Array.from(image.slice(0, 8)), [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.ok((await worker.startupPlaylist())?.includes('#EXTINF:'));
    console.log('Mullvad provider pipeline passed: prepared MPEG-TS media, ' + worker.tracks().length + ' subtitle tracks and PNG captions.');
  }
} catch {
  console.error('VPN provider check failed at ' + stage + '; raw network details suppressed.');
  if (worker?.failureReason) console.error('Safe worker failure reason=' + worker.failureReason + '.');
  process.exitCode = 1;
} finally {
  try {
    await worker?.stop();
    if (directory) await rm(directory, { recursive: true, force: true });
    console.log('Egress diagnostic cleanup completed.');
  } catch {
    console.error('Egress diagnostic cleanup failed; stop test workers before further playback.');
    process.exitCode = 1;
  }
}
