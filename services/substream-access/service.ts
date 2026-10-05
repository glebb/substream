import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { CodeChallengeMethod, OAuth2Client } from 'google-auth-library';
import { type AccessConfig, loadAccessConfig } from './config.ts';
import { AccessStore, digest, FLOW_SECONDS, randomOpaque } from './store.ts';

const SESSION_COOKIE = '__Host-substream_session';
const OAUTH_FLOW_COOKIE_PREFIX = '__Host-substream_oauth_';
const BODY_LIMIT = 4096;
const TOKEN_PATH = /^\/([A-Za-z0-9_-]{43})\/(.*)$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface AccessServiceOptions {
  configPath: string;
  portalPort?: number;
  authPort?: number;
  now?: () => number;
  /** OAuth verifier hook for deterministic HTTP tests; production uses Google verification. */
  verifyIdToken?: (idToken: string, clientId: string, nonce: string) => Promise<string | null>;
  exchangeCode?: (code: string, verifier: string, config: AccessConfig) => Promise<string | null>;
  brandingPath?: string;
}

export interface AccessService {
  portal: Server;
  authorizer: Server;
  store: AccessStore;
  listen(): Promise<void>;
  close(): Promise<void>;
}

function nowSeconds(options: AccessServiceOptions): number {
  return Math.floor((options.now?.() ?? Date.now()) / 1000);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

function normalizeIp(value: string): string | null {
  const address = value.trim();
  if (isIP(address) === 4) return address.split('.').map((part) => String(Number(part))).join('.');
  if (isIP(address) !== 6 || address.includes('%')) return null;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped && isIP(mapped[1]!) === 4) return normalizeIp(mapped[1]!);
  const halves = address.toLowerCase().split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const words = [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right];
  if (words.length !== 8 || words.some((word) => !/^[0-9a-f]{1,4}$/.test(word))) return null;
  const nums = words.map((word) => parseInt(word, 16));
  if (nums.slice(0, 5).every((part) => part === 0) && nums[5] === 0xffff) {
    return `${nums[6]! >> 8}.${nums[6]! & 255}.${nums[7]! >> 8}.${nums[7]! & 255}`;
  }
  let bestStart = -1;
  let bestLength = 1;
  for (let i = 0; i < nums.length;) {
    if (nums[i] !== 0) { i += 1; continue; }
    let end = i;
    while (end < nums.length && nums[end] === 0) end += 1;
    if (end - i > bestLength) { bestStart = i; bestLength = end - i; }
    i = end;
  }
  if (bestStart < 0) return nums.map((part) => part.toString(16)).join(':');
  const before = nums.slice(0, bestStart).map((part) => part.toString(16)).join(':');
  const after = nums.slice(bestStart + bestLength).map((part) => part.toString(16)).join(':');
  return `${before}::${after}`;
}

function safeEqualDigest(provided: string, expectedToken: string): boolean {
  if (!/^[A-Za-z0-9_-]{43}$/.test(provided)) return false;
  return timingSafeEqual(Buffer.from(digest(provided), 'hex'), Buffer.from(digest(expectedToken), 'hex'));
}

function send(res: ServerResponse, status: number, body: string, headers: Record<string, string | string[]> = {}): void {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store, private',
    'Pragma': 'no-cache',
    // Same-origin lets native form POSTs carry their required Origin header.
    // It still omits referrers when navigating to the HTTP player or Google.
    'Referrer-Policy': 'same-origin',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    ...headers,
  });
  res.end(body);
}

