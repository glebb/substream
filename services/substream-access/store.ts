import { createHash, randomBytes } from 'node:crypto';
import { mkdir, chmod, open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const GRANT_SECONDS = 8 * 60 * 60;
export const SESSION_SECONDS = 12 * 60 * 60;
export const FLOW_SECONDS = 10 * 60;

export function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function randomOpaque(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export interface SessionRecord { email: string; csrfToken: string; expiresAt: number; }
export interface FlowRecord { verifier: string; nonce: string; expiresAt: number; }
export interface GrantRecord { email: string; ip: string; expiresAt: number; }

export class AccessStore {
  readonly db: DatabaseSync;

  private constructor(db: DatabaseSync) { this.db = db; }

  static async open(path: string): Promise<AccessStore> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await chmod(dirname(path), 0o700);
    const privateFile = await open(path, 'a', 0o600);
    await privateFile.close();
    const db = new DatabaseSync(path);
    try {
      await chmod(path, 0o600);
      db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;');
      db.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
          id_hash TEXT PRIMARY KEY,
          email TEXT NOT NULL,
          csrf_token TEXT NOT NULL,
          expires_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
        CREATE TABLE IF NOT EXISTS oauth_flows (
          state_hash TEXT PRIMARY KEY,
          verifier TEXT NOT NULL,
          nonce TEXT NOT NULL,
          expires_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS oauth_flows_expiry ON oauth_flows(expires_at);
        CREATE TABLE IF NOT EXISTS grants (
          email TEXT PRIMARY KEY,
          token_hash TEXT NOT NULL UNIQUE,
          ip TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          revoked_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS grants_expiry ON grants(expires_at);
      `);
      return new AccessStore(db);
    } catch (error) {
      db.close();
      throw error;
    }
  }

  cleanup(now: number): void {
    this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
    this.db.prepare('DELETE FROM oauth_flows WHERE expires_at <= ?').run(now);
    this.db.prepare('DELETE FROM grants WHERE expires_at <= ?').run(now);
  }

  putFlow(state: string, flow: FlowRecord): void {
    this.db.prepare('INSERT INTO oauth_flows(state_hash, verifier, nonce, expires_at) VALUES (?, ?, ?, ?)')
      .run(digest(state), flow.verifier, flow.nonce, flow.expiresAt);
  }

  consumeFlow(state: string, now: number): FlowRecord | null {
    const hash = digest(state);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT verifier, nonce, expires_at FROM oauth_flows WHERE state_hash = ?').get(hash) as
        { verifier: string; nonce: string; expires_at: number } | undefined;
      this.db.prepare('DELETE FROM oauth_flows WHERE state_hash = ?').run(hash);
      this.db.exec('COMMIT');
      if (!row || row.expires_at <= now) return null;
      return { verifier: row.verifier, nonce: row.nonce, expiresAt: row.expires_at };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  createSession(email: string, now: number): { id: string; csrf: string; expiresAt: number } {
    const id = randomOpaque();
    const csrf = randomOpaque();
    const expiresAt = now + SESSION_SECONDS;
    this.db.prepare('INSERT INTO sessions(id_hash, email, csrf_token, expires_at) VALUES (?, ?, ?, ?)')
      .run(digest(id), email, csrf, expiresAt);
    return { id, csrf, expiresAt };
  }

  getSession(id: string, now: number): SessionRecord | null {
    const row = this.db.prepare('SELECT email, csrf_token, expires_at FROM sessions WHERE id_hash = ?').get(digest(id)) as
      { email: string; csrf_token: string; expires_at: number } | undefined;
    if (!row || row.expires_at <= now) {
      if (row) this.db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(digest(id));
      return null;
    }
    return { email: row.email, csrfToken: row.csrf_token, expiresAt: row.expires_at };
  }

  deleteSession(id: string): void { this.db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(digest(id)); }

  createOrReplaceGrant(email: string, ip: string, now: number): { token: string; expiresAt: number } {
    const token = randomOpaque();
    const expiresAt = now + GRANT_SECONDS;
    this.db.prepare(`INSERT INTO grants(email, token_hash, ip, created_at, expires_at, revoked_at)
      VALUES (?, ?, ?, ?, ?, NULL)
      ON CONFLICT(email) DO UPDATE SET token_hash=excluded.token_hash, ip=excluded.ip,
      created_at=excluded.created_at, expires_at=excluded.expires_at, revoked_at=NULL`)
      .run(email, digest(token), ip, now, expiresAt);
    return { token, expiresAt };
  }

  revokeGrant(email: string, now: number): boolean {
    return this.db.prepare('UPDATE grants SET revoked_at = ? WHERE email = ? AND revoked_at IS NULL')
      .run(now, email).changes > 0;
  }

  getGrant(email: string, now: number): GrantRecord | null {
    const row = this.db.prepare('SELECT email, ip, expires_at FROM grants WHERE email = ? AND revoked_at IS NULL AND expires_at > ?')
      .get(email, now) as { email: string; ip: string; expires_at: number } | undefined;
    return row ? { email: row.email, ip: row.ip, expiresAt: row.expires_at } : null;
  }

  authorize(token: string, ip: string, now: number, allowed: (email: string) => boolean): boolean {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return false;
    const row = this.db.prepare(`SELECT email, ip FROM grants
      WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?`).get(digest(token), now) as
      { email: string; ip: string } | undefined;
    return Boolean(row && row.ip === ip && allowed(row.email));
  }

  close(): void { this.db.close(); }
}
