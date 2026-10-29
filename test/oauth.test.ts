import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Store } from '../src/store.js';
import { Spotify } from '../src/spotify.js';
import { oauthServer } from '../src/oauth.js';
import { config } from '../src/config.js';
test('HTTP OAuth flow: confirmation, PKCE, one-use callback and health', async () => {
  config.spotifyId = 'test'; config.spotifySecret = 'test';
  const store = new Store(':memory:', '33'.repeat(32)); let exchanges = 0;
  const spotify = new Spotify(store, (async (_url: any, init: RequestInit) => {
    if (String(_url).endsWith('/v1/me')) return Response.json({ id: 'spotify-person', display_name: 'Person', product: 'premium' });
    const body = init.body as URLSearchParams;
    assert.equal(body.get('grant_type'), 'authorization_code'); assert.ok(body.get('code_verifier'));
    exchanges++; return Response.json({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600 });
  }) as typeof fetch);
  const server = oauthServer(spotify); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string'); const base = `http://127.0.0.1:${address.port}`;
  try {
    assert.deepEqual(await (await fetch(`${base}/health`)).json(), { ok: true });
    const link = new URL(spotify.login('123456789')); const dest = new URL(link.searchParams.get('url')!);
    assert.equal(dest.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(dest.searchParams.get('scope')?.includes('user-read-private'));
    const confirmation = await fetch(base + link.pathname + link.search);
    assert.equal(confirmation.headers.get('referrer-policy'), 'no-referrer'); assert.ok((await confirmation.text()).includes('123456789'));
    const callback = `${base}/callback?state=${dest.searchParams.get('state')}&code=test`;
    const result = await fetch(callback); assert.equal(result.status, 200); assert.ok((await result.text()).includes('Spotify Premium проверен'));
    assert.equal(store.hasConnection('123456789'), false);
    const pending = store.pending('123456789'); assert.ok(pending);
    await assert.rejects(spotify.confirm('other-user', pending.nonce));
    await spotify.confirm('123456789', pending.nonce);
    assert.equal(store.hasConnection('123456789'), true); assert.equal((await fetch(callback)).status, 400); assert.equal(exchanges, 1);
    assert.equal((await fetch(`${base}/authorize?url=${encodeURIComponent('https://evil.example')} `)).status, 400);
    assert.equal((await fetch(`${base}/health`, { method: 'POST' })).status, 405);
  } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); store.close(); }
});
