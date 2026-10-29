import { readFileSync, realpathSync, statSync, existsSync } from 'node:fs';
import { resolve, relative, isAbsolute, extname } from 'node:path';
import { UserError, type AudioTrack, spotifyTrackId } from './types.js';
export class Catalog {
  private tracks = new Map<string, AudioTrack>();
  constructor(private root: string, file: string) {
    if (!existsSync(file)) return;
    const list: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!Array.isArray(list)) throw new Error('Аудиокаталог должен быть JSON-массивом.');
    const spotifyIds = new Set<string>();
    for (const row of list) {
      if (!row || typeof row !== 'object') throw new Error('Некорректная запись каталога');
      const t = row as AudioTrack;
      for (const k of ['id', 'title', 'artist', 'file', 'rights'] as const) {
        if (typeof t[k] !== 'string' || !t[k].trim()) throw new Error(`Каталог: обязательное поле ${k}`);
      }
      if (!/^[a-zA-Z0-9_-]{1,80}$/.test(t.id) || this.tracks.has(t.id)) throw new Error('Повторный или некорректный ID каталога.');
      if (!Number.isFinite(t.durationMs) || t.durationMs <= 0) throw new Error(`Укажите durationMs для ${t.id}.`);
      if (t.spotifyTrackId && (!/^[A-Za-z0-9]{22}$/.test(t.spotifyTrackId) || spotifyIds.has(t.spotifyTrackId))) throw new Error('Некорректный или повторный spotifyTrackId.');
      if (t.spotifyTrackId) spotifyIds.add(t.spotifyTrackId);
      this.safeFile(t.file); this.tracks.set(t.id, { ...t });
    }
  }
  private safeFile(file: string) {
    const root = realpathSync(this.root); const path = realpathSync(resolve(root, file));
    const rel = relative(root, path);
    if (!rel || rel.startsWith('..') || isAbsolute(rel) || !statSync(path).isFile() ||
        !['.mp3', '.wav', '.flac', '.ogg', '.m4a', '.opus', '.aac'].includes(extname(path).toLowerCase())) {
      throw new UserError('Аудиофайл должен находиться внутри AUDIO_ROOT и иметь поддерживаемое расширение.');
    }
    return path;
  }
  file(id: string): string { return this.safeFile(this.get(id).file); }
  get(id: string): AudioTrack {
    const t = this.tracks.get(id); if (!t) throw new UserError('Композиция отсутствует в разрешённом каталоге.'); return { ...t };
  }
  all(): AudioTrack[] { return [...this.tracks.values()].map(t => ({ ...t })); }
  resolve(query: string): AudioTrack {
    const id = spotifyTrackId(query);
    if (query.startsWith('https:') || query.startsWith('spotify:')) {
      if (!id) throw new UserError('Поддерживается ссылка на отдельный Spotify-трек; альбомы, плейлисты и короткие ссылки не поддерживаются.');
      const t = this.all().find(t => t.spotifyTrackId === id);
      if (!t) throw new UserError('Для этого Spotify-трека нет явно сопоставленного разрешённого аудио. Другую песню воспроизводить не буду.');
      return t;
    }
    const direct = this.tracks.get(query); if (direct) return { ...direct };
    const norm = (s: string) => s.normalize('NFKC').toLocaleLowerCase().trim();
    const matches = this.all().filter(t => norm(`${t.artist} - ${t.title}`) === norm(query) || norm(t.title) === norm(query));
    if (matches.length !== 1) throw new UserError('Нет однозначного совпадения. Укажите ID из каталога или точное «Исполнитель - Название».');
    return matches[0];
  }
}
