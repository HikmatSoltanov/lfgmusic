import { createServer } from 'node:http';
import { config } from './config.js';
import { Spotify } from './spotify.js';
import { UserError } from './types.js';
const escape = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
export function oauthServer(spotify: Spotify) {
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'");
    if (!req.url || req.url.length > 10000) { res.writeHead(414).end(); return; }
    if (req.method !== 'GET') { res.writeHead(405).end(); return; }
    const u = new URL(req.url, 'http://127.0.0.1');
    if (u.pathname === '/health') { res.setHeader('Content-Type', 'application/json'); res.end('{"ok":true}'); return; }
    let status = 200; let content = '';
    try {
      if (u.pathname === '/authorize') {
        const destination = new URL(u.searchParams.get('url') || '');
        if (destination.origin !== 'https://accounts.spotify.com' || destination.pathname !== '/authorize' ||
          destination.searchParams.get('client_id') !== config.spotifyId || destination.searchParams.get('redirect_uri') !== config.redirect) {
          throw new UserError('Некорректная ссылка авторизации.');
        }
        const user = spotify.store.oauthUser(destination.searchParams.get('state') || '');
        if (!user) throw new UserError('Ссылка устарела. Выполните /spotify login.');
        content = `<h1>Подключение Spotify</h1><p>Вы привязываете Spotify к Discord ID <strong>${escape(user)}</strong>.</p><p>Продолжайте, только если это ваш Discord ID и вы сами вызвали /spotify login. Не передавайте эту ссылку другим.</p><p>Бот получит доступ к метаданным вашего воспроизведения. Аудиопоток не передаётся.</p><a href="${escape(destination.href)}">Авторизоваться в Spotify</a>`;
      } else if (u.pathname === new URL(config.redirect).pathname) {
        if (u.searchParams.has('error')) {
          spotify.store.consumeOAuth(u.searchParams.get('state') || '');
          throw new UserError('Доступ в Spotify отменён. Выполните /spotify login для новой попытки.');
        }
        const code = u.searchParams.get('code'); const state = u.searchParams.get('state');
        if (!code || !state) throw new UserError('Нет code/state. Начните с /spotify login.');
        const identity = await spotify.callback(state, code);
        content = `<h1>Spotify Premium проверен</h1><p>Аккаунт: <strong>${escape(identity.name)}</strong> (ID: ${escape(identity.id)}).</p><p>Привязка ещё не активна. Вернитесь в Discord, выполните <strong>/spotify confirm</strong>, проверьте аккаунт и нажмите «Это мой Spotify».</p><p>Если это чужой аккаунт, ничего не подтверждайте; выполните /spotify login заново, войдя в свой Spotify.</p>`;
      } else { status = 404; content = '<h1>Страница не найдена</h1>'; }
    } catch (error) { status = 400; content = `<h1>Авторизация не завершена</h1><p>${escape(error instanceof UserError ? error.message : 'Проверьте доступ к Spotify и настройки OAuth. Повторите /spotify login.')}</p>`; }
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>LFG Music</title><style>body{background:#121212;color:#eee;font:18px system-ui;max-width:680px;margin:10vh auto;padding:24px}a{color:#1ed760}p{line-height:1.6}</style>${content}</html>`);
  });
  return server;
}
