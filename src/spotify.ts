import { createHash, randomBytes } from 'node:crypto';
import { config, requireSpotify } from './config.js';
import { Store, type Tokens, type SpotifyIdentity } from './store.js';
import { UserError, type Track, type Playback, type QueueSnapshot } from './types.js';
const scopes = 'user-read-private user-read-playback-state user-read-currently-playing';
export function asTrack(t: any): Track {
  return { id: t.id, title: String(t.name), artist: (t.artists || []).map((a: any) => a.name).join(', '),
    durationMs: Number(t.duration_ms) || 0, image: t.album?.images?.[0]?.url, url: t.external_urls?.spotify };
}
export class Spotify {
  private refreshes = new Map<string, Promise<Tokens>>();
  private generations = new Map<string, number>();
  private retryAt = 0;
  private queueCache = new Map<string, { until: number; result: Promise<QueueSnapshot> }>();
  private cache = new Map<string, { until: number; result: Promise<Playback> }>();
  constructor(readonly store: Store, private transport: typeof fetch = fetch) {}
  login(user: string): string {
    this.generations.set(user, (this.generations.get(user) || 0) + 1);
    requireSpotify(); const verifier = randomBytes(48).toString('base64url');
    const state = this.store.oauth(user, verifier);
    const u = new URL('https://accounts.spotify.com/authorize');
    u.search = new URLSearchParams({ client_id: config.spotifyId, response_type: 'code', redirect_uri: config.redirect,
      scope: scopes, state, show_dialog: 'true', code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url') }).toString();
    // The confirmation page protects against link previews consuming the authorization flow.
    const local = new URL('/authorize', config.publicBase); local.searchParams.set('url', u.href);
    return local.href;
  }
  async callback(state: string, code: string): Promise<SpotifyIdentity> {
    const pending = this.store.consumeOAuth(state);
    if (!pending) throw new UserError('Ссылка устарела или уже использована. Выполните /spotify login снова.');
    const generation = this.generations.get(pending.user) || 0;
    const token = await this.exchange(new URLSearchParams({ grant_type: 'authorization_code', code,
      redirect_uri: config.redirect, code_verifier: pending.verifier }));
    const identity = this.profile(await this.request(token.access_token, '/me'));
    if ((this.generations.get(pending.user) || 0) !== generation) throw new UserError('Авторизация отменена выходом из аккаунта.');
    this.store.stageConnection(pending.user, token, identity);
    return identity;
  }
  logout(user: string) {
    this.generations.set(user, (this.generations.get(user) || 0) + 1);
    this.cache.delete(user); this.queueCache.delete(user); this.refreshes.delete(user); this.store.deleteToken(user);
  }
  private async exchange(body: URLSearchParams, old?: Tokens): Promise<Tokens> {
    requireSpotify();
    if (Date.now() < this.retryAt) throw new UserError('Spotify ограничил частоту запросов. Подождите.');
    const r = await this.transport('https://accounts.spotify.com/api/token', { method: 'POST',
      headers: { Authorization: `Basic ${Buffer.from(`${config.spotifyId}:${config.spotifySecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(12000) });
    if (r.status === 429) this.rateLimit(r);
    if (!r.ok) throw new UserError(r.status === 400 || r.status === 401 ? 'Spotify отклонил авторизацию. Проверьте настройки приложения или выполните /spotify login.' : 'Сервис авторизации Spotify временно недоступен.');
    const t: any = await r.json();
    if (!t.access_token || !(t.refresh_token || old?.refresh_token) || !Number.isFinite(Number(t.expires_in)) || Number(t.expires_in) <= 0) throw new UserError('Spotify вернул неполные данные авторизации.');
    return { access_token: t.access_token, refresh_token: t.refresh_token || old!.refresh_token,
      expiresAt: Date.now() + Number(t.expires_in) * 1000, scope: t.scope || old?.scope || scopes };
  }
  private async token(user: string, force = false): Promise<Tokens> {
    const t = this.store.token(user);
    if (!t) throw new UserError('Ведущему нужно выполнить /spotify login.');
    if (!force && t.expiresAt > Date.now() + 60000) return t;
    const existing = this.refreshes.get(user); if (existing) return existing;
    const generation = this.generations.get(user) || 0;
    const p = this.exchange(new URLSearchParams({ grant_type: 'refresh_token', refresh_token: t.refresh_token }), t)
      .then(value => {
        if ((this.generations.get(user) || 0) !== generation) throw new UserError('Spotify отключён.');
        this.store.putToken(user, value); return value;
      }).finally(() => { if (this.refreshes.get(user) === p) this.refreshes.delete(user); });
    this.refreshes.set(user, p); return p;
  }
  private rateLimit(r: Response): never {
    const seconds = Number(r.headers.get('retry-after'));
    this.retryAt = Date.now() + (Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 86400) : 30) * 1000;
    throw new UserError('Лимит Spotify API: повторные запросы отложены согласно Retry-After.');
  }
  private profile(p: any): SpotifyIdentity {
    if (typeof p?.id !== 'string' || !p.id || p.id.length > 256) throw new UserError('Spotify не подтвердил идентификатор аккаунта. Выполните /spotify login заново.');
    if (typeof p.product !== 'string' || !p.product) throw new UserError('Spotify не вернул тип подписки. Проверить Premium через API не удалось; подключение отклонено. Проверьте scope user-read-private и ограничения приложения.');
    if (p.product !== 'premium') throw new UserError('Для подключения нужен Spotify Premium. Бесплатный аккаунт не подключён; прежняя привязка сохранена, если она была.');
    return { id: p.id, name: String(p.display_name || p.id).slice(0, 100), product: 'premium', checkedAt: Date.now() };
  }
  private async request(access: string, path: string): Promise<any> {
    if (Date.now() < this.retryAt) throw new UserError('Spotify ограничил частоту запросов. Подождите.');
    const r = await this.transport(`https://api.spotify.com/v1${path}`, { headers: { Authorization: `Bearer ${access}` }, signal: AbortSignal.timeout(12000) });
    if (r.status === 429) this.rateLimit(r);
    if (r.status === 401) throw new SpotifyUnauthorized();
    if (r.status === 204) return null;
    if (r.status === 403) {
      const body = await r.text();
      let message = '';
      try {
        const error = JSON.parse(body);
        message = typeof error?.error?.message === 'string' ? error.error.message : typeof error?.error_description === 'string' ? error.error_description : '';
      } catch {
        // Spotify sometimes returns a plain-text allowlist denial instead of JSON.
        if (!body.includes('<')) message = body;
      }
      const reason = message
        .replace(/Bearer\s+\S+/gi, 'Bearer [скрыто]')
        .replace(/(?:access_token|refresh_token|client_secret|authorization|code|state)\s*[:=]\s*[^\s,;]+/gi, '[секрет скрыт]')
        .replace(/https?:\/\/\S+/gi, '[адрес скрыт]')
        .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email скрыт]')
        .replace(/[A-Za-z0-9_+/.=-]{40,}/g, '[значение скрыто]')
        .replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 250);
      let hint = 'Проверьте доступ пользователя и владельца приложения в Dashboard и ограничения Development Mode.';
      if (/not registered|not.*(?:allowlist|whitelist)|not.*added.*(?:dashboard|app)/i.test(message)) {
        hint = 'Добавьте именно этот Spotify-аккаунт в User Management приложения и начните новый /spotify login.';
      } else if (/premium/i.test(message)) {
        hint = 'Проверьте требование Premium для используемого аккаунта и владельца Developer-приложения.';
      } else if (/scope|permission/i.test(message)) {
        hint = 'Выполните новый /spotify login и разрешите запрошенные права доступа.';
      }
      throw new UserError(`Spotify запретил операцию (HTTP 403, ${path}). ${reason ? `Причина Spotify: ${reason}. ` : 'Spotify не вернул подробную причину. '}${hint}`);
    }
    if (!r.ok) throw new UserError(`Spotify API недоступен (HTTP ${r.status}).`);
    return r.json();
  }
  private async authenticated(user: string, path: string, retry = true): Promise<any> {
    const token = await this.token(user);
    try { return await this.request(token.access_token, path); }
    catch (error) {
      if (error instanceof SpotifyUnauthorized) {
        if (retry) { await this.token(user, true); return this.authenticated(user, path, false); }
        throw new UserError('Spotify API недоступен (HTTP 401). Выполните /spotify login заново.');
      }
      throw error;
    }
  }
  async confirm(user: string, nonce: string): Promise<SpotifyIdentity> {
    const pending = this.store.pending(user);
    if (!pending || pending.nonce !== nonce) throw new UserError('Нет действующего подтверждения. Выполните /spotify login.');
    const generation = this.generations.get(user) || 0;
    const identity = this.profile(await this.request(pending.token.access_token, '/me'));
    if ((this.generations.get(user) || 0) !== generation) throw new UserError('Подтверждение отменено.');
    this.store.confirmConnection(user, nonce, identity);
    this.generations.set(user, generation + 1); this.refreshes.delete(user); this.cache.delete(user); this.queueCache.delete(user);
    return identity;
  }
  async api(user: string, path: string): Promise<any> {
    const identity = this.store.identity(user);
    if (!identity) throw new UserError('Выполните /spotify login и подтвердите свой аккаунт через /spotify confirm.');
    if (Date.now() - identity.checkedAt > 300000) {
      const generation = this.generations.get(user) || 0;
      const updated = this.profile(await this.authenticated(user, '/me'));
      if (updated.id !== identity.id || (this.generations.get(user) || 0) !== generation) throw new UserError('Spotify-привязка изменилась. Повторите вход.');
      this.store.connect(user, this.store.token(user)!, updated);
    }
    return this.authenticated(user, path);
  }
  async track(user: string, id: string): Promise<Track> { return asTrack(await this.api(user, `/tracks/${encodeURIComponent(id)}`)); }
  playback(user: string): Promise<Playback> {
    const c = this.cache.get(user); if (c && c.until > Date.now()) return c.result;
    const result = this.api(user, '/me/player').then(p => ({
      track: p?.item?.type === 'track' ? asTrack(p.item) : null,
      playing: Boolean(p?.is_playing), progressMs: p?.progress_ms || 0, fetchedAt: Date.now(), device: p?.device?.name
    }));
    this.cache.set(user, { until: Date.now() + config.pollMs - 100, result }); return result;
  }
  queueSnapshot(user: string): Promise<QueueSnapshot> {
    const cached = this.queueCache.get(user);
    if (cached && cached.until > Date.now()) return cached.result;
    const result = this.api(user, '/me/player/queue').then(q => {
      const supported = (t: any) => t?.type === 'track' && typeof t.id === 'string' && t.id.length > 0;
      if (!q) throw new UserError('Spotify не вернул очередь. Откройте плеер на активном устройстве.');
      if (!Array.isArray(q.queue)) throw new UserError('Spotify вернул некорректный снимок очереди.');
      return { current: supported(q?.currently_playing) ? asTrack(q.currently_playing) : null,
        upcoming: (q?.queue || []).filter(supported).map(asTrack), fetchedAt: Date.now() };
    });
    this.queueCache.set(user, { until: Date.now() + config.pollMs - 100, result });
    return result;
  }
  async queue(user: string): Promise<Track[]> {
    return (await this.queueSnapshot(user)).upcoming.map(track => ({ ...track }));
  }
}

class SpotifyUnauthorized extends UserError { constructor() { super('Spotify отклонил авторизацию (HTTP 401). Выполните /spotify login заново.'); } }
