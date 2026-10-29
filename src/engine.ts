import { Readable } from 'node:stream';
import { config } from './config.js';
import { Store } from './store.js';
import { Voice } from './voice.js';
import { UserError, type Playback, type Track } from './types.js';
export interface EngineCandidate { id: string; title: string; artist: string; durationMs: number; url: string }
export function sourceUrl(value: string): string {
  const u = new URL(value);
  if (u.protocol !== 'https:' || u.username || u.password || u.port || !['youtube.com','www.youtube.com','music.youtube.com','m.youtube.com','youtu.be','soundcloud.com','www.soundcloud.com'].includes(u.hostname)) throw new UserError('Неподдерживаемый URL аудиоисточника.');
  return u.href;
}
export class EngineClient {
  constructor(private transport: typeof fetch = fetch) {}
  private url(path: string, values: Record<string, string>) {
    const u = new URL(path, `http://127.0.0.1:${config.enginePort}`); u.search = new URLSearchParams(values).toString(); return u;
  }
  private async json(path: string, values: Record<string, string>): Promise<EngineCandidate[]> {
    if (!config.engineKey) throw new UserError('Аудиодвижок не настроен: запускайте через start-with-tunnel.mjs.');
    let r: Response;
    try { r = await this.transport(this.url(path, values), { headers: { 'X-Engine-Key': config.engineKey }, signal: AbortSignal.timeout(22000) }); }
    catch { throw new UserError('Аудиодвижок не ответил. Проверьте его журнал и доступ к выбранному источнику.'); }
    if (!r.ok) throw await this.failure(r);
    const data: any = await r.json();
    if (!Array.isArray(data.candidates)) throw new UserError('Некорректный ответ аудиодвижка.');
    return data.candidates.slice(0, 4).map((c: any) => {
      if (!c || typeof c.id !== 'string' || !/^[a-f0-9-]{36}$/i.test(c.id) || typeof c.title !== 'string' || typeof c.artist !== 'string' || !Number.isFinite(c.durationMs) || c.durationMs <= 0) throw new UserError('Некорректный кандидат аудио.');
      return { id: c.id, title: c.title.slice(0, 200), artist: c.artist.slice(0, 150), durationMs: c.durationMs, url: sourceUrl(c.url) };
    });
  }
  private async failure(response: Response): Promise<UserError> {
    const hints: Record<string, string> = {
      source_auth_required: 'Источник требует входа или проверки доступа. Автоматического обхода нет; выберите другой разрешённый источник.',
      source_access_denied: 'Источник запретил доступ с сервера (регион, сеть или разрешения).',
      source_rate_limited: 'Источник ограничил частоту запросов. Повторите позже.',
      source_module_update_needed: 'Источник изменил протокол; требуется обновление аудиомодуля.',
      source_timeout: 'Аудиоисточник не ответил вовремя.',
      stream_limit: 'Достигнут лимит одновременных аудиопотоков этого сервера.',
      track_expired: 'Ссылка аудиодвижка устарела. Выберите источник повторно.'
    };
    let code = ''; try { code = (await response.json() as any).error; } catch {}
    return new UserError(hints[code] || `Аудиоисточник недоступен (движок HTTP ${response.status}).`);
  }
  async search(track: Track): Promise<EngineCandidate[]> {
    const candidates = await this.json('/search', { query: `${track.artist.slice(0, 150)} - ${track.title.slice(0, 180)}`, source: config.engineSource });
    // Similar duration is a necessary filter, never proof that two recordings are identical.
    return candidates.filter(c => Math.abs(c.durationMs - track.durationMs) <= Math.max(3000, track.durationMs * .02));
  }
  async load(url: string) { return (await this.json('/load', { url: sourceUrl(url) }))[0]; }
  async stream(id: string, position: number): Promise<Readable> {
    if (!/^[a-f0-9-]{36}$/i.test(id)) throw new UserError('Некорректный ID аудио.');
    const abort = new AbortController(); const timeout = setTimeout(() => abort.abort(), 15000);
    try {
      const r = await this.transport(this.url('/stream', { id, position: String(Math.floor(position)) }), { headers: { 'X-Engine-Key': config.engineKey }, signal: abort.signal });
      if (!r.ok) { const error = await this.failure(r); abort.abort(); throw error; }
      if (!r.body || !r.headers.get('content-type')?.startsWith('application/octet-stream')) { abort.abort(); throw new UserError('Аудиодвижок не вернул PCM-аудиопоток.'); }
      const stream = Readable.fromWeb(r.body as any); stream.once('close', () => abort.abort()); return stream;
    } catch (error) { abort.abort(); throw error; }
    finally { clearTimeout(timeout); }
  }
}
export class EngineFollower {
  private active?: string;
  private paused = false;
  private loaded?: { spotifyId: string; candidate: EngineCandidate; at: number };
  private endedId?: string;
  private retryAt = 0;
  private retryTrack?: string;
  private lastError = '';
  constructor(private voice: Voice, private client: EngineClient, private store: Store, private owner: string) {}
  audioStatus(): 'playing' | 'paused' | 'unavailable' { return this.active && this.voice.ready() ? this.paused ? 'paused' : 'playing' : 'unavailable'; }
  ended() { this.endedId = this.active; this.active = undefined; }
  private stop() { this.voice.stop(); this.active = undefined; }
  reset() { this.loaded = undefined; this.endedId = undefined; this.retryAt = 0; this.lastError = ''; this.stop(); }
  async sync(p?: Playback): Promise<string> {
    if (!p?.track) { this.stop(); return ''; }
    const track = p.track;
    if (this.endedId && this.endedId !== track.id) this.endedId = undefined;
    const selection = this.store.audioSource(this.owner, track.id);
    if (!selection) { this.stop(); return 'Для этой песни ещё не подтверждён аудиоисточник. Нажмите «Выбрать источник», проверьте запись и право её трансляции.'; }
    if (!this.voice.ready()) { this.stop(); return 'Ожидание голосового соединения.'; }
    if (this.retryTrack !== track.id) { this.retryTrack = track.id; this.retryAt = 0; this.lastError = ''; }
    if (Date.now() < this.retryAt) { this.stop(); return this.lastError; }
    if (this.endedId === track.id) { this.stop(); return 'Аудиоисточник завершился или отказал. Выберите другой источник.'; }
    try {
      if (!this.loaded || this.loaded.spotifyId !== track.id || Date.now() - this.loaded.at > 600000) {
        const candidate = await this.client.load(selection.url);
        if (!candidate || candidate.title !== selection.title || candidate.artist !== selection.artist || Math.abs(candidate.durationMs - selection.durationMs) > 2000) throw new UserError('Запись источника изменилась. Подтвердите источник заново.');
        this.loaded = { spotifyId: track.id, candidate, at: Date.now() };
      }
      if (Date.now() - p.fetchedAt > config.pollMs * 2) { this.stop(); return 'Ожидание свежего состояния Spotify после загрузки источника.'; }
      const position = Math.max(0, p.progressMs + (p.playing ? Date.now() - p.fetchedAt : 0));
      if (position >= Math.min(track.durationMs, this.loaded.candidate.durationMs) - 100) { this.stop(); return 'Ожидание следующей композиции.'; }
      if (this.active !== track.id || Math.abs(this.voice.position() - position) > 2500) {
        this.stop();
        const stream = await this.client.stream(this.loaded.candidate.id, position);
        this.voice.playPcm(stream, position, !p.playing); this.active = track.id; this.paused = !p.playing;
      } else if (this.paused !== !p.playing) {
        if (p.playing) this.voice.resume(); else this.voice.pause(); this.paused = !p.playing;
      }
      return '';
    } catch (error) {
      this.stop(); this.retryAt = Date.now() + 30000;
      this.lastError = `${error instanceof UserError ? error.message : 'Аудиоисточник не ответил.'} Повтор отложен на 30 секунд; можно выбрать другой источник.`;
      return this.lastError;
    }
  }
}
