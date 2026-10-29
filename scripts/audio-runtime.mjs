import { access, readFile, chmod } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
export async function memoryLimit() {
  for (const path of ['/sys/fs/cgroup/memory.max','/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
    try { const n = Number((await readFile(path, 'utf8')).trim()); if (Number.isFinite(n) && n > 0 && n < 2 ** 60) return n; } catch {}
  }
  return undefined;
}
export async function prepareEngine() {
  const port = Number(process.env.MUSIC_ENGINE_PORT || 2334);
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === Number(process.env.HTTP_PORT || 8888)) throw new Error('MUSIC_ENGINE_PORT must be a separate internal port, e.g. 2334.');
  const streams = Number(process.env.MUSIC_ENGINE_MAX_STREAMS || 1);
  if (!Number.isInteger(streams) || streams < 1 || streams > 8) throw new Error('MUSIC_ENGINE_MAX_STREAMS must be an integer from 1 to 8.');
  const limit = await memoryLimit();
  console.log(`[audio-runtime] containerMemoryMiB=${limit ? Math.round(limit / 1048576) : 'unknown'}, architecture=${process.platform}/${process.arch}`);
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('The packaged Java audio runtime requires Linux x64.');
  if (limit && limit < 384 * 1048576) throw new Error('Audio engine requires at least 384 MiB container memory; 512 MiB or more is recommended. Set MUSIC_ENGINE_ENABLED=0 to keep the existing local player running.');
  let java = process.env.MUSIC_ENGINE_JAVA;
  if (!java) {
    const bundled = join(root, 'bin/jre/bin/java');
    try { await access(bundled); await chmod(bundled, 0o700); java = bundled; } catch { java = 'java'; }
  }
  const version = spawnSync(java, ['-version'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
  if (version.error || version.status !== 0) throw new Error('Java runtime is missing. Extract the audio-engine package with bin/jre or configure MUSIC_ENGINE_JAVA.');
  const versionLine = (version.stderr || version.stdout).split('\n').find(line => /^(openjdk|java) version/.test(line)) || 'Java runtime detected';
  console.log(`[audio-runtime] ${versionLine}`);
  const jar = join(root, 'audio-engine/target/music-engine.jar');
  const metadata = JSON.parse(await readFile(join(root, 'audio-engine/runtime.json'), 'utf8'));
  const hash = createHash('sha256'); for await (const part of createReadStream(jar)) hash.update(part);
  if (hash.digest('hex') !== metadata.sha256) throw new Error('Audio engine JAR checksum mismatch. Re-upload the complete verified audio package.');
  return { java, args: ['-Xms16m', '-Xmx96m', '-XX:MaxMetaspaceSize=96m', '-XX:MaxDirectMemorySize=32m', '-XX:ReservedCodeCacheSize=32m', '-XX:+UseSerialGC', '-Dorg.slf4j.simpleLogger.defaultLogLevel=warn', '-jar', jar] };
}
export async function waitForEngine(key, port, stopped) {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline && !stopped()) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`, { headers: { 'X-Engine-Key': key }, signal: AbortSignal.timeout(1000) });
      if (r.ok && (await r.json()).ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('Audio engine did not become ready; inspect [audio-engine] logs.');
}
