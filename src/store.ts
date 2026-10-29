import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes, createHash, createHmac } from 'node:crypto';
import { UserError, type SessionData } from './types.js';
export interface Tokens { access_token: string; refresh_token: string; expiresAt: number; scope: string }
export interface AudioSelection { url: string; title: string; artist: string; durationMs: number }
export interface SpotifyIdentity { id: string; name: string; product: 'premium'; checkedAt: number }
export interface PendingSpotify { token: Tokens; identity: SpotifyIdentity; nonce: string }
export class Store {
  private db: DatabaseSync;
  private key: Buffer;
  constructor(file: string, key: string) {
    if (!/^[a-fA-F0-9]{64}$/.test(key)) throw new Error('Invalid encryption key');
    this.key = Buffer.from(key, 'hex');
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS tokens (user_id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (guild_id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS oauth (state_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, verifier TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS spotify_accounts (user_id TEXT PRIMARY KEY, account_hash TEXT NOT NULL UNIQUE, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS spotify_pending (user_id TEXT PRIMARY KEY, payload TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS audio_sources (user_id TEXT NOT NULL, track_id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(user_id,track_id));`);
  }
  seal(value: string): string {
    const iv = randomBytes(12); const c = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([c.update(value, 'utf8'), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), data]).toString('base64');
  }
  open(value: string): string {
    const b = Buffer.from(value, 'base64'); const d = createDecipheriv('aes-256-gcm', this.key, b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28)); return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
  }
  token(user: string): Tokens | undefined {
    const r = this.db.prepare('SELECT payload FROM tokens WHERE user_id=?').get(user);
    return r ? JSON.parse(this.open(String(r.payload))) : undefined;
  }
  hasToken(user: string): boolean { return Boolean(this.db.prepare('SELECT 1 FROM tokens WHERE user_id=?').get(user)); }
  putToken(user: string, token: Tokens) { this.db.prepare('INSERT OR REPLACE INTO tokens VALUES (?,?)').run(user, this.seal(JSON.stringify(token))); }
  deleteToken(user: string) {
    this.db.prepare('DELETE FROM tokens WHERE user_id=?').run(user);
    this.db.prepare('DELETE FROM oauth WHERE user_id=?').run(user);
    this.db.prepare('DELETE FROM spotify_accounts WHERE user_id=?').run(user);
    this.db.prepare('DELETE FROM spotify_pending WHERE user_id=?').run(user);
    this.db.prepare('DELETE FROM audio_sources WHERE user_id=?').run(user);
  }
  audioSource(user: string, track: string): AudioSelection | undefined {
    const row = this.db.prepare('SELECT payload FROM audio_sources WHERE user_id=? AND track_id=?').get(user, track);
    return row ? JSON.parse(this.open(String(row.payload))) : undefined;
  }
  setAudioSource(user: string, track: string, selection: AudioSelection) {
    this.db.prepare('INSERT OR REPLACE INTO audio_sources VALUES (?,?,?)').run(user, track, this.seal(JSON.stringify({ url: selection.url, title: selection.title, artist: selection.artist, durationMs: selection.durationMs })));
  }
  identity(user: string): SpotifyIdentity | undefined {
    const row = this.db.prepare('SELECT payload FROM spotify_accounts WHERE user_id=?').get(user);
    return row ? JSON.parse(this.open(String(row.payload))) : undefined;
  }
  hasConnection(user: string): boolean { return this.hasToken(user) && Boolean(this.identity(user)); }
  private accountHash(id: string) { return createHmac('sha256', this.key).update(id).digest('hex'); }
  private assertAvailable(user: string, id: string) {
    const row = this.db.prepare('SELECT user_id FROM spotify_accounts WHERE account_hash=?').get(this.accountHash(id));
    if (row && row.user_id !== user) throw new UserError('Этот Spotify-аккаунт уже привязан к другому Discord-пользователю. Сначала отключите его через /spotify logout у прежней привязки.');
  }
  private atomic<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = work(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private writeConnection(user: string, token: Tokens, identity: SpotifyIdentity) {
    this.assertAvailable(user, identity.id);
    this.db.prepare(`INSERT INTO spotify_accounts VALUES (?,?,?) ON CONFLICT(user_id)
      DO UPDATE SET account_hash=excluded.account_hash,payload=excluded.payload`)
      .run(user, this.accountHash(identity.id), this.seal(JSON.stringify(identity)));
    this.putToken(user, token);
  }
  connect(user: string, token: Tokens, identity: SpotifyIdentity) {
    this.atomic(() => this.writeConnection(user, token, identity));
  }
  stageConnection(user: string, token: Tokens, identity: SpotifyIdentity) {
    this.assertAvailable(user, identity.id);
    this.db.prepare('DELETE FROM spotify_pending WHERE expires <= ?').run(Date.now());
    this.db.prepare('INSERT OR REPLACE INTO spotify_pending VALUES (?,?,?)')
      .run(user, this.seal(JSON.stringify({ token, identity, nonce: randomBytes(16).toString('hex') })), Date.now() + 600000);
  }
  pending(user: string): PendingSpotify | undefined {
    const row = this.db.prepare('SELECT payload,expires FROM spotify_pending WHERE user_id=?').get(user);
    return row && Number(row.expires) > Date.now() ? JSON.parse(this.open(String(row.payload))) : undefined;
  }
  confirmConnection(user: string, nonce: string, verified: SpotifyIdentity) {
    this.atomic(() => {
      const pending = this.pending(user);
      if (!pending || pending.nonce !== nonce || pending.identity.id !== verified.id) throw new UserError('Подтверждение устарело. Выполните /spotify login заново.');
      this.writeConnection(user, pending.token, verified);
      this.db.prepare('DELETE FROM spotify_pending WHERE user_id=?').run(user);
    });
  }
  oauth(user: string, verifier: string): string {
    const state = randomBytes(32).toString('base64url');
    this.db.prepare('DELETE FROM spotify_pending WHERE user_id=?').run(user);
    this.db.prepare('DELETE FROM oauth WHERE expires < ? OR user_id=?').run(Date.now(), user);
    this.db.prepare('INSERT INTO oauth VALUES (?,?,?,?)').run(this.hash(state), user, this.seal(verifier), Date.now() + 600000);
    return state;
  }
  oauthUser(state: string): string | undefined {
    const r = this.db.prepare('SELECT user_id FROM oauth WHERE state_hash=? AND expires>?').get(this.hash(state), Date.now());
    return r ? String(r.user_id) : undefined;
  }
  consumeOAuth(state: string): { user: string; verifier: string } | undefined {
    const row = this.db.prepare('DELETE FROM oauth WHERE state_hash=? RETURNING *').get(this.hash(state));
    if (!row || Number(row.expires) < Date.now()) return;
    return { user: String(row.user_id), verifier: this.open(String(row.verifier)) };
  }
  private hash(value: string) { return createHash('sha256').update(value).digest('hex'); }
  save(s: SessionData) { this.db.prepare('INSERT OR REPLACE INTO sessions VALUES (?,?)').run(s.guildId, JSON.stringify(s)); }
  sessions(): SessionData[] { return this.db.prepare('SELECT payload FROM sessions').all().map(r => JSON.parse(String(r.payload))); }
  remove(guild: string) { this.db.prepare('DELETE FROM sessions WHERE guild_id=?').run(guild); }
  close() { this.db.close(); }
}
