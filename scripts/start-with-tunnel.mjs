import { spawn } from 'node:child_process';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import dotenv from 'dotenv';
import { prepareEngine, waitForEngine } from './audio-runtime.mjs';
import { installCloudflared } from './install-cloudflared.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
process.chdir(root); dotenv.config({ path: join(root, '.env'), quiet: true });
const children = []; let tokenFile; let stopping = false; let shutdownTimer;
async function shutdown(code) {
  if (stopping) return; stopping = true; process.exitCode = code;
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  // The bot needs a short interval to persist queue and playback positions.
  shutdownTimer = setTimeout(() => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }, 10000); shutdownTimer.unref();
  if (tokenFile) await rm(tokenFile, { force: true });
}
function start(command, args, label, childEnvironment) {
  const env = childEnvironment || { ...process.env }; delete env.CLOUDFLARE_TUNNEL_TOKEN;
  if (label === 'Cloudflare connector') for (const name of Object.keys(env)) {
    if (/^(DISCORD_|SPOTIFY_|MUSIC_ENGINE_)/.test(name) || name === 'TOKEN_ENCRYPTION_KEY') delete env[name];
  }
  const child = spawn(command, args, { cwd: root, env, stdio: 'inherit' }); children.push(child);
  child.on('error', () => { console.error(`${label} could not start.`); void shutdown(1); });
  child.on('exit', (code, signal) => {
    if (!stopping) { console.error(`${label} stopped (code ${code ?? 'none'}, signal ${signal ?? 'none'}). Stopping the other process.`); void shutdown(1); }
    if (stopping && children.every(c => c.exitCode !== null || c.signalCode !== null)) clearTimeout(shutdownTimer);
  });
}
process.once('SIGTERM', () => { void shutdown(0); });
process.once('SIGINT', () => { void shutdown(0); });
try {
  const token = process.env.CLOUDFLARE_TUNNEL_TOKEN?.trim();
  if (!token) throw new Error('Add CLOUDFLARE_TUNNEL_TOKEN to your private .env file. Never paste it into the startup command or chat.');
  const command = await installCloudflared();
  if (!stopping) {
    await mkdir(join(root, 'data'), { recursive: true, mode: 0o700 });
    tokenFile = join(root, 'data', `.cloudflared-token-${process.pid}-${randomBytes(6).toString('hex')}`);
    await writeFile(tokenFile, token, { mode: 0o600, flag: 'wx' });
    if (!stopping && process.env.MUSIC_ENGINE_ENABLED === '1') {
      const engine = await prepareEngine();
      const key = process.env.MUSIC_ENGINE_KEY || randomBytes(32).toString('hex');
      process.env.MUSIC_ENGINE_KEY = key;
      const port = process.env.MUSIC_ENGINE_PORT || '2334';
      const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
        MUSIC_ENGINE_KEY: key, MUSIC_ENGINE_PORT: port, MUSIC_ENGINE_MAX_STREAMS: process.env.MUSIC_ENGINE_MAX_STREAMS || '1' };
      start(engine.java, engine.args, 'MusicBot audio engine', env);
      await waitForEngine(key, port, () => stopping);
    }
    if (!stopping) {
      start(command, ['tunnel', '--no-autoupdate', '--protocol', 'http2', '--metrics', '127.0.0.1:0', 'run', '--token-file', tokenFile], 'Cloudflare connector');
      start(process.execPath, ['dist/src/index.js'], 'Discord bot');
    } else await rm(tokenFile, { force: true });
  }
} catch (error) { console.error(error.message); await shutdown(1); }
