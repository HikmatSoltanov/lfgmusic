import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { AudioPlayerStatus } from '@discordjs/voice';
import { EngineClient } from '../src/engine.js';
import { Voice } from '../src/voice.js';
import { config } from '../src/config.js';
const available = process.platform === 'linux' && process.arch === 'x64' && existsSync('bin/jre/bin/java') && existsSync('audio-engine/target/music-engine.jar');
test('Real packaged Java decoder -> HTTP PCM -> Node voice Opus, with authenticated loopback', { skip: available ? false : 'Optional Linux x64 Java audio package is not installed', timeout: 30000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lfg-java-test-')); const file = join(dir, 'tone.wav');
  const generated = spawnSync(config.ffmpeg, ['-hide_banner','-loglevel','error','-f','lavfi','-i','sine=frequency=440:duration=1.2',file]); assert.equal(generated.status, 0);
  const probe = createServer(); probe.listen(0,'127.0.0.1'); await once(probe,'listening');
  const addr = probe.address(); assert.ok(addr && typeof addr !== 'string'); const port = addr.port;
  await new Promise<void>(r => probe.close(() => r()));
  const key = randomBytes(32).toString('hex'); const previous = { key: config.engineKey, port: config.enginePort }; config.engineKey = key; config.enginePort = port;
  const child = spawn(resolve('bin/jre/bin/java'), ['-Xms16m','-Xmx96m','-XX:+UseSerialGC','-jar',resolve('audio-engine/target/music-engine.jar')], { env: { ...process.env, MUSIC_ENGINE_KEY: key, MUSIC_ENGINE_PORT: String(port), MUSIC_ENGINE_TEST_FILE: file }, stdio: ['ignore','ignore','pipe'] });
  let logs = ''; child.stderr?.on('data', b => { logs = (logs + b.toString()).slice(-3000); });
  const voice = new Voice();
  const get = (path: string) => fetch(`http://127.0.0.1:${port}${path}`, { headers: { 'X-Engine-Key': key }, signal: AbortSignal.timeout(1500) });
  try {
    let ready = false;
    for (let i=0;i<120;i++) {
      if (child.exitCode !== null) throw new Error(`Java engine exited: ${logs}`);
      try { if ((await get('/health')).ok) { ready = true; break; } } catch {}
      await new Promise(r => setTimeout(r,100));
    }
    assert.equal(ready,true,logs);
    assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status,401);
    const test: any = await (await get('/test')).json(); assert.equal(test.candidates.length,1);
    const id = test.candidates[0].id;
    const response = await get(`/stream?id=${id}&position=0`); const pcm = Buffer.from(await response.arrayBuffer());
    const duration = pcm.length / 192000; assert.ok(duration > 1.1 && duration < 1.3, `PCM duration ${duration}`);
    let crossings = 0; let previousSample = 0;
    for (let i=0;i+3<pcm.length;i+=4) { const n=pcm.readInt16LE(i); if (previousSample < 0 && n>=0) crossings++; previousSample=n; }
    assert.ok(Math.abs(crossings / duration - 440) < 10, '48 kHz PCM retains the generated 440 Hz frequency');
    const source = await new EngineClient().stream(id,0); voice.playPcm(source);
    const state = voice.player.state; assert.notEqual(state.status,AudioPlayerStatus.Idle);
    if (state.status===AudioPlayerStatus.Idle) throw new Error('Missing audio resource');
    let frames=0;for await(const packet of state.resource.playStream) { assert.ok(packet.length>0);frames++; }
    assert.ok(frames>=50,`Opus frames: ${frames}`);
  } finally {
    voice.close(); config.engineKey=previous.key; config.enginePort=previous.port;
    if (child.exitCode===null) { child.kill('SIGTERM'); await once(child,'exit'); }
    rmSync(dir,{recursive:true,force:true});
  }
});
