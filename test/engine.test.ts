import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { EngineClient, EngineFollower, sourceUrl } from '../src/engine.js';
import { config } from '../src/config.js';
import { Store } from '../src/store.js';
import type { Voice } from '../src/voice.js';
import type { Playback } from '../src/types.js';
const candidate = { id: '11111111-1111-4111-8111-111111111111', title: 'Song', artist: 'Artist', durationMs: 100000, url: 'https://www.youtube.com/watch?v=abcdefghijk' };
test('Engine search only returns supported URLs and similar durations; it never chooses a result', async () => {
  config.engineKey = 'test-key';
  const client = new EngineClient((async (_url: any, init: RequestInit) => {
    assert.equal((init.headers as any)['X-Engine-Key'], 'test-key');
    return Response.json({ candidates: [candidate, { ...candidate, durationMs: 150000 }] });
  }) as typeof fetch);
  const results = await client.search({ id: 'spotify', title: 'Song', artist: 'Artist', durationMs: 100000 });
  assert.equal(results.length, 1); assert.deepEqual(results[0], candidate);
  for (const url of ['http://youtube.com/watch?v=x','https://youtube.com.evil/watch?v=x','https://user@youtube.com/watch?v=x','file:///etc/passwd','https://127.0.0.1/']) assert.throws(() => sourceUrl(url));
});
test('Engine stream is PCM and is not truncated by a request timeout after headers', async t => {
  config.engineKey = 'test-key'; t.mock.timers.enable({ apis: ['setTimeout'] });
  let controller!: ReadableStreamDefaultController<Uint8Array>; let signal!: AbortSignal;
  const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
  const client = new EngineClient((async (_url: any, init: RequestInit) => {
    signal = init.signal as AbortSignal;
    return new Response(body, { headers: { 'Content-Type': 'application/octet-stream' } });
  }) as typeof fetch);
  const stream = await client.stream(candidate.id, 0);
  t.mock.timers.tick(16000); assert.equal(signal.aborted, false, 'only opening the stream has a deadline; a long song remains open');
  controller.enqueue(new Uint8Array([0,0,1,0])); controller.close(); const chunks = [];
  for await (const data of stream) chunks.push(data);
  assert.equal(Buffer.concat(chunks).length, 4); t.mock.timers.reset();
  const bad = new EngineClient((async () => new Response('html', { headers: { 'Content-Type': 'text/html' } })) as typeof fetch);
  await assert.rejects(bad.stream(candidate.id, 0), /аудиопоток/);
});
test('Source approvals are private to Discord user and are removed on logout', () => {
  const store = new Store(':memory:', 'cc'.repeat(32));
  try {
    store.setAudioSource('a', 'spotify-track', candidate);
    assert.equal(store.audioSource('a','spotify-track')?.url, candidate.url);
    assert.equal(store.audioSource('b','spotify-track'), undefined);
    store.deleteToken('a'); assert.equal(store.audioSource('a','spotify-track'), undefined);
  } finally { store.close(); }
});
test('Engine follower requires an approved recording, follows pause and seek, and stops on API failure', async () => {
  const store = new Store(':memory:', 'dd'.repeat(32)); const calls: string[] = []; let position = 1000;
  const voice = { ready: () => true, position: () => position, stop: () => calls.push('stop'), playPcm: () => calls.push('play'), pause: () => calls.push('pause'), resume: () => calls.push('resume') } as unknown as Voice;
  const engine = { load: async () => candidate, stream: async () => Readable.from([Buffer.alloc(3840)]) } as unknown as EngineClient;
  const follower = new EngineFollower(voice, engine, store, 'a');
  const playback: Playback = { track: { id: 'spotify', title: 'Song', artist: 'Artist', durationMs: 100000 }, fetchedAt: Date.now(), progressMs: 1000, playing: true };
  try {
    assert.match(await follower.sync(playback), /не подтверждён/); assert.ok(!calls.includes('play'));
    store.setAudioSource('b','spotify',candidate); assert.match(await follower.sync(playback), /не подтверждён/);
    store.setAudioSource('a','spotify',candidate); assert.equal(await follower.sync(playback), ''); assert.equal(calls.at(-1), 'play');
    assert.equal(follower.audioStatus(), 'playing');
    await follower.sync({ ...playback, playing: false }); assert.equal(calls.at(-1), 'pause');
    await follower.sync(playback); assert.equal(calls.at(-1), 'resume');
    position = 1000; await follower.sync({ ...playback, progressMs: 30000 }); assert.equal(calls.at(-1), 'play');
    await follower.sync(undefined); assert.equal(calls.at(-1), 'stop'); assert.equal(follower.audioStatus(), 'unavailable');
  } finally { store.close(); }
});
test('Changed or unavailable audio never silently substitutes a new recording', async () => {
  const store = new Store(':memory:', 'ee'.repeat(32)); let plays = 0;
  const voice = { ready: () => true, stop: () => {}, playPcm: () => plays++, position: () => 0 } as unknown as Voice;
  const client = { load: async () => ({ ...candidate, title: 'Different recording' }) } as unknown as EngineClient;
  const playback: Playback = { track: { id: 'spotify', title: 'Song', artist: 'Artist', durationMs: 100000 }, fetchedAt: Date.now(), progressMs: 0, playing: true };
  try {
    store.setAudioSource('a','spotify',candidate);
    assert.match(await new EngineFollower(voice, client, store, 'a').sync(playback), /изменилась/); assert.equal(plays, 0);
  } finally { store.close(); }
});

test('Provider authentication failures remain explicit and do not leak response secrets', async () => {
  config.engineKey = 'test-key';
  const client = new EngineClient((async () => Response.json({ error: 'source_auth_required', token: 'never-show-this' }, { status: 502 })) as typeof fetch);
  await assert.rejects(client.search({ id: 's', title: 'Song', artist: 'Artist', durationMs: 10000 }), (error: any) => {
    assert.match(error.message, /требует входа/); assert.ok(!error.message.includes('never-show-this')); return true;
  });
});

test('Failed provider loads use backoff instead of querying the source every tick', async () => {
  const store = new Store(':memory:', 'af'.repeat(32)); let calls = 0;
  const voice = { ready: () => true, stop: () => {} } as unknown as Voice;
  const client = { load: async () => { calls++; throw new Error('offline'); } } as unknown as EngineClient;
  const playback: Playback = { track: { id: 'spotify', title: 'Song', artist: 'Artist', durationMs: 100000 }, fetchedAt: Date.now(), progressMs: 0, playing: true };
  try {
    store.setAudioSource('a','spotify',candidate); const follower = new EngineFollower(voice,client,store,'a');
    assert.match(await follower.sync(playback), /30 секунд/);
    await follower.sync(playback); await follower.sync(playback); assert.equal(calls,1);
    follower.reset(); await follower.sync(playback); assert.equal(calls,2);
  } finally { store.close(); }
});