function page(title: string, content: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)} · Substream</title><link rel="icon" href="/branding/substream-icon.png"><style>
    body{margin:0;background:#0c1017;color:#eef3fa;font:16px/1.5 Arial,sans-serif}main{box-sizing:border-box;width:100%;max-width:650px;margin:7vh auto;padding:30px;background:#171e29;border:1px solid #293448;border-radius:16px}header{display:flex;align-items:center;margin-bottom:26px}header img{width:48px;height:48px;margin-right:14px}h1{font-size:25px;margin:0}h2{font-size:20px}p{color:#c4cedc}a,button{display:inline-block;padding:11px 16px;margin:8px 10px 0 0;border:0;border-radius:8px;background:#4aa3ff;color:#07111d;text-decoration:none;font-weight:bold;font-size:15px;cursor:pointer}button.secondary,a.secondary{background:#303c4e;color:#eef3fa}input[type=hidden]{display:none}.notice{padding:12px;border-left:3px solid #f1b956;background:#212936}.small{font-size:13px;color:#aab7c8}code{color:#bfe2ff}.access-link{word-wrap:break-word;word-break:break-all;overflow-wrap:anywhere}</style></head><body><main><header><img src="/branding/substream-icon.png" alt=""><h1>Substream access</h1></header>${content}</main></body></html>`;
}

function hostMatches(req: IncomingMessage, origin: string): boolean {
  const host = req.headers.host?.toLowerCase();
  return Boolean(host && host === new URL(origin).host.toLowerCase());
}

function cookieValue(req: IncomingMessage, name: string): string | null {
  const cookie = req.headers.cookie ?? '';
  for (const part of cookie.split(';')) {
    const [partName, ...rest] = part.trim().split('=');
    if (partName === name) {
      const value = rest.join('=');
      return value;
    }
  }
  return null;
}

