import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Catalog } from '../src/catalog.js';
import { jamLink, spotifyTrackId, progress, exclusive } from '../src/types.js';
const key = '11'.repeat(32);
test('SQLite: encrypted tokens, authenticated encryption, persistence and logout', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lfg-store-')); const path = join(dir, 'db.sqlite');
  try {
    let s = new Store(path, key);
    const token = { access_token: 'never-store-plaintext-access', refresh_token: 'never-store-plaintext-refresh', expiresAt: Date.now() + 60000, scope: 'test' };
    s.putToken('u', token); s.close();
    assert.ok(!readFileSync(path).includes(Buffer.from(token.access_token)));
    s = new Store(path, key); assert.deepEqual(s.token('u'), token);
    const blob = Buffer.from(s.seal('secret'), 'base64'); blob[blob.length - 1] ^= 1;
    assert.throws(() => s.open(blob.toString('base64')));
    s.deleteToken('u'); assert.equal(s.token('u'), undefined); s.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('OAuth state: user binding, single-use, expiration and logout invalidation', () => {
  const s = new Store(':memory:', key);
  const state = s.oauth('u', 'verifier'); assert.equal(s.oauthUser(state), 'u');
  assert.deepEqual(s.consumeOAuth(state), { user: 'u', verifier: 'verifier' });
  assert.equal(s.consumeOAuth(state), undefined);
  const old = s.oauth('u', 'old'); s.oauth('u', 'new'); assert.equal(s.consumeOAuth(old), undefined);
  const now = Date.now; const expired = s.oauth('v', 'expired');
  try { Date.now = () => now() + 601000; assert.equal(s.consumeOAuth(expired), undefined); } finally { Date.now = now; }
  const logout = s.oauth('u', 'v'); s.deleteToken('u'); assert.equal(s.consumeOAuth(logout), undefined); s.close();
});
test('URL validation blocks lookalike hosts, arbitrary media, credentials and playlist links', () => {
  assert.equal(jamLink('https://spotify.link/abc123'), 'https://spotify.link/abc123');
  assert.equal(jamLink('https://open.spotify.com/jam/abc-def'), 'https://open.spotify.com/jam/abc-def');
  for (const u of ['https://spotify.link.evil/a', 'http://spotify.link/a', 'https://user@spotify.link/a', 'https://open.spotify.com/track/abc', 'file:///etc/passwd']) assert.throws(() => jamLink(u));
  const id = 'A'.repeat(22);
  assert.equal(spotifyTrackId(`https://open.spotify.com/track/${id}?si=123`), id);
  assert.equal(spotifyTrackId(`spotify:track:${id}`), id);
  assert.equal(spotifyTrackId(`https://evil/track/${id}`), undefined);
  assert.equal(spotifyTrackId(`https://open.spotify.com/playlist/${id}`), undefined);
  assert.ok(progress(-100, 0).includes('0:00')); assert.ok(progress(90000, 60000).includes('1:00'));
});
export function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'lfg-audio-'));
  writeFileSync(join(dir, 'a.wav'), 'placeholder'); writeFileSync(join(dir, 'b.wav'), 'placeholder');
  const entries = [
    { id: 'a', title: 'One', artist: 'Artist', file: 'a.wav', durationMs: 10000, rights: 'Own recording', spotifyTrackId: 'A'.repeat(22) },
    { id: 'b', title: 'Two', artist: 'Artist', file: 'b.wav', durationMs: 12000, rights: 'Own recording' }
  ];
  const file = join(dir, 'catalog.json'); writeFileSync(file, JSON.stringify(entries));
  return { dir, file, entries, catalog: new Catalog(dir, file) };
}
test('Catalog: exact Spotify mapping, ambiguity and rights checks', () => {
  const f = fixture();
  try {
    assert.equal(f.catalog.resolve('one').id, 'a');
    assert.equal(f.catalog.resolve(`spotify:track:${'A'.repeat(22)}`).id, 'a');
    assert.throws(() => f.catalog.resolve(`spotify:track:${'B'.repeat(22)}`), /нет явно/);
    assert.throws(() => f.catalog.resolve('https://example.com/a.wav'));
    const duplicate = [...f.entries, { ...f.entries[1], id: 'c', title: 'One' }];
    writeFileSync(f.file, JSON.stringify(duplicate));
    assert.throws(() => new Catalog(f.dir, f.file).resolve('One'), /однозначного/);
    writeFileSync(f.file, JSON.stringify([{ ...f.entries[0], rights: '' }]));
    assert.throws(() => new Catalog(f.dir, f.file), /rights/);
    writeFileSync(f.file, JSON.stringify([{ ...f.entries[0], file: '../outside.wav' }]));
    assert.throws(() => new Catalog(f.dir, f.file));
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
test('Catalog rechecks symlinks before playback', { skip: process.platform === 'win32' ? 'Requires symlink privilege; run on Linux or enable Windows Developer Mode for a manual symlink check' : false }, () => {
  const f = fixture(); const other = mkdtempSync(join(tmpdir(), 'lfg-other-'));
  try {
    const external = join(other, 'other.wav'); writeFileSync(external, 'audio');
    rmSync(join(f.dir, 'a.wav')); symlinkSync(external, join(f.dir, 'a.wav'));
    assert.throws(() => f.catalog.file('a'), /внутри AUDIO_ROOT/);
  } finally { rmSync(f.dir, { recursive: true, force: true }); rmSync(other, { recursive: true, force: true }); }
});
test('Per-server lock serializes failures without blocking the next action', async () => {
  const lock = exclusive<void>(); const order: number[] = [];
  const first = lock(async () => { order.push(1); throw new Error('expected'); });
  const second = lock(async () => { order.push(2); });
  await assert.rejects(first); await second; assert.deepEqual(order, [1, 2]);
});
