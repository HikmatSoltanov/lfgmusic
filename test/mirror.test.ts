import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Voice } from '../src/voice.js';
import type { Catalog } from '../src/catalog.js';
import { Mirror } from '../src/mirror.js';
import type { Playback } from '../src/types.js';
test('Spotify-to-catalog sync: exact ID, seeks, pause/resume, track change, no match and stale playback', () => {
  const calls: unknown[][] = []; let position = 1000;
  const voice = { ready: () => true, play: (...args: unknown[]) => calls.push(['play', ...args]),
    pause: () => calls.push(['pause']), resume: () => calls.push(['resume']), stop: () => calls.push(['stop']), position: () => position } as unknown as Voice;
  const catalog = { all: () => [{ id: 'local', spotifyTrackId: 'spotify', durationMs: 100000 }, { id: 'local2', spotifyTrackId: 'spotify2', durationMs: 100000 }], file: (id: string) => `/audio/${id}.wav` } as unknown as Catalog;
  const mirror = new Mirror(catalog, voice);
  const p: Playback = { track: { id: 'spotify', title: 'Song', artist: 'Artist', durationMs: 100000 }, playing: true, progressMs: 1000, fetchedAt: Date.now() };
  assert.equal(mirror.sync(p), ''); assert.equal(calls[0][0], 'play'); assert.equal(calls[0][1], '/audio/local.wav');
  assert.ok(Math.abs(Number(calls[0][2]) - 1000) < 100);
  mirror.sync({ ...p, playing: false }); assert.equal(calls.at(-1)?.[0], 'pause');
  mirror.sync(p); assert.equal(calls.at(-1)?.[0], 'resume');
  mirror.sync({ ...p, progressMs: 30000 }); assert.equal(calls.at(-1)?.[0], 'play');
  position = 30000; mirror.sync({ ...p, track: { ...p.track!, id: 'spotify2' }, progressMs: 30000 });
  assert.equal(calls.at(-1)?.[1], '/audio/local2.wav');
  assert.match(mirror.sync({ ...p, track: { ...p.track!, id: 'missing' } }), /нет разрешённого/); assert.equal(calls.at(-1)?.[0], 'stop');
  mirror.sync(p); mirror.ended(); assert.match(mirror.sync(p), /закончился/);
  mirror.sync(undefined); assert.equal(calls.at(-1)?.[0], 'stop');
});
