import { spawnSync } from 'node:child_process';
import { generateDependencyReport } from '@discordjs/voice';
import { config } from './config.js';
import { Catalog } from './catalog.js';
import { DatabaseSync } from 'node:sqlite';
console.log('Node:', process.version);
console.log(generateDependencyReport());
const r = spawnSync(config.ffmpeg, ['-version'], { encoding: 'utf8', windowsHide: true });
console.log('FFmpeg:', r.status === 0 ? r.stdout.split('\n')[0] : 'НЕ НАЙДЕН');
const db = new DatabaseSync(':memory:'); console.log('SQLite:', db.prepare('SELECT sqlite_version() AS version').get()?.version); db.close();
console.log('Каталог:', new Catalog(config.audioRoot, config.catalog).all().length, 'композиций');
for (const key of ['DISCORD_TOKEN','DISCORD_CLIENT_ID','SPOTIFY_CLIENT_ID','SPOTIFY_CLIENT_SECRET','TOKEN_ENCRYPTION_KEY']) {
  console.log(`${key}: ${process.env[key] ? 'задан' : 'не задан'}`);
}
if (r.status !== 0) process.exitCode = 1;