function parseTarget(originalUri: string): { token: string } | null {
  if (originalUri.length > 8192 || originalUri.includes('?') || originalUri.includes('#') || originalUri.includes('%') || originalUri.includes('\\')) return null;
  const match = TOKEN_PATH.exec(originalUri);
  if (!match) return null;
  const assetPath = match[2]!;
  const segments = assetPath ? assetPath.split('/') : [];
  if (segments.some((segment) => segment === '.' || segment === '..') ||
      (segments[0] && ['api', 'assets-api'].includes(segments[0].toLowerCase()))) return null;
  return { token: match[1]! };
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams | null> {
  if (!req.headers['content-type']?.toLowerCase().startsWith('application/x-www-form-urlencoded')) return null;
  let body = '';
  for await (const chunk of req) {
    body += Buffer.from(chunk).toString('utf8');
    if (Buffer.byteLength(body) > BODY_LIMIT) throw new Error('body_too_large');
  }
  return new URLSearchParams(body);
}

async function defaultVerifyIdToken(idToken: string, clientId: string, nonce: string): Promise<string | null> {
  try {
    const client = new OAuth2Client(clientId);
    const ticket = await client.verifyIdToken({ idToken, audience: clientId });
    const payload = ticket.getPayload();
    if (!payload || payload.iss !== 'https://accounts.google.com' && payload.iss !== 'accounts.google.com' ||
        payload.nonce !== nonce || payload.email_verified !== true || typeof payload.email !== 'string') return null;
    const email = payload.email.trim().toLowerCase();
    return EMAIL_RE.test(email) ? email : null;
  } catch {
    return null;
  }
}

async function defaultExchangeCode(code: string, verifier: string, config: AccessConfig): Promise<string | null> {
  try {
    const redirectUri = `${config.portalOrigin}/auth/google/callback`;
    const oauth = new OAuth2Client(config.googleClientId, config.googleClientSecret, redirectUri);
    const { tokens } = await oauth.getToken({ code, codeVerifier: verifier, redirect_uri: redirectUri });
    return tokens.id_token ?? null;
  } catch {
    return null;
  }
}

export async function createAccessService(options: AccessServiceOptions): Promise<AccessService> {
  const initial = await loadAccessConfig(options.configPath);
  const store = await AccessStore.open(initial.databasePath);
  const now = () => nowSeconds(options);
  const loginAttempts = new Map<string, { windowStarted: number; count: number }>();

  const allowLoginAttempt = (req: IncomingMessage): boolean => {
    const headerIp = req.headers['x-real-ip'];
    const observedIp = normalizeIp(typeof headerIp === 'string' ? headerIp : '') ??
      normalizeIp(req.socket.remoteAddress ?? '') ?? 'unknown';
    const current = now();
    let bucket = loginAttempts.get(observedIp);
    if (!bucket || bucket.windowStarted + FLOW_SECONDS <= current) {
      if (!bucket && loginAttempts.size >= 2048) {
        for (const [key, entry] of loginAttempts) {
          if (entry.windowStarted + FLOW_SECONDS <= current) loginAttempts.delete(key);
        }
        if (loginAttempts.size >= 2048) return false;
      }
      bucket = { windowStarted: current, count: 0 };
      loginAttempts.set(observedIp, bucket);
    }
    if (bucket.count >= 10) return false;
    bucket.count += 1;
    return true;
  };

  const currentConfig = async (): Promise<AccessConfig | null> => {
    try {
      const config = await loadAccessConfig(options.configPath);
      return config.databasePath === initial.databasePath ? config : null;
    } catch { return null; }
  };

  const sessionFor = async (req: IncomingMessage, config: AccessConfig) => {
    const id = cookieValue(req, SESSION_COOKIE);
    if (!id || !/^[A-Za-z0-9_-]{43}$/.test(id)) return null;
    const session = store.getSession(id, now());
    if (!session || !config.allowedEmails.includes(session.email)) return null;
    return { id, ...session };
  };

  const portal = createServer((req, res) => {
    void (async () => {
      store.cleanup(now());
      const config = await currentConfig();
      if (!config) { send(res, 503, page('Unavailable', '<p>Substream access is temporarily unavailable.</p>')); return; }
      if (!hostMatches(req, config.portalOrigin)) { send(res, 404, page('Not found', '<p>Page not found.</p>')); return; }
      if (!req.url?.startsWith('/') || req.url.startsWith('//')) { send(res, 404, page('Not found', '<p>Page not found.</p>')); return; }
      const url = new URL(req.url ?? '/', config.portalOrigin);
      if (req.method === 'GET' && url.pathname === '/branding/substream-icon.png') {
        try {
          const bytes = await readFile(options.brandingPath ?? new URL('../../public/branding/substream-icon.png', import.meta.url));
          res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': String(bytes.byteLength), 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
          res.end(bytes);
        } catch { send(res, 404, page('Not found', '<p>Page not found.</p>')); }
        return;
      }
      if (req.method === 'GET' && url.pathname === '/auth/google/login') {
        if (!allowLoginAttempt(req)) {
          send(res, 429, page('Try again later', '<p>Please wait before trying Google sign-in again.</p>'));
          return;
        }
        const state = randomOpaque();
        const nonce = randomOpaque();
        const verifier = randomOpaque();
        try { store.putFlow(state, { verifier, nonce, expiresAt: now() + FLOW_SECONDS }); }
        catch { send(res, 503, page('Unavailable', '<p>Substream access is temporarily unavailable.</p>')); return; }
        const oauth = new OAuth2Client(config.googleClientId, config.googleClientSecret, `${config.portalOrigin}/auth/google/callback`);
        const challenge = createHash('sha256').update(verifier).digest('base64url');
        const redirect = oauth.generateAuthUrl({
          scope: ['openid', 'email', 'profile'], response_type: 'code', state, nonce,
          code_challenge: challenge, code_challenge_method: CodeChallengeMethod.S256, prompt: 'select_account',
        });
        res.writeHead(302, {
          Location: redirect,
          'Set-Cookie': `${OAUTH_FLOW_COOKIE_PREFIX}${state}=${state}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=${FLOW_SECONDS}`,
          'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
        });
        res.end();
        return;
      }
      if (req.method === 'GET' && url.pathname === '/auth/google/callback') {
        const state = url.searchParams.get('state') ?? '';
        if (!/^[A-Za-z0-9_-]{43}$/.test(state) || cookieValue(req, `${OAUTH_FLOW_COOKIE_PREFIX}${state}`) !== state) {
          send(res, 401, page('Login failed', '<p>Google sign-in could not be completed. <a href="/auth/google/login">Try again</a>.</p>'));
          return;
        }
        const clearFlowCookie = `${OAUTH_FLOW_COOKIE_PREFIX}${state}=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
        let flow;
        try { flow = store.consumeFlow(state, now()); }
        catch { send(res, 503, page('Unavailable', '<p>Substream access is temporarily unavailable.</p>'), { 'Set-Cookie': clearFlowCookie }); return; }
        const code = url.searchParams.get('code') ?? '';
        if (!flow || !code || url.searchParams.has('error')) { send(res, 401, page('Login failed', '<p>Google sign-in could not be completed. <a href="/auth/google/login">Try again</a>.</p>'), { 'Set-Cookie': clearFlowCookie }); return; }
        try {
          const idToken = await (options.exchangeCode ?? defaultExchangeCode)(code, flow.verifier, config);
          if (!idToken) throw new Error('invalid_identity_token');
          const email = await (options.verifyIdToken ?? defaultVerifyIdToken)(idToken, config.googleClientId, flow.nonce);
          if (!email || !config.allowedEmails.includes(email)) { send(res, 403, page('Access denied', '<p>This Google account is not allowed to use Substream.</p>'), { 'Set-Cookie': clearFlowCookie }); return; }
          const session = store.createSession(email, now());
          res.writeHead(303, {
            Location: '/',
            'Set-Cookie': [
              `${SESSION_COOKIE}=${session.id}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200`,
              clearFlowCookie,
            ],
            'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
          });
          res.end();
        } catch {
          send(res, 401, page('Login failed', '<p>Google sign-in could not be completed. <a href="/auth/google/login">Try again</a>.</p>'), { 'Set-Cookie': clearFlowCookie });
        }
        return;
      }
      if (req.method === 'GET' && url.pathname === '/') {
        const session = await sessionFor(req, config);
        if (!session) {
          send(res, 200, page('Sign in', '<p>Sign in with an allowed Google account to create an eight-hour Substream access link for your current network.</p><a href="/auth/google/login">Continue with Google</a>'));
          return;
        }
        const grant = store.getGrant(session.email, now());
        const content = `<p>Signed in as <strong>${escapeHtml(session.email)}</strong>.</p>${grant
          ? `<h2>Access is active</h2><p>Bound to <code>${escapeHtml(grant.ip)}</code> until ${new Date(grant.expiresAt * 1000).toISOString()}.</p><p>Create a replacement link to show it again.</p>`
          : '<p>No active access link.</p>'}<form method="post" action="/access"><input type="hidden" name="csrf_token" value="${session.csrfToken}"><button type="submit">Create access link</button></form>${grant ? `<form method="post" action="/access/revoke"><input type="hidden" name="csrf_token" value="${session.csrfToken}"><button class="secondary" type="submit">Revoke access</button></form>` : ''}<form method="post" action="/logout"><input type="hidden" name="csrf_token" value="${session.csrfToken}"><button class="secondary" type="submit">Sign out</button></form><p class="small">Access links work for eight hours from the IP shown above. Anyone who has the link and shares that network can use it. HTTP playback can be observed or changed in transit.</p>`;
        send(res, 200, page('Access', content));
        return;
      }
      if (req.method === 'POST' && ['/access', '/access/revoke', '/logout'].includes(url.pathname)) {
        if (req.headers.origin !== config.portalOrigin) { send(res, 403, page('Request denied', '<p>Request denied.</p>')); return; }
        const session = await sessionFor(req, config);
        if (!session) { send(res, 401, page('Sign in required', '<p>Please sign in again. <a href="/auth/google/login">Continue with Google</a>.</p>')); return; }
        const form = await readForm(req);
        if (!form || !safeEqualDigest(form.get('csrf_token') ?? '', session.csrfToken)) { send(res, 403, page('Request denied', '<p>Request denied. Reload the page and try again.</p>')); return; }
        if (url.pathname === '/logout') {
          store.deleteSession(session.id);
          res.writeHead(303, { Location: '/', 'Set-Cookie': `${SESSION_COOKIE}=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`, 'Cache-Control': 'no-store', 'Referrer-Policy': 'same-origin' });
          res.end();
          return;
        }
        if (url.pathname === '/access/revoke') {
          store.revokeGrant(session.email, now());
          res.writeHead(303, { Location: '/', 'Cache-Control': 'no-store', 'Referrer-Policy': 'same-origin' }); res.end();
          return;
        }
        const xRealIp = req.headers['x-real-ip'];
        const clientIp = normalizeIp(typeof xRealIp === 'string' ? xRealIp : '');
        if (!clientIp) { send(res, 400, page('Request denied', '<p>A valid client address could not be determined.</p>')); return; }
        const grant = store.createOrReplaceGrant(session.email, clientIp, now());
        const link = `${config.playerOrigin}/${grant.token}/`;
        const content = `<h2>Access link created</h2><p>Valid for eight hours and bound to <code>${escapeHtml(clientIp)}</code>.</p><p><a href="${escapeHtml(link)}">Open Substream</a></p><p><code class="access-link">${escapeHtml(link)}</code></p><p><a class="secondary" href="/">Return to access page</a></p><p class="small">Anyone who has the link and shares this network can use it. HTTP playback can be observed or changed in transit.</p>`;
        send(res, 200, page('Link created', content));
        return;
      }
      send(res, 404, page('Not found', '<p>Page not found.</p>'));
    })().catch(() => {
      if (!res.headersSent) send(res, 500, page('Unavailable', '<p>Substream access is temporarily unavailable.</p>'));
      else res.destroy();
    });
  });

  const authorizer = createServer((req, res) => {
    void (async () => {
      const remote = req.socket.remoteAddress;
      const normalizedRemote = remote ? normalizeIp(remote) : null;
      if (!normalizedRemote || !['127.0.0.1', '::1'].includes(normalizedRemote) || req.method !== 'GET' || req.url !== '/authorize') {
        res.writeHead(403, { 'Cache-Control': 'no-store' }); res.end(); return;
      }
      const config = await currentConfig();
      if (!config) { res.writeHead(403, { 'Cache-Control': 'no-store' }); res.end(); return; }
      store.cleanup(now());
      const originalUri = req.headers['x-substream-original-uri'];
      const clientIp = req.headers['x-substream-client-ip'];
      const target = parseTarget(typeof originalUri === 'string' ? originalUri : '');
      const ip = normalizeIp(typeof clientIp === 'string' ? clientIp : '');
      if (!target || !ip) { res.writeHead(403, { 'Cache-Control': 'no-store' }); res.end(); return; }
      const allowed = store.authorize(target.token, ip, now(), (email) => config.allowedEmails.includes(email));
      res.writeHead(allowed ? 204 : 403, { 'Cache-Control': 'no-store' }); res.end();
    })().catch(() => { if (!res.headersSent) { res.writeHead(403, { 'Cache-Control': 'no-store' }); res.end(); } else res.destroy(); });
  });

  const listen = async () => {
    store.cleanup(now());
    await Promise.all([
      new Promise<void>((resolve, reject) => { portal.once('error', reject); portal.listen(options.portalPort ?? 8792, '127.0.0.1', resolve); }),
      new Promise<void>((resolve, reject) => { authorizer.once('error', reject); authorizer.listen(options.authPort ?? 8791, '127.0.0.1', resolve); }),
    ]);
  };
  const closeServer = (server: Server) => new Promise<void>((resolve, reject) => {
    if (!server.listening) { resolve(); return; }
    server.close((error) => error ? reject(error) : resolve());
  });
  const close = async () => { await Promise.all([closeServer(portal), closeServer(authorizer)]); store.close(); };
  return { portal, authorizer, store, listen, close };
}
