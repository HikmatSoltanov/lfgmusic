import { Client, Events, GatewayIntentBits, MessageFlags, PermissionFlagsBits,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, escapeMarkdown, type ChatInputCommandInteraction, type ButtonInteraction } from 'discord.js';
import { config, validateStartup } from './config.js';
import { Store } from './store.js';
import { Spotify } from './spotify.js';
import { Catalog } from './catalog.js';
import { oauthServer } from './oauth.js';
import { Session } from './session.js';
import { UserError, exclusive, jamLink, spotifyTrackId, type Mode, type SessionData } from './types.js';
validateStartup();
const store = new Store(config.db, config.key);
const spotify = new Spotify(store);
const catalog = new Catalog(config.audioRoot, config.catalog);
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates], allowedMentions: { parse: [] } });
const sessions = new Map<string, Session>();
const locks = new Map<string, ReturnType<typeof exclusive<void>>>();
const pendingTicks = new Set<string>();
let shuttingDown = false;
function run(guild: string, work: () => Promise<void>) {
  if (!locks.has(guild)) locks.set(guild, exclusive<void>());
  return locks.get(guild)!(work);
}
function make(data: SessionData) {
  return new Session(data, client, store, spotify, catalog, work => {
    void run(data.guildId, work).catch(() => console.error(`Ошибка плеера сервера ${data.guildId}.`));
  });
}
function session(guild: string): Session {
  const s = sessions.get(guild); if (!s) throw new UserError('Сначала выполните /listen start для Spotify или /jam start для локального плеера.'); return s;
}
async function memberVoice(i: ChatInputCommandInteraction | ButtonInteraction) {
  const guild = await client.guilds.fetch(i.guildId!); const member = await guild.members.fetch(i.user.id);
  if (!member.voice.channel) throw new UserError('Сначала войдите в голосовой канал Discord.');
  return member;
}
async function authorize(i: ChatInputCommandInteraction | ButtonInteraction, s: Session) {
  const m = await memberVoice(i);
  if (m.voice.channelId !== s.data.voiceChannelId) throw new UserError('Для управления войдите в голосовой канал сессии.');
  if (m.id !== s.data.ownerId && !m.permissions.has(PermissionFlagsBits.ManageGuild)) throw new UserError('Управление доступно ведущему и участникам с Manage Server.');
}
async function stop(i: ChatInputCommandInteraction | ButtonInteraction, s: Session) {
  // Administrators may stop orphaned sessions without joining a deleted/full channel.
  const m = await i.guild!.members.fetch(i.user.id);
  if (!m.permissions.has(PermissionFlagsBits.ManageGuild)) await authorize(i, s);
  await s.stop(); sessions.delete(i.guildId!);
}
async function sourcePrompt(i: ChatInputCommandInteraction | ButtonInteraction, s: Session) {
  if (i.user.id !== s.data.ownerId) throw new UserError('Источник выбирает только владелец этой Spotify-сессии.');
  await authorize(i, s);
  const request = await s.sourceOptions();
  const heading = `Spotify: **${escapeMarkdown(request.track.artist.slice(0, 100))} — ${escapeMarkdown(request.track.title.slice(0, 120))}**\n`;
  const footer = '\n\nОткройте ссылки и проверьте версию записи. Выбирая источник, вы подтверждаете соответствие и право трансляции аудио. Поиск не доказывает наличие прав. Выбор сохранится для вашего аккаунта.';
  const lines: string[] = []; const visible: number[] = [];
  for (let n = 0; n < request.candidates.length; n++) {
    const c = request.candidates[n];
    const line = `${n + 1}. [${escapeMarkdown(c.title.slice(0, 90))}](${c.url}) — ${escapeMarkdown(c.artist.slice(0, 60))} (${Math.round(c.durationMs / 1000)} с)`;
    if ((heading + [...lines, line].join('\n') + footer).length > 1900) break;
    lines.push(line); visible.push(n);
  }
  if (!visible.length) throw new UserError('Источник вернул слишком длинную ссылку. Попробуйте другой аудиоисточник.');
  return { content: heading + lines.join('\n') + footer,
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(...visible.map(n => new ButtonBuilder().setCustomId(`listen:pick:${request.nonce}:${n}`).setLabel(`Источник ${n + 1}`).setStyle(ButtonStyle.Primary)))] };

}
async function handle(i: ChatInputCommandInteraction | ButtonInteraction): Promise<string | { content: string; components: ActionRowBuilder<ButtonBuilder>[] }> {
  if (i.isButton()) {
    if (i.customId.startsWith('listen:source:')) {
      const s = session(i.guildId!);
      if (i.message.id !== s.data.messageId) throw new UserError('Панель устарела.');
      return sourcePrompt(i, s);
    }
    if (i.customId.startsWith('listen:pick:')) {
      const s = session(i.guildId!);
      if (i.user.id !== s.data.ownerId) throw new UserError('Подтверждение доступно только владельцу Spotify-сессии.');
      await authorize(i, s); const [, , nonce, index] = i.customId.split(':');
      await s.approveSource(nonce, Number(index)); return 'Источник сохранён. Состояние воспроизведения показано на панели.';
    }
    if (i.customId.startsWith('spotify:confirm:')) {
      const identity = await spotify.confirm(i.user.id, i.customId.slice('spotify:confirm:'.length));
      return `Подключён ваш Spotify Premium: **${escapeMarkdown(identity.name)}**. Другие пользователи не получают доступ к вашей привязке.`;
    }
    const s = session(i.guildId!); const [, action, messageId] = i.customId.split(':');
    if (messageId !== s.data.messageId || i.message.id !== messageId) throw new UserError('Эта панель устарела. Используйте актуальное сообщение сессии.');
    if (action === 'stop') await stop(i, s);
    else { await authorize(i, s); await s.control(action); }
    return 'Готово.';
  }
  if (i.commandName === 'spotify') {
    if (i.options.getSubcommand() === 'login') return `Ваша личная ссылка действует 10 минут. Не пересылайте её другим.\n[Подключить Spotify](${spotify.login(i.user.id)})`;
    if (i.options.getSubcommand() === 'confirm') {
      const pending = store.pending(i.user.id);
      if (!pending) throw new UserError('Нет ожидающей привязки. Выполните /spotify login.');
      return { content: `Подключить **${escapeMarkdown(pending.identity.name)}** (Spotify ID: ${escapeMarkdown(pending.identity.id)}) к вашему Discord? Подтверждайте только свой аккаунт.`,
        components: [new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(`spotify:confirm:${pending.nonce}`).setLabel('Это мой Spotify').setStyle(ButtonStyle.Success))] };
    }
    spotify.logout(i.user.id);
    return 'Токены и незавершённые авторизации удалены. Для отзыва доступа приложения также откройте страницу Apps в аккаунте Spotify.';
  }
  if (['jam', 'listen'].includes(i.commandName) && i.options.getSubcommand() === 'start') {
    if (sessions.has(i.guildId!)) throw new UserError('На сервере уже есть сессия. Завершите её через /listen stop или /jam stop.');
    const ordinary = i.commandName === 'listen';
    const m = await memberVoice(i); const mode = ordinary ? 'mirror' : (i.options.getString('mode') || 'real') as Mode;
    const url = ordinary ? null : i.options.getString('link');
    if (url && mode === 'voice') throw new UserError('Приглашение Spotify Jam используется в режимах real и mirror.');
    if (mode !== 'voice' && !store.hasConnection(i.user.id)) throw new UserError('Сначала выполните /spotify login, затем /spotify confirm и подтвердите свой Spotify Premium.');
    const bot = await i.guild!.members.fetchMe(); const permissions = m.voice.channel!.permissionsFor(bot);
    if (!permissions?.has([PermissionFlagsBits.Connect, PermissionFlagsBits.Speak])) throw new UserError('Боту нужны разрешения Connect и Speak в голосовом канале.');
    const data: SessionData = { guildId: i.guildId!, ownerId: i.user.id, mode, voiceChannelId: m.voice.channelId!,
      textChannelId: i.channelId, source: ordinary ? 'spotify' : undefined, jamUrl: url ? jamLink(url) : undefined, queue: [], positionMs: 0, paused: false };
    const s = make(data); sessions.set(i.guildId!, s);
    try { await s.init(); } catch (e) { await s.stop(); sessions.delete(i.guildId!); throw e; }
    if (ordinary) return config.engineEnabled ? 'Следование Spotify включено. Для новой песни нажмите «Выбрать источник», проверьте запись и право трансляции. Подтверждённые источники используются автоматически при следующих включениях.' : 'Следование вашему Spotify включено. Управляйте песнями и очередью в Spotify. Звук доступен для точных соответствий в разрешённом аудиокаталоге; без подходящего источника бот молчит и показывает причину.';
    return mode === 'mirror' ? 'Jam → Voice: управление в Spotify, звук только для точных соответствий в разрешённом каталоге. Нет файла — тишина. Добавьте приглашение через /jam link.' : mode === 'real' ? 'Мониторинг вашего Spotify запущен. Текущий трек и состояние голосового соединения показаны на панели. В этом режиме звук остаётся в Spotify.' : 'Discord Voice Jam запущен. Добавляйте разрешённые композиции через /play.';
  }
  const s = session(i.guildId!);
  if (['jam', 'listen'].includes(i.commandName)) {
    switch (i.options.getSubcommand()) {
      case 'source': return sourcePrompt(i, s);
      case 'status': await s.tick(); return s.statusText();
      case 'queue': return s.queueText();
      case 'stop': await stop(i, s); return 'Сессия завершена.';
      case 'link': {
        if (s.data.mode === 'voice') throw new UserError('В режиме voice нет Spotify Jam и его приглашения.');
        const value = i.options.getString('url');
        if (value) { await authorize(i, s); s.data.jamUrl = jamLink(value); s.save(); await s.render(true); }
        return s.data.jamUrl || 'Скопируйте приглашение в Spotify и укажите /jam link url:… .';
      }
    }
  }
  await authorize(i, s);
  if (i.commandName === 'play') {
    if (s.data.mode !== 'voice') throw new UserError('/play доступна в локальном режиме voice; при следовании Spotify добавляйте треки в самом Spotify.');
    const query = i.options.getString('query', true).trim(); const t = catalog.resolve(query);
    let description = `${t.artist} — ${t.title}`;
    const id = spotifyTrackId(query);
    // Metadata lookup is optional; audio still uses the administrator's exact catalog mapping.
    if (id && store.hasConnection(i.user.id)) {
      const metadata = await spotify.track(i.user.id, id); description = `${metadata.artist} — ${metadata.title}`;
    }
    await s.add(t.id); return `Добавлено: ${description}. Источник звука: разрешённый локальный каталог.`;
  }
  if (['pause', 'resume', 'skip'].includes(i.commandName)) { await s.control(i.commandName); return 'Готово.'; }
  throw new UserError('Неизвестная команда. Обновите регистрацию команд.');
}
client.on(Events.InteractionCreate, i => {
  if ((!i.isChatInputCommand() && !i.isButton()) || (i.isButton() && !i.customId.startsWith('jam:') && !i.customId.startsWith('spotify:confirm:') && !i.customId.startsWith('listen:'))) return;
  void (async () => {
    if (!i.inGuild()) { await i.reply({ content: 'Команды работают только на сервере Discord.', flags: MessageFlags.Ephemeral }); return; }
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    await run(i.guildId, async () => {
      try { if (shuttingDown) throw new UserError('Бот завершает работу.'); const result = await handle(i); const payload = typeof result === 'string' ? { content: result.slice(0, 1950), components: [] } : result; await i.editReply({ ...payload, allowedMentions: { parse: [] } }); }
      catch (e) {
        if (!(e instanceof UserError)) console.error(`Команда не выполнена: ${i.isButton() ? 'button' : i.commandName}, сервер ${i.guildId}.`);
        await i.editReply({ content: e instanceof UserError ? e.message : 'Операция не выполнена. Проверьте разрешения Discord, соединение и журнал бота.', allowedMentions: { parse: [] } });
      }
    });
  })().catch(() => console.error('Discord не принял ответ на взаимодействие.'));
});
client.once(Events.ClientReady, async ready => {
  console.log(`Discord подключён: ${ready.user.tag}. Каталог: ${catalog.all().length} композиций.`);
  for (const data of store.sessions()) {
    await run(data.guildId, async () => {
      const s = make(data); sessions.set(data.guildId, s);
      try { await s.init(); console.log(`Сессия ${data.guildId} восстановлена.`); }
      catch (error) { await s.stop(false); sessions.delete(data.guildId); console.error(`Сессию ${data.guildId} восстановить не удалось. ${error instanceof UserError ? error.message : 'Проверьте каналы и права.'} Состояние сохранено.`); }
    });
  }
});
client.on(Events.Error, () => console.error('Ошибка Discord Gateway; клиент выполняет переподключение.'));
const timer = setInterval(() => {
  if (shuttingDown) return;
  for (const [id, s] of sessions) {
    if (pendingTicks.has(id)) continue;
    pendingTicks.add(id);
    void run(id, () => s.tick()).catch(() => console.error(`Не удалось обновить панель сервера ${id}; повторная попытка на следующем цикле.`))
      .finally(() => pendingTicks.delete(id));
  }
}, 1000);
const server = oauthServer(spotify);
server.on('error', () => { console.error('Не удалось запустить OAuth HTTP-сервер. Проверьте HTTP_HOST/HTTP_PORT.'); void shutdown(1); });
server.listen(config.port, config.host, () => console.log(`OAuth HTTP-сервер запущен на порту ${config.port}.`));
async function shutdown(code = 0) {
  if (shuttingDown) return; shuttingDown = true; clearInterval(timer);
  const deadline = setTimeout(() => process.exit(1), 15000); deadline.unref();
  await Promise.allSettled([...sessions].map(([id, s]) => run(id, () => s.stop(false))));
  await client.destroy(); server.close(); server.closeAllConnections(); store.close(); process.exitCode = code;
}
process.once('SIGINT', () => { void shutdown(); });
process.once('SIGTERM', () => { void shutdown(); });
try { await client.login(config.discordToken); }
catch { console.error('Вход в Discord не удался. Проверьте DISCORD_TOKEN и доступ к Discord.'); await shutdown(1); }
