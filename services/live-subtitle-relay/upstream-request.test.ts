import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockState = vi.hoisted(() => ({ responses: [] as Array<{ statusCode: number; headers: Record<string, string> }>, requests: [] as Array<{ hostname: string; allResult: unknown; singleResult: unknown }>, idleTimeouts: [] as number[], streams: [] as Array<{ response: EventEmitter }> }));

vi.mock('node:http', () => ({ request: (options: any, callback: (response: any) => void) => makeRequest(options, callback) }));
vi.mock('node:https', () => ({ request: (options: any, callback: (response: any) => void) => makeRequest(options, callback) }));

function makeRequest(options: any, callback: (response: any) => void) {
  const request = new EventEmitter() as EventEmitter & { end: () => void; destroy: (error?: Error) => void; setTimeout: (timeout: number) => void };
  let idleTimeout = 0;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    if (idleTimeout) idleTimer = setTimeout(() => request.emit('timeout'), idleTimeout);
  };
  request.setTimeout = (timeout: number) => { idleTimeout = timeout; mockState.idleTimeouts.push(timeout); resetIdleTimer(); };
  request.end = () => {
    options.lookup(options.hostname, { all: true }, (error: Error | null, value: unknown) => {
      if (error) throw error;
      const allResult = value;
      options.lookup(options.hostname, { all: false }, (singleError: Error | null, singleValue: unknown, family?: number) => {
        if (singleError) throw singleError;
        mockState.requests.push({ hostname: options.hostname, allResult, singleResult: [singleValue, family] });
        const next = mockState.responses.shift();
        if (!next) return; // Leave the request pending for header-deadline tests.
        const response = new EventEmitter() as EventEmitter & { statusCode: number; headers: Record<string, string>; destroy: (error?: Error) => void; destroyed?: boolean; destroyedWith?: Error };
        response.statusCode = next.statusCode;
        response.headers = next.headers;
        response.destroy = (error?: Error) => { response.destroyed = true; if (error) response.destroyedWith = error; if (idleTimer) clearTimeout(idleTimer); };
        response.on('data', resetIdleTimer);
        mockState.streams.push({ response });
        callback(response);
      });
    });
  };
  request.destroy = (error?: Error) => { if (error) request.emit('error', error); };
  return request;
}

import { openSafeUpstream } from './ingest.ts';

const publicAddress = [{ address: '1.1.1.1', family: 4 }];
const resolver = async (hostname: string) => hostname === 'cdn.synthetic.example'
  ? publicAddress
  : [{ address: '8.8.8.8', family: 4 }];

describe('openSafeUpstream request pinning and redirects', () => {
  beforeEach(() => {
    mockState.responses = [];
    mockState.requests = [];
    mockState.idleTimeouts = [];
    mockState.streams = [];
  });

  it('returns an address array for Node lookup with all:true and a single pinned address otherwise', async () => {
    mockState.responses.push({ statusCode: 200, headers: {} });
    await openSafeUpstream('https://provider.synthetic.example/live', resolver);
    expect(mockState.requests).toEqual([{
      hostname: 'provider.synthetic.example',
      allResult: [{ address: '8.8.8.8', family: 4 }],
      singleResult: ['8.8.8.8', 4],
    }]);
    expect(mockState.idleTimeouts).toEqual([90_000]);
  });

  it('rejects when response headers do not arrive before the deadline', async () => {
    vi.useFakeTimers();
    try {
      const pending = openSafeUpstream('https://provider.synthetic.example/live', resolver);
      const assertion = expect(pending).rejects.toThrow('upstream_unavailable');
      await vi.advanceTimersByTimeAsync(20_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('allows long body pauses, resets the idle window on packets, then destroys the stalled body with a fixed reason', async () => {
    vi.useFakeTimers();
    try {
      mockState.responses.push({ statusCode: 200, headers: {} });
      const response = await openSafeUpstream('https://provider.synthetic.example/live', resolver);
      const stream = mockState.streams[0]?.response as EventEmitter & { destroyedWith?: Error };
      await vi.advanceTimersByTimeAsync(20_001);
      expect(stream.destroyedWith).toBeUndefined();
      stream.emit('data', Buffer.from('synthetic packet'));
      await vi.advanceTimersByTimeAsync(89_999);
      expect(stream.destroyedWith).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(stream.destroyedWith?.message).toBe('upstream_idle_timeout');
      expect(response.destroyed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('allows a public redirect to a different host when public redirects are enabled', async () => {
    mockState.responses.push(
      { statusCode: 302, headers: { location: 'https://cdn.synthetic.example/segment.ts' } },
      { statusCode: 200, headers: {} },
    );
    await openSafeUpstream('https://provider.synthetic.example/live', resolver, 4, undefined, true);
    expect(mockState.requests.map(({ hostname }) => hostname)).toEqual([
      'provider.synthetic.example', 'cdn.synthetic.example',
    ]);
  });

  it('blocks a different-host redirect when public redirects are disabled', async () => {
    mockState.responses.push({ statusCode: 302, headers: { location: 'https://cdn.synthetic.example/segment.ts' } });
    await expect(openSafeUpstream('https://provider.synthetic.example/live', resolver)).rejects.toThrow('upstream_unavailable');
    expect(mockState.requests.map(({ hostname }) => hostname)).toEqual(['provider.synthetic.example']);
  });

  it('blocks a redirect to private DNS even when public redirects are enabled', async () => {
    mockState.responses.push({ statusCode: 302, headers: { location: 'https://cdn.synthetic.example/segment.ts' } });
    const privateRedirectResolver = async (hostname: string) => hostname === 'cdn.synthetic.example'
      ? [{ address: '10.23.0.4', family: 4 }]
      : [{ address: '8.8.8.8', family: 4 }];
    await expect(openSafeUpstream('https://provider.synthetic.example/live', privateRedirectResolver, 4, undefined, true))
      .rejects.toThrow('upstream_unavailable');
    expect(mockState.requests.map(({ hostname }) => hostname)).toEqual(['provider.synthetic.example']);
  });
});
