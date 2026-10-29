import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { Spotify } from '../src/spotify.js';
import { config } from '../src/config.js';
const key = '22'.repeat(32);
function store() {
  const s = new Store(':memory:', key);
  s.connect('u', { access_token: 'access', refresh_token: 'refresh', expiresAt: Date.now() + 3600000, scope: 'read' }, { id: 'spotify-u', name: 'U', product: 'premium', checkedAt: Date.now() }); return s;
}
function transport(fn: (url: string, init?: RequestInit) => Promise<Response>): typeof fetch { return fn as typeof fetch; }
test('Spotify playback: track parsing, cache, 204 and non-track items', async () => {
  const s = store(); let calls = 0;
  const spotify = new Spotify(s, transport(async () => { calls++; return Response.json({ is_playing: true, progress_ms: 4200,
    item: { type: 'track', id: 'a', name: 'Title', duration_ms: 10000, artists: [{ name: 'Artist' }], album: { images: [{ url: 'https://image' }] } } }); }));
  const [a, b] = await Promise.all([spotify.playback('u'), spotify.playback('u')]);
  assert.equal(calls, 1); assert.equal(a.track?.artist, 'Artist'); assert.deepEqual(a, b); assert.equal(a.progressMs, 4200);
  assert.equal((await new Spotify(s, transport(async () => new Response(null, { status: 204 }))).playback('u')).track, null);
  assert.equal((await new Spotify(s, transport(async () => Response.json({ item: { type: 'episode' } }))).playback('u')).track, null); s.close();
});
test('Spotify honors 429 Retry-After without repeated requests', async () => {
  const s = store(); let calls = 0;
  const spotify = new Spotify(s, transport(async () => { calls++; return new Response('', { status: 429, headers: { 'Retry-After': '60' } }); }));
  await assert.rejects(spotify.api('u', '/me/player'), /Лимит/);
  await assert.rejects(spotify.api('u', '/me/player'), /ограничил/); assert.equal(calls, 1); s.close();
});
test('Spotify 401 refreshes once; concurrent refreshes share a single exchange', async () => {
  config.spotifyId = 'test'; config.spotifySecret = 'test';
  const s = store(); let refreshes = 0; let api = 0;
  const spotify = new Spotify(s, transport(async (url, init) => {
    if (url.includes('/api/token')) { refreshes++; await new Promise(r => setTimeout(r, 10)); return Response.json({ access_token: 'new', expires_in: 3600 }); }
    api++; const header = (init?.headers as Record<string, string>)?.Authorization;
    return header === 'Bearer access' ? new Response('', { status: 401 }) : Response.json({ ok: true });
  }));
  const result = await Promise.all([spotify.api('u', '/me/player'), spotify.api('u', '/me/player')]);
  assert.deepEqual(result, [{ ok: true }, { ok: true }]); assert.equal(refreshes, 1); assert.equal(api, 4);
  assert.equal(s.token('u')?.refresh_token, 'refresh'); s.close();
});
test('Logout prevents an in-flight refresh from restoring credentials', async () => {
  config.spotifyId = 'test'; config.spotifySecret = 'test'; const s = store();
  s.putToken('u', { ...s.token('u')!, expiresAt: 1 });
  let release!: () => void; const gate = new Promise<void>(r => { release = r; });
  const spotify = new Spotify(s, transport(async () => { await gate; return Response.json({ access_token: 'new', expires_in: 3600 }); }));
  const request = spotify.api('u', '/me/player'); spotify.logout('u'); release();
  await assert.rejects(request, /отключён/); assert.equal(s.token('u'), undefined); s.close();
});
test('403 is reported honestly and 401 retries are bounded', async () => {
  config.spotifyId = 'test'; config.spotifySecret = 'test'; const s = store();
  await assert.rejects(new Spotify(s, transport(async () => new Response('', { status: 403 }))).api('u', '/me/player'), /запретил/);
  let calls = 0;
  const spotify = new Spotify(s, transport(async url => {
    calls++; return url.includes('/api/token') ? Response.json({ access_token: 'new', expires_in: 3600 }) : new Response('', { status: 401 });
  }));
  await assert.rejects(spotify.api('u', '/me/player'), /401/); assert.equal(calls, 3); s.close();
});
test('403 preserves Spotify allowlist and scope reasons instead of guessing Premium', async () => {
  const s = store();
  try {
    const plain = new Spotify(s, transport(async () => new Response('User not registered in the Developer Dashboard', { status: 403 })));
    await assert.rejects(plain.api('u', '/me'), /Причина Spotify: User not registered.*User Management/);
    const json = new Spotify(s, transport(async () => Response.json({ error: { status: 403, message: 'Insufficient client scope' } }, { status: 403 })));
    await assert.rejects(json.api('u', '/me'), /Insufficient client scope.*права доступа/);
  } finally { s.close(); }
});
test('403 diagnostics redact credentials, email and callback query values', async () => {
  const s = store();
  try {
    const message = 'Blocked for test@example.org Bearer credential-value access_token=private-token https://example.org/callback?code=private-code&state=private-state';
    const spotify = new Spotify(s, transport(async () => Response.json({ error: { message } }, { status: 403 })));
    await assert.rejects(spotify.api('u', '/me'), (error: any) => {
      assert.match(error.message, /HTTP 403/);
      for (const secret of ['test@example.org', 'credential-value', 'private-token', 'private-code', 'private-state']) assert.ok(!error.message.includes(secret));
      return true;
    });
  } finally { s.close(); }
});
test('Spotify queue snapshots preserve repeats/order, share requests and refresh after polling interval', async () => {
  const s = store(); const now = Date.now; let calls = 0; let ids = ['a', 'b', 'a']; let offset = 0;
  const spotify = new Spotify(s, transport(async () => {
    calls++; const track = (id: string) => ({ type: 'track', id, name: id, duration_ms: 10000, artists: [{ name: 'Artist' }] });
    return Response.json({ currently_playing: track('now'), queue: ids.map(track) });
  }));
  try {
    Date.now = () => now() + offset;
    const [first, other] = await Promise.all([spotify.queueSnapshot('u'), spotify.queueSnapshot('u')]);
    assert.equal(calls, 1); assert.equal(first.current?.id, 'now'); assert.deepEqual(other, first);
    assert.deepEqual(first.upcoming.map(t => t.id), ['a', 'b', 'a']);
    const detached = await spotify.queue('u'); detached[0].title = 'changed';
    assert.equal(first.upcoming[0].title, 'a');
    ids = ['b', 'a', 'a']; offset += config.pollMs + 100;
    const next = await spotify.queueSnapshot('u'); assert.equal(calls, 2);
    assert.deepEqual(next.upcoming.map(t => t.id), ids);
    spotify.logout('u'); await assert.rejects(spotify.queue('u'), /подтвердите/);
  } finally { Date.now = now; s.close(); }
});
test('Unavailable queue is not reported as a successful empty snapshot', async () => {
  const s = store();
  try {
    const spotify = new Spotify(s, transport(async () => new Response(null, { status: 204 })));
    await assert.rejects(spotify.queueSnapshot('u'), /не вернул очередь/);
  } finally { s.close(); }
});
