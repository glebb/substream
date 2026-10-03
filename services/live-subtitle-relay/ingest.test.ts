import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { FfmpegRelayWorker, isPublicAddress, openSafeUpstream, relayFfmpegArgs } from './ingest.ts';

describe('relay upstream and packaging boundaries', () => {
  it('rejects special-use DNS targets before opening a socket', async () => {
    for (const address of ['127.0.0.1', '10.4.0.1', '172.20.1.1', '192.168.1.1', '169.254.4.3', '100.64.0.4', '192.0.2.4', '::1', 'fc00::1', 'fe80::1']) {
      expect(isPublicAddress(address), address).toBe(false);
    }
    await expect(openSafeUpstream('https://provider.example/live', async () => [{ address: '127.0.0.1', family: 4 }])).rejects.toThrow('upstream_unavailable');
  });

  it('allows public unicast targets and rejects URL schemes outside HTTP(S)', async () => {
    expect(isPublicAddress('1.1.1.1')).toBe(true);
    await expect(openSafeUpstream('file:///etc/passwd', async () => [{ address: '1.1.1.1', family: 4 }])).rejects.toThrow('upstream_unavailable');
  });

  it('keeps FFmpeg input on stdin and writes a bounded live MPEG-TS playlist', () => {
    const args = relayFfmpegArgs('/tmp/relay-test');
    expect(args).toContain('pipe:0');
    expect(args).toContain('copy');
    expect(args).toContain('mpegts');
    expect(args).toContain('/tmp/relay-test/index.m3u8');
    expect(args.at(-1)).toBe('/tmp/relay-test/segment-%08d.ts');
    expect(args.join(' ')).not.toContain('https://');
  });

  it('cleans up an upstream when FFmpeg cannot be started', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'relay-spawn-test-'));
    const upstream = Readable.from([new Uint8Array(188)]) as unknown as IncomingMessage;
    const worker = new FfmpegRelayWorker({ sessionId: 'a'.repeat(32), sessionDirectory: directory,
      upstreamUrl: 'https://synthetic.example/stream', ffmpegPath: join(directory, 'missing-ffmpeg'),
      openUpstream: async () => upstream });
    try {
      await worker.start();
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      expect(worker.state).toBe('failed');
      await worker.stop();
      expect(upstream.destroyed).toBe(true);
    } finally { await worker.stop(); await rm(directory, { recursive: true, force: true }); }
  });
});
