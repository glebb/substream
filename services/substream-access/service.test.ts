import { afterEach, describe, expect, it } from 'vitest';
import { request as httpRequest } from 'node:http';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createAccessService } from './service.ts';

const EMAIL = 'viewer.synthetic@example.invalid';
const PORTAL = 'https://substream.example.invalid';

function listeningPort(server: { address(): string | AddressInfo | null }): number {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('listener_not_ready');
  return address.port;
}

async function request(urlValue: string, options: {
  method?: string;
  headers?: Record<string, string>;
  body?: URLSearchParams;
} = {}): Promise<{ status: number; headers: { get(name: string): string | null }; text(): Promise<string> }> {
  const url = new URL(urlValue);
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method: options.method ?? 'GET',
      headers: options.headers,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({
          status: res.statusCode ?? 0,
          headers: { get: (name) => {
            const value = res.headers[name.toLowerCase()];
            return Array.isArray(value) ? value[0] ?? null : value ?? null;
          } },
          text: async () => body,
        });
      });
    });
    req.once('error', reject);
    if (options.body) req.end(options.body.toString()); else req.end();
  });
}

describe('standalone Substream access service', () => {
  let temporaryDirectory = '';
  let activeService: Awaited<ReturnType<typeof createAccessService>> | undefined;

  afterEach(async () => {
    if (activeService) await activeService.close();
    activeService = undefined;
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = '';
  });

  async function start() {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'substream-access-test-'));
    const configPath = join(temporaryDirectory, 'config.json');
    const databasePath = join(temporaryDirectory, 'access.sqlite');
    const writeConfig = (allowedEmails = [EMAIL]) => writeFile(configPath, JSON.stringify({
      googleClientId: 'synthetic-client-id.apps.googleusercontent.com',
      googleClientSecret: 'synthetic-secret-value',
      allowedEmails,
      portalOrigin: PORTAL,
      playerOrigin: 'http://substream.example.invalid',
      databasePath,
    }), { mode: 0o600 });
    await writeConfig();
    let currentTime = Date.UTC(2026, 9, 5, 12, 0, 0);
    activeService = await createAccessService({
      configPath,
      portalPort: 0,
      authPort: 0,
      now: () => currentTime,
      exchangeCode: async (code, verifier) => code === 'synthetic-code' && verifier.length === 43 ? 'synthetic-id-token' : null,
      verifyIdToken: async (idToken, clientId, nonce) => idToken === 'synthetic-id-token' &&
        clientId === 'synthetic-client-id.apps.googleusercontent.com' && nonce.length === 43 ? EMAIL : null,
    });
    await activeService.listen();
    return {
      configPath,
      databasePath,
      writeConfig,
      setNow: (milliseconds: number) => { currentTime = milliseconds; },
      portal: `http://127.0.0.1:${listeningPort(activeService!.portal)}`,
      auth: `http://127.0.0.1:${listeningPort(activeService!.authorizer)}`,
    };
  }

  async function signIn(portal: string): Promise<string> {
    const login = await request(`${portal}/auth/google/login`, { headers: { Host: new URL(PORTAL).host } });
    expect(login.status).toBe(302);
    expect(login.headers.get('referrer-policy')).toBe('no-referrer');
    const googleUrl = new URL(login.headers.get('location')!);
    expect(googleUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(googleUrl.searchParams.get('nonce')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const state = googleUrl.searchParams.get('state')!;
    const flowCookie = login.headers.get('set-cookie')!.split(';')[0]!;
    expect(flowCookie).toBe(`__Host-substream_oauth_${state}=${state}`);
    const missingBrowserCookie = await request(`${portal}/auth/google/callback?state=${state}&code=synthetic-code`, {
      headers: { Host: new URL(PORTAL).host },
    });
    expect(missingBrowserCookie.status).toBe(401);
    const mismatchedBrowserCookie = await request(`${portal}/auth/google/callback?state=${state}&code=synthetic-code`, {
      headers: { Host: new URL(PORTAL).host, Cookie: `__Host-substream_oauth_${state}=wrong` },
    });
    expect(mismatchedBrowserCookie.status).toBe(401);
    const callback = await request(`${portal}/auth/google/callback?state=${state}&code=synthetic-code`, {
      headers: { Host: new URL(PORTAL).host, Cookie: flowCookie },
    });
    expect(callback.status).toBe(303);
    expect(callback.headers.get('referrer-policy')).toBe('no-referrer');
    const cookie = callback.headers.get('set-cookie')!;
    expect(cookie).toContain('__Host-substream_session=');
    expect(cookie).toContain('Secure; HttpOnly; SameSite=Lax; Path=/');
    const sessionCookie = cookie.split(';')[0]!;
    const replay = await request(`${portal}/auth/google/callback?state=${state}&code=synthetic-code`, {
      headers: { Host: new URL(PORTAL).host, Cookie: flowCookie },
    });
    expect(replay.status).toBe(401);
    return sessionCookie;
  }

  it('runs Google OAuth state/PKCE, creates exact-IP grants, replaces and revokes them', async () => {
    const context = await start();
    const cookie = await signIn(context.portal);
    const page = await request(`${context.portal}/`, { headers: { Host: new URL(PORTAL).host, Cookie: cookie } });
    expect(page.status).toBe(200);
    expect(page.headers.get('cache-control')).toContain('no-store');
    expect(page.headers.get('referrer-policy')).toBe('same-origin');
    expect(page.headers.get('strict-transport-security')).toBeNull();
    const html = await page.text();
    const csrf = /name="csrf_token" value="([A-Za-z0-9_-]{43})"/.exec(html)?.[1];
    expect(csrf).toBeTruthy();

    const post = (path: string, token: string, ip = '2001:0db8:0:0::1') => request(`${context.portal}${path}`, {
      method: 'POST',
      headers: {
        Host: new URL(PORTAL).host,
        Origin: PORTAL,
        Cookie: cookie,
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Real-IP': ip,
      },
      body: new URLSearchParams({ csrf_token: token }),
    });
    const rejected = await post('/access', 'wrong-csrf');
    expect(rejected.status).toBe(403);
    const created = await post('/access', csrf!);
    expect(created.status).toBe(200);
    expect(created.headers.get('referrer-policy')).toBe('same-origin');
    const createdHtml = await created.text();
    const link = /http:\/\/substream\.example\.invalid\/([A-Za-z0-9_-]{43})\//.exec(createdHtml)?.[0];
    const token = /http:\/\/substream\.example\.invalid\/([A-Za-z0-9_-]{43})\//.exec(createdHtml)?.[1];
    expect(link).toBeTruthy();
    expect(createdHtml).toContain('2001:db8::1');

    const authorize = (uri: string, ip = '2001:db8::1') => request(`${context.auth}/authorize`, {
      headers: { 'X-Substream-Original-URI': uri, 'X-Substream-Client-IP': ip },
    });
    expect((await authorize(`/${token}/assets/app.js`)).status).toBe(204);
    expect((await authorize(`/${token}/assets/app.js?x=1`)).status).toBe(403);
    expect((await authorize(`/${token}/%252e%252e/secret`)).status).toBe(403);
    expect((await authorize(`/${token}/api/catalog`)).status).toBe(403);
    expect((await authorize(`/${token}/assets/app.js`, '2001:db8::2')).status).toBe(403);

    const databaseBytes = await readFile(context.databasePath);
    expect(databaseBytes.includes(Buffer.from(token!))).toBe(false);
    expect((await stat(context.databasePath)).mode & 0o777).toBe(0o600);

    const replaced = await post('/access', csrf!);
    const replacedToken = /http:\/\/substream\.example\.invalid\/([A-Za-z0-9_-]{43})\//.exec(await replaced.text())?.[1];
    expect(replacedToken).not.toBe(token);
    expect((await authorize(`/${token}/index.html`)).status).toBe(403);
    expect((await authorize(`/${replacedToken}/index.html`)).status).toBe(204);
    expect((await post('/access/revoke', csrf!)).status).toBe(303);
    expect((await authorize(`/${replacedToken}/index.html`)).status).toBe(403);
  });

  it('fails closed on whitelist removal, malformed config, expiry, and non-loopback auth requests', async () => {
    const context = await start();
    const cookie = await signIn(context.portal);
    const page = await request(`${context.portal}/`, { headers: { Host: new URL(PORTAL).host, Cookie: cookie } });
    const csrf = /name="csrf_token" value="([A-Za-z0-9_-]{43})"/.exec(await page.text())?.[1]!;
    const created = await request(`${context.portal}/access`, {
      method: 'POST', headers: { Host: new URL(PORTAL).host, Origin: PORTAL, Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded', 'X-Real-IP': '192.0.2.8' },
      body: new URLSearchParams({ csrf_token: csrf }),
    });
    const token = /http:\/\/substream\.example\.invalid\/([A-Za-z0-9_-]{43})\//.exec(await created.text())?.[1]!;
    const auth = () => request(`${context.auth}/authorize`, { headers: { 'X-Substream-Original-URI': `/${token}/`, 'X-Substream-Client-IP': '192.0.2.8' } });
    expect((await auth()).status).toBe(204);
    await context.writeConfig([]);
    expect((await auth()).status).toBe(403);
    await context.writeConfig();
    context.setNow(Date.UTC(2026, 9, 5, 20, 0, 1));
    expect((await auth()).status).toBe(403);
    await writeFile(context.configPath, '{ invalid json');
    expect((await auth()).status).toBe(403);
    expect((await request(`${context.portal}/`, { headers: { Host: new URL(PORTAL).host } })).status).toBe(503);
  });

  it('rejects missing origin and untrusted portal host', async () => {
    const context = await start();
    expect((await request(`${context.portal}/`, { headers: { Host: 'attacker.example' } })).status).toBe(404);
    const cookie = await signIn(context.portal);
    const page = await request(`${context.portal}/`, { headers: { Host: new URL(PORTAL).host, Cookie: cookie } });
    const csrf = /name="csrf_token" value="([A-Za-z0-9_-]{43})"/.exec(await page.text())?.[1]!;
    const response = await request(`${context.portal}/logout`, {
      method: 'POST', headers: { Host: new URL(PORTAL).host, Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf_token: csrf }),
    });
    expect(response.status).toBe(403);
    const crossOrigin = await request(`${context.portal}/logout`, {
      method: 'POST', headers: { Host: new URL(PORTAL).host, Origin: 'https://attacker.example', Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf_token: csrf }),
    });
    expect(crossOrigin.status).toBe(403);
  });

  it('throttles repeated login-flow creation per observed address', async () => {
    const context = await start();
    for (let index = 0; index < 10; index += 1) {
      const response = await request(`${context.portal}/auth/google/login`, {
        headers: { Host: new URL(PORTAL).host, 'X-Real-IP': '192.0.2.25' },
      });
      expect(response.status).toBe(302);
    }
    const limited = await request(`${context.portal}/auth/google/login`, {
      headers: { Host: new URL(PORTAL).host, 'X-Real-IP': '192.0.2.25' },
    });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('cache-control')).toContain('no-store');
  });

  it('keeps only grant hashes and serves a grant after process restart', async () => {
    const context = await start();
    const token = activeService!.store.createOrReplaceGrant(EMAIL, '192.0.2.9', Date.UTC(2026, 9, 5, 12) / 1000).token;
    const beforeRestart = await request(`${context.auth}/authorize`, {
      headers: { 'X-Substream-Original-URI': `/${token}/index.html`, 'X-Substream-Client-IP': '192.0.2.9' },
    });
    expect(beforeRestart.status).toBe(204);
    await activeService!.close();
    activeService = undefined;

    activeService = await createAccessService({ configPath: context.configPath, portalPort: 0, authPort: 0 });
    await activeService.listen();
    const afterRestart = await request(`http://127.0.0.1:${listeningPort(activeService.authorizer)}/authorize`, {
      headers: { 'X-Substream-Original-URI': `/${token}/index.html`, 'X-Substream-Client-IP': '192.0.2.9' },
    });
    expect(afterRestart.status).toBe(204);
    expect((await readFile(context.databasePath)).includes(Buffer.from(token))).toBe(false);
  });
});
