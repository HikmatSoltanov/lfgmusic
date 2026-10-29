import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { Spotify } from '../src/spotify.js';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../src/config.js';
const token = (access = 'access') => ({ access_token: access, refresh_token: `refresh-${access}`, scope: 'user-read-private', expiresAt: Date.now() + 3600000 });
const identity = (id = 'spotify-a') => ({ id, name: id, product: 'premium' as const, checkedAt: Date.now() });
function prepare(product = 'premium') {
  config.spotifyId = 'test'; config.spotifySecret = 'test';
  const store = new Store(':memory:', '55'.repeat(32));
  const spotify = new Spotify(store, (async (url: any) => String(url).includes('/api/token')
    ? Response.json({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600 })
    : Response.json({ id: 'spotify-a', display_name: 'Alice', product })) as typeof fetch);
  const state = () => {
    const link = new URL(spotify.login('discord-a'));
    return new URL(link.searchParams.get('url')!).searchParams.get('state')!;
  };
  return { store, spotify, state };
}
test('Premium-only connection stays pending until its Discord owner explicitly confirms', async () => {
  const { store, spotify, state } = prepare();
  try {
    await spotify.callback(state(), 'code');
    assert.equal(store.hasToken('discord-a'), false);
    assert.equal(store.hasConnection('discord-a'), false);
    await assert.rejects(spotify.playback('discord-a'), /подтвердите/);
    const pending = store.pending('discord-a')!;
    await assert.rejects(spotify.confirm('discord-b', pending.nonce), /Нет действующего/);
    await spotify.confirm('discord-a', pending.nonce);
    assert.equal(store.identity('discord-a')?.id, 'spotify-a');
    assert.equal(store.hasConnection('discord-a'), true);
    await assert.rejects(spotify.confirm('discord-a', pending.nonce), /Нет действующего/);
  } finally { store.close(); }
});
test('Free, open and missing product cannot connect; an existing connection is preserved', async () => {
  for (const product of ['free', 'open', '']) {
    const { store, spotify, state } = prepare(product);
    try {
      store.connect('discord-a', token('old'), identity('old'));
      await assert.rejects(spotify.callback(state(), 'code'), /Premium/);
      assert.equal(store.token('discord-a')?.access_token, 'old');
      assert.equal(store.identity('discord-a')?.id, 'old');
      assert.equal(store.pending('discord-a'), undefined);
    } finally { store.close(); }
  }
});
test('One Spotify account cannot be claimed by two Discord users, including a confirmation race', () => {
  const store = new Store(':memory:', '66'.repeat(32));
  try {
    store.stageConnection('a', token('a'), identity());
    store.stageConnection('b', token('b'), identity());
    store.confirmConnection('a', store.pending('a')!.nonce, identity());
    assert.throws(() => store.confirmConnection('b', store.pending('b')!.nonce, identity()), /другому Discord/);
    assert.equal(store.hasConnection('b'), false); assert.equal(store.token('a')?.access_token, 'a');
    store.deleteToken('a');
    store.confirmConnection('b', store.pending('b')!.nonce, identity());
    assert.equal(store.hasConnection('b'), true);
  } finally { store.close(); }
});
test('Each Discord user receives only their own Spotify playback and cached response', async () => {
  const store = new Store(':memory:', '77'.repeat(32));
  try {
    store.connect('a', token('a'), identity('spotify-a'));
    store.connect('b', token('b'), identity('spotify-b'));
    const spotify = new Spotify(store, (async (_url: any, init: RequestInit) => {
      const access = (init.headers as Record<string, string>).Authorization;
      const id = access === 'Bearer a' ? 'song-a' : 'song-b';
      return Response.json({ item: { type: 'track', id, name: id, artists: [], duration_ms: 10000 }, is_playing: true, queue: [{ type: 'track', id, name: id, artists: [], duration_ms: 10000 }] });
    }) as typeof fetch);
    const [a, b] = await Promise.all([spotify.playback('a'), spotify.playback('b')]);
    assert.equal(a.track?.id, 'song-a'); assert.equal(b.track?.id, 'song-b');
    const [qa, qb] = await Promise.all([spotify.queue('a'), spotify.queue('b')]);
    assert.equal(qa[0].id, 'song-a'); assert.equal(qb[0].id, 'song-b');
    assert.equal((await spotify.playback('a')).track?.id, 'song-a');
    spotify.logout('a'); assert.equal(store.identity('a'), undefined);
    await assert.rejects(spotify.playback('a'), /подтвердите/);
    assert.equal((await spotify.playback('b')).track?.id, 'song-b');
  } finally { store.close(); }
});
test('Expired confirmation and old unverified tokens cannot bypass the new binding', async () => {
  const store = new Store(':memory:', '88'.repeat(32)); const now = Date.now;
  try {
    store.putToken('legacy', token());
    await assert.rejects(new Spotify(store).playback('legacy'), /подтвердите/);
    store.stageConnection('a', token(), identity()); const nonce = store.pending('a')!.nonce;
    Date.now = () => now() + 601000;
    assert.throws(() => store.confirmConnection('a', nonce, identity()), /устарело/);
    assert.equal(store.hasConnection('a'), false);
  } finally { Date.now = now; store.close(); }
});
test('Premium is rechecked before player access and a downgrade blocks playback', async () => {
  const store = new Store(':memory:', '99'.repeat(32)); let calls = 0;
  try {
    store.connect('a', token(), { ...identity(), checkedAt: 1 });
    const spotify = new Spotify(store, (async (url: any) => {
      calls++; assert.ok(String(url).endsWith('/v1/me')); return Response.json({ id: 'spotify-a', product: 'free' });
    }) as typeof fetch);
    await assert.rejects(spotify.playback('a'), /Premium/); assert.equal(calls, 1);
  } finally { store.close(); }
});
test('Confirming a new account prevents an old in-flight refresh overwriting its tokens', async () => {
  config.spotifyId = 'test'; config.spotifySecret = 'test';
  const store = new Store(':memory:', 'aa'.repeat(32));
  let release!: () => void; const gate = new Promise<void>(r => { release = r; });
  try {
    store.connect('a', { ...token('old'), expiresAt: 1 }, identity('old'));
    store.stageConnection('a', token('new'), identity('new'));
    const spotify = new Spotify(store, (async (url: any) => {
      if (String(url).includes('/api/token')) { await gate; return Response.json({ access_token: 'old-refreshed', expires_in: 3600 }); }
      return Response.json({ id: 'new', display_name: 'New', product: 'premium' });
    }) as typeof fetch);
    const old = spotify.api('a', '/me/player');
    await spotify.confirm('a', store.pending('a')!.nonce); release();
    await assert.rejects(old, /отключён/);
    assert.equal(store.token('a')?.access_token, 'new'); assert.equal(store.identity('a')?.id, 'new');
  } finally { release(); store.close(); }
});

test('Existing SQLite migrates additively while preserving encrypted tokens and session settings', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lfg-migrate-')); const key = 'bb'.repeat(32);
  try {
    const cipher = new Store(':memory:', key); const payload = cipher.seal(JSON.stringify(token('legacy'))); cipher.close();
    const path = join(dir, 'db.sqlite'); const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE tokens (user_id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE sessions (guild_id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE oauth (state_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, verifier TEXT NOT NULL, expires INTEGER NOT NULL);`);
    old.prepare('INSERT INTO tokens VALUES (?,?)').run('u', payload);
    const session = { guildId: 'guild', ownerId: 'u', mode: 'mirror', voiceChannelId: 'voice', textChannelId: 'text', queue: [], positionMs: 0, paused: false };
    old.prepare('INSERT INTO sessions VALUES (?,?)').run('guild', JSON.stringify(session)); old.close();
    const migrated = new Store(path, key);
    assert.equal(migrated.token('u')?.access_token, 'legacy'); assert.deepEqual(migrated.sessions(), [session]);
    assert.equal(migrated.hasConnection('u'), false);
    migrated.connect('u', token('new'), identity()); assert.equal(migrated.hasConnection('u'), true);
    assert.deepEqual(migrated.sessions(), [session]); migrated.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
