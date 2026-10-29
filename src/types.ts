export type Mode = 'real' | 'voice' | 'mirror';
export interface Track { id: string; title: string; artist: string; durationMs: number; image?: string; url?: string }
export interface AudioTrack extends Track { file: string; rights: string; spotifyTrackId?: string }
export interface Playback { track: Track | null; playing: boolean; progressMs: number; fetchedAt: number; device?: string }
export interface QueueSnapshot { current: Track | null; upcoming: Track[]; fetchedAt: number }
export interface SessionData {
  guildId: string; ownerId: string; mode: Mode; voiceChannelId: string;
  textChannelId: string; messageId?: string; jamUrl?: string; source?: 'spotify';
  queue: string[]; currentId?: string; positionMs: number; paused: boolean;
}
export class UserError extends Error {}
export function progress(position: number, duration: number): string {
  const ratio = duration > 0 ? Math.max(0, Math.min(1, position / duration)) : 0;
  const at = Math.min(11, Math.floor(ratio * 12));
  const bar = Array.from({ length: 12 }, (_, i) => i === at ? '🔘' : '▬').join('');
  const time = (ms: number) => `${Math.floor(Math.max(0, ms) / 60000)}:${String(Math.floor(Math.max(0, ms) / 1000) % 60).padStart(2, '0')}`;
  return `${bar}\n${time(position)} / ${time(duration)}`;
}
export function jamLink(value: string): string {
  let u: URL;
  try { u = new URL(value); } catch { throw new UserError('Нужна HTTPS-ссылка приглашения Spotify Jam.'); }
  if (u.protocol !== 'https:' || u.username || u.password || u.port ||
      !((u.hostname === 'spotify.link' && /^\/[A-Za-z0-9]+$/.test(u.pathname)) ||
        (u.hostname === 'open.spotify.com' && /^\/jam\/[A-Za-z0-9_-]+\/?$/.test(u.pathname)))) {
    throw new UserError('Допустимы только https://spotify.link/… или https://open.spotify.com/jam/… .');
  }
  return u.href;
}
export function spotifyTrackId(value: string): string | undefined {
  const uri = /^spotify:track:([A-Za-z0-9]{22})$/.exec(value);
  if (uri) return uri[1];
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.hostname !== 'open.spotify.com' || u.username || u.password || u.port) return;
    return /^\/(?:intl-[a-z]+\/)?track\/([A-Za-z0-9]{22})\/?$/.exec(u.pathname)?.[1];
  } catch { return; }
}
export function exclusive<T>() {
  let tail: Promise<unknown> = Promise.resolve();
  return (work: () => Promise<T>): Promise<T> => {
    const result = tail.then(work); tail = result.catch(() => {}); return result;
  };
}
