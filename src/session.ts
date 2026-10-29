import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, type Client, type Message, type VoiceBasedChannel } from 'discord.js';
import { Store } from './store.js';
import { Spotify } from './spotify.js';
import { Catalog } from './catalog.js';
import { randomBytes } from 'node:crypto';
import { EngineClient, EngineFollower, type EngineCandidate } from './engine.js';
import { Mirror } from './mirror.js';
import { Voice } from './voice.js';
import { config } from './config.js';
import { UserError, progress, type SessionData, type Playback, type Track, type QueueSnapshot } from './types.js';
export class Session {
  readonly voice = new Voice();
  private playback?: Playback;
  private mirror: Mirror | EngineFollower;
  private engine?: EngineClient;
  private sourceRequest?: { nonce: string; trackId: string; at: number; candidates: EngineCandidate[] };
  private message?: Message;
  private lastRender = 0;
  private lastSave = 0;
  private lastPoll = 0;
  private signature = '';
  private error = '';
  private voiceError = '';
  private mirrorError = '';
  private queueError = '';
  private remoteQueue?: QueueSnapshot;
  private stopped = false;
  private initialized = false;
  constructor(readonly data: SessionData, private client: Client, private store: Store,
    private spotify: Spotify, private catalog: Catalog, enqueue: (fn: () => Promise<void>) => void) {
    this.engine = data.source === 'spotify' && config.engineEnabled ? new EngineClient() : undefined;
    this.mirror = this.engine ? new EngineFollower(this.voice, this.engine, store, data.ownerId) : new Mirror(catalog, this.voice);
    this.voice.onEnd = () => enqueue(async () => {
      if (this.stopped) return;
      if (this.data.mode === 'mirror') this.mirror.ended();
      else if (this.data.mode === 'voice') await this.next();
      await this.render(true);
    });
    this.voice.onError = text => { this.voiceError = text; };
    this.voice.onConnection = () => { if (this.voice.ready()) this.voiceError = ''; this.lastRender = 0; };
  }
  async init() {
    const guild = await this.client.guilds.fetch(this.data.guildId);
    const channel = await guild.channels.fetch(this.data.voiceChannelId);
    if (!channel?.isVoiceBased()) throw new UserError('Сохранённый голосовой канал удалён или недоступен.');
    try { await this.voice.connect(channel as VoiceBasedChannel); }
    catch (error) {
      if (this.data.mode !== 'real') throw error;
      this.voiceError = error instanceof UserError ? error.message : 'Голосовое соединение недоступно; мониторинг Spotify продолжается.';
    }
    this.initialized = true;
    if (this.data.mode === 'voice' && this.data.currentId) {
      try {
        const t = this.catalog.get(this.data.currentId);
        if (this.data.positionMs >= t.durationMs) await this.next();
        else this.voice.play(this.catalog.file(t.id), this.data.positionMs, this.data.paused);
      } catch { this.error = 'Сохранённый трек недоступен; перехожу к очереди.'; await this.next(); }
    } else if (this.data.mode === 'voice' && this.data.queue.length) await this.next();
    await this.tick(); await this.render(true); this.save();
  }
  track(): Track | undefined {
    if (this.data.mode !== 'voice') return this.playback?.track || undefined;
    if (!this.data.currentId) return;
    try { return this.catalog.get(this.data.currentId); } catch { return; }
  }
  private position() {
    if (this.data.mode === 'voice') return this.data.currentId ? this.voice.position() : 0;
    const p = this.playback;
    return p ? Math.min(p.track?.durationMs || 0, p.progressMs + (p.playing ? Date.now() - p.fetchedAt : 0)) : 0;
  }
  save() {
    if (this.stopped) return;
    if (this.data.mode === 'voice' && this.initialized) this.data.positionMs = Math.floor(this.position());
    this.store.save(this.data); this.lastSave = Date.now();
  }
  async tick() {
    if (this.stopped) return;
    if (this.data.mode !== 'voice' && Date.now() - this.lastPoll >= config.pollMs) {
      this.lastPoll = Date.now();
      const [playback, queue] = await Promise.allSettled([
        this.spotify.playback(this.data.ownerId),
        this.data.source === 'spotify' ? this.spotify.queueSnapshot(this.data.ownerId) : Promise.resolve(undefined)
      ]);
      if (playback.status === 'fulfilled') { this.playback = playback.value; this.error = ''; }
      else { this.playback = undefined; this.error = playback.reason instanceof UserError ? playback.reason.message : 'Spotify временно недоступен.'; }
      if (this.data.source === 'spotify') {
        if (queue.status === 'fulfilled') { this.remoteQueue = queue.value; this.queueError = ''; }
        else { this.remoteQueue = undefined; this.queueError = queue.reason instanceof UserError ? queue.reason.message : 'Очередь Spotify временно недоступна.'; }
        if (this.playback?.track && this.remoteQueue?.current && this.playback.track.id !== this.remoteQueue.current.id) {
          this.remoteQueue = undefined; this.queueError = 'Spotify переключает композицию; согласованный снимок очереди появится после следующего опроса.';
        }
      }
    }
    if (this.data.mode === 'mirror') {
      this.mirrorError = await this.mirror.sync(this.playback);
    }
    if (Date.now() - this.lastSave >= 10000) this.save();
    const signature = JSON.stringify([this.track()?.id, this.data.paused, this.playback?.playing, this.error, this.voiceError, this.voice.ready(), this.data.jamUrl, this.data.queue, this.mirrorError, this.queueError, this.remoteQueue?.upcoming.map(t => [t.id, t.title]), this.mirror.audioStatus()]);
    if ((signature !== this.signature && Date.now() - this.lastRender >= 4000) || Date.now() - this.lastRender >= config.embedMs) {
      this.signature = signature; await this.render();
    }
  }
  async sourceOptions() {
    if (!this.store.hasConnection(this.data.ownerId)) throw new UserError('Spotify отключён. Выполните /spotify login и подтвердите аккаунт.');
    if (!this.engine) throw new UserError('Внешний аудиодвижок не включён. Нужен MUSIC_ENGINE_ENABLED=1 и запуск через общий launcher.');
    const track = this.track();
    if (!track) throw new UserError('Сначала включите композицию в Spotify и дождитесь обновления панели.');
    const candidates = await this.engine.search(track);
    if (!candidates.length) throw new UserError('Источник не нашёл доступной записи с близкой длительностью. Другой трек не подставляется.');
    if (!this.store.hasConnection(this.data.ownerId) || this.track()?.id !== track.id) throw new UserError('Spotify-привязка или текущий трек изменились. Повторите выбор источника.');
    const nonce = randomBytes(16).toString('hex');
    this.sourceRequest = { nonce, trackId: track.id, at: Date.now(), candidates };
    return { nonce, track, candidates };
  }
  async approveSource(nonce: string, index: number) {
    if (!this.store.hasConnection(this.data.ownerId)) { this.sourceRequest = undefined; throw new UserError('Spotify отключён; подтверждение источника отменено.'); }
    const request = this.sourceRequest;
    if (!request || request.nonce !== nonce || Date.now() - request.at > 600000 || request.trackId !== this.track()?.id || !Number.isInteger(index) || !request.candidates[index]) throw new UserError('Выбор устарел или Spotify уже переключил трек. Нажмите «Выбрать источник» снова.');
    this.store.setAudioSource(this.data.ownerId, request.trackId, request.candidates[index]); this.sourceRequest = undefined;
    if (this.mirror instanceof EngineFollower) this.mirror.reset();
    await this.tick(); await this.render(true);
  }
  async add(id: string) {
    this.requireVoice(); this.catalog.get(id);
    if (this.data.currentId === id || this.data.queue.includes(id)) throw new UserError('Этот трек уже воспроизводится или находится в очереди.');
    if (this.data.queue.length >= 100) throw new UserError('Очередь ограничена 100 композициями.');
    this.data.queue.push(id); this.save();
    if (!this.data.currentId) await this.next();
    await this.render(true);
  }
  private requireVoice() { if (this.data.mode !== 'voice') throw new UserError('Управляйте Spotify-плеером в Spotify. Команда доступна только в локальном режиме voice.'); }
  async next() {
    this.requireVoice(); this.voice.stop(); this.data.currentId = undefined;
    this.data.positionMs = 0; this.data.paused = false;
    while (this.data.queue.length) {
      const id = this.data.queue.shift()!;
      try {
        const file = this.catalog.file(id);
        this.data.currentId = id; this.voice.play(file); break;
      } catch { this.data.currentId = undefined; this.error = 'Недоступный файл каталога пропущен.'; }
    }
    this.save();
  }
  async control(action: string) {
    this.requireVoice();
    if (!this.data.currentId) throw new UserError('Сейчас ничего не воспроизводится. Используйте /play.');
    if (action === 'skip') await this.next();
    else if (action === 'pause') { this.voice.pause(); this.data.paused = true; }
    else if (action === 'resume') { this.voice.resume(); this.data.paused = false; }
    this.save(); await this.render(true);
  }
  async queueText(): Promise<string> {
    if (this.data.mode !== 'voice') {
      const tracks = await this.spotify.queue(this.data.ownerId);
      return tracks.length ? `Далее в Spotify (доступная часть очереди):\n${tracks.slice(0, 15).map((t, i) => `${i + 1}. ${t.artist} — ${t.title}`).join('\n')}` : 'Spotify не вернул очередь. Откройте плеер на активном устройстве.';
    }
    return this.data.queue.length ? this.data.queue.slice(0, 20).map((id, i) => {
      try { const t = this.catalog.get(id); return `${i + 1}. ${t.artist} — ${t.title}`; } catch { return `${i + 1}. Недоступный файл`; }
    }).join('\n') : 'Очередь Discord пуста.';
  }
  statusText(): string {
    const p = this.track();
    return [`Режим: ${this.data.mode}`, `Spotify: ${this.store.hasConnection(this.data.ownerId) ? 'аккаунт подключён' : 'не подключён'}`,
      `Discord Voice: ${this.voice.ready() ? 'подключён' : 'отключён / переподключение'}`,
      p ? `${p.artist} — ${p.title}` : 'Нет доступного текущего трека.',
      this.data.source === 'spotify' && this.engine ? 'Spotify управляет воспроизведением; звук из подтверждённого внешнего источника.' : this.data.mode !== 'voice' ? this.data.mode === 'mirror' ? 'Spotify управляет точным локальным соответствием; без файла в Discord тишина.' : 'Звук слушают в Spotify; голосовой канал бота без трансляции.' : 'Звук из разрешённого локального каталога.', this.error, this.mirrorError, this.queueError, this.voiceError].filter(Boolean).join('\n');
  }
  async render(force = false) {
    if (this.stopped || (!force && Date.now() - this.lastRender < 4000)) return;
    this.lastRender = Date.now();
    const t = this.track(); const real = this.data.mode !== 'voice'; const ordinary = this.data.source === 'spotify';
    const playing = real ? this.playback?.playing : this.data.currentId && !this.data.paused;
    const embed = new EmbedBuilder().setColor(real ? 0x1db954 : 0x5865f2)
      .setTitle(ordinary ? 'Spotify → Discord' : real ? this.data.mode === 'mirror' ? 'Spotify → Discord · Разрешённый каталог' : 'Spotify Jam · Real' : 'Discord Voice Jam')
      .setDescription(t ? `**${t.title.slice(0, 200)}**\n${t.artist.slice(0, 250)}\n\n${progress(this.position(), t.durationMs)}` : 'Ожидание композиции')
      .addFields(
        { name: 'Spotify', value: this.store.hasConnection(this.data.ownerId) ? '🟢 Авторизован' : '⚪ Не подключён', inline: true },
        { name: 'Discord Voice', value: this.voice.ready() ? '🟢 Подключён' : '🟠 Переподключение / отключён', inline: true },
        { name: real ? 'Spotify-плеер' : 'Плеер Discord', value: playing ? '▶ Воспроизведение' : '⏸ Пауза / нет трека', inline: true },
        ...(ordinary ? [] : [{ name: real ? 'Приглашение Spotify Jam' : 'Очередь Discord', value: real ? this.data.jamUrl ? `[Открыть приглашение](${this.data.jamUrl})\nСсылку предоставил ведущий; бот не проверяет её срок действия.` : 'Необязательно: добавьте приглашение через /jam link.' : `${this.data.queue.length} композиций` }])
      ).setFooter({ text: ordinary ? 'Управление песнями и очередью — в Spotify • звук — из подтверждённого источника' : real ? this.data.mode === 'mirror' ? 'Spotify: метаданные • звук: ваш разрешённый каталог • синхронизация с задержкой опроса' : 'Метаданные Spotify • слушайте в Spotify • аудио в Discord не передаётся' : 'Независимая очередь Discord • только разрешённое аудио' });
    if (ordinary) {
      const audio = this.mirror.audioStatus();
      embed.addFields({ name: 'Аудио в Discord', value: audio === 'playing' ? '▶ Подтверждённый источник воспроизводится' : audio === 'paused' ? '⏸ Пауза по состоянию Spotify' : t ? 'Ожидание подтверждённого или доступного источника' : 'Ожидание песни' });
      const upcoming = this.remoteQueue?.upcoming;
      embed.addFields({ name: 'Далее в Spotify', value: this.queueError ? `Недоступно: ${this.queueError}`.slice(0, 900) : upcoming ? upcoming.length ? upcoming.slice(0, 5).map((t, i) => `${i + 1}. ${t.artist.slice(0, 70)} — ${t.title.slice(0, 90)}`).join('\n').slice(0, 1000) : 'Spotify вернул пустую очередь.' : 'Обновление…' });
    }
    if (real && t?.image?.startsWith('https://')) embed.setThumbnail(t.image);
    if (real && t?.url?.startsWith('https://open.spotify.com/')) embed.setURL(t.url);
    if (this.error) embed.addFields({ name: 'Spotify / плеер', value: this.error.slice(0, 900) });
    if (this.mirrorError) embed.addFields({ name: 'Источник аудио', value: this.mirrorError.slice(0, 900) });
    if (this.voiceError) embed.addFields({ name: 'Голосовое соединение', value: this.voiceError.slice(0, 900) });
    const row = new ActionRowBuilder<ButtonBuilder>();
    for (const [id, label] of (ordinary ? [] : [['pause', 'Пауза'], ['resume', 'Продолжить'], ['skip', 'Пропустить']]) as [string, string][]) {
      row.addComponents(new ButtonBuilder().setCustomId(`jam:${id}:${this.data.messageId || 'initial'}`).setLabel(label).setStyle(ButtonStyle.Secondary).setDisabled(real || !t));
    }
    row.addComponents(new ButtonBuilder().setCustomId(`jam:stop:${this.data.messageId || 'initial'}`).setLabel('Завершить').setStyle(ButtonStyle.Danger));
    if (ordinary && this.engine && t) row.addComponents(new ButtonBuilder().setCustomId(`listen:source:${this.data.messageId || 'initial'}`).setLabel('Выбрать источник').setStyle(ButtonStyle.Primary));
    if (!ordinary && real && this.data.jamUrl) row.addComponents(new ButtonBuilder().setLabel('Войти в Jam').setStyle(ButtonStyle.Link).setURL(this.data.jamUrl));
    const channel = await this.client.channels.fetch(this.data.textChannelId);
    if (!channel?.isTextBased() || !('send' in channel)) throw new UserError('Текстовый канал недоступен.');
    if (!this.message && this.data.messageId) {
      try { this.message = await channel.messages.fetch(this.data.messageId); }
      catch (e: any) { if (e?.code !== 10008) throw e; this.data.messageId = undefined; }
    }
    const payload = { embeds: [embed], components: [row], allowedMentions: { parse: [] as never[] } };
    if (this.message) {
      try { await this.message.edit(payload); }
      catch (e: any) {
        if (e?.code !== 10008) throw e;
        this.message = undefined; this.data.messageId = undefined;
        await this.render(true);
      }
    } else {
      this.message = await channel.send(payload); this.data.messageId = this.message.id; this.save();
      // Bind controls to this exact message; old panels cannot control a replacement session.
      await this.render(true);
    }
  }
  async stop(remove = true) {
    this.save(); this.stopped = true; this.voice.close();
    if (remove) {
      this.store.remove(this.data.guildId);
      try { await this.message?.edit({ embeds: [new EmbedBuilder().setColor(0x666666).setTitle('Сессия завершена')], components: [] }); } catch { /* already deleted or permission revoked */ }
    }
  }
}
