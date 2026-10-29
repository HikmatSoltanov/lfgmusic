import 'dotenv/config';
import { resolve } from 'node:path';
import { UserError } from './types.js';
function number(name: string, fallback: number, min: number, max: number) {
  const n = Number(process.env[name] || fallback);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name}: требуется целое ${min}..${max}`);
  return n;
}
export const config = {
  discordToken: process.env.DISCORD_TOKEN || '', clientId: process.env.DISCORD_CLIENT_ID || '',
  guildId: process.env.DISCORD_GUILD_ID || '', spotifyId: process.env.SPOTIFY_CLIENT_ID || '',
  spotifySecret: process.env.SPOTIFY_CLIENT_SECRET || '',
  redirect: process.env.SPOTIFY_REDIRECT_URI || 'http://127.0.0.1:8888/callback',
  publicBase: (process.env.PUBLIC_BASE_URL || 'http://127.0.0.1:8888').replace(/\/$/, ''),
  host: process.env.HTTP_HOST || '127.0.0.1', port: number('HTTP_PORT', 8888, 1, 65535),
  key: process.env.TOKEN_ENCRYPTION_KEY || '', db: resolve(process.env.DATABASE_PATH || './data/bot.sqlite'),
  audioRoot: resolve(process.env.AUDIO_ROOT || './media'), catalog: resolve(process.env.AUDIO_CATALOG || './media/catalog.json'),
  engineEnabled: process.env.MUSIC_ENGINE_ENABLED === '1',
  enginePort: number('MUSIC_ENGINE_PORT', 2334, 1024, 65535),
  engineKey: process.env.MUSIC_ENGINE_KEY || '',
  engineSource: process.env.MUSIC_ENGINE_SOURCE || 'youtube',
  ffmpeg: process.env.FFMPEG_PATH || 'ffmpeg', pollMs: number('SPOTIFY_POLL_MS', 5000, 3000, 120000),
  embedMs: number('EMBED_UPDATE_MS', 15000, 10000, 120000)
};
export function requireSpotify() {
  if (!config.spotifyId || !config.spotifySecret) throw new UserError('Администратор должен настроить SPOTIFY_CLIENT_ID и SPOTIFY_CLIENT_SECRET в .env.');
}
export function validateStartup() {
  if (!config.discordToken || !/^\d+$/.test(config.clientId)) throw new Error('Настройте DISCORD_TOKEN и DISCORD_CLIENT_ID в .env.');
  if (!/^[a-fA-F0-9]{64}$/.test(config.key)) throw new Error('TOKEN_ENCRYPTION_KEY должен содержать 64 hex-символа (32 случайных байта).');
  for (const value of [config.redirect, config.publicBase]) {
    const u = new URL(value);
    if (u.username || u.password || (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(u.hostname)))) {
      throw new Error('OAuth URL: HTTPS либо HTTP с IP loopback 127.0.0.1 / [::1].');
    }
  }
}
