import { Readable } from 'node:stream';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { AudioPlayerStatus, VoiceConnectionStatus, NoSubscriberBehavior, StreamType, createAudioPlayer,
  createAudioResource, entersState, joinVoiceChannel, type VoiceConnection } from '@discordjs/voice';
import { ChannelType, type VoiceBasedChannel } from 'discord.js';
import { config } from './config.js';
import { VoiceDiagnostics } from './voice-diagnostics.js';
import { UserError } from './types.js';
export class Voice {
  readonly player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
  connection?: VoiceConnection;
  private diagnostics?: VoiceDiagnostics;
  private sourceStream?: Readable;
  private process?: ChildProcessWithoutNullStreams;
  private base = 0;
  private reconnecting = false;
  private closed = false;
  private active = false;
  private desiredPaused = false;
  private failures = 0;
  private connectionGeneration = 0;
  onEnd: () => void = () => {};
  onError: (message: string) => void = () => {};
  onConnection: () => void = () => {};
  constructor() {
    this.player.on(AudioPlayerStatus.Playing, () => { if (this.desiredPaused) this.player.pause(true); });
    this.player.on(AudioPlayerStatus.Idle, () => {
      this.kill();
      if (this.active) { this.active = false; this.onEnd(); }
    });
    this.player.on('error', () => {
      this.onError('Не удалось декодировать аудиофайл. Проверьте FFmpeg и файл каталога.');
      const wasActive = this.active;
      this.active = false; this.player.stop(true); this.kill(); if (wasActive) this.onEnd();
    });
  }
  async connect(channel: VoiceBasedChannel): Promise<void> {
    if (channel.type === ChannelType.GuildStageVoice) throw new UserError('Используйте обычный голосовой канал, не Stage.');
    this.closed = false;
    this.connection = joinVoiceChannel({ channelId: channel.id, guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator, selfDeaf: true });
    this.diagnostics = new VoiceDiagnostics(this.connection, channel.guild.id);
    this.connection.subscribe(this.player);
    const generation = ++this.connectionGeneration;
    this.connection.on('error', () => this.onError('Ошибка голосового соединения Discord.'));
    this.connection.on(VoiceConnectionStatus.Ready, () => { this.failures = 0; this.onConnection(); });
    this.connection.on(VoiceConnectionStatus.Disconnected, () => {
      if (generation === this.connectionGeneration) void this.reconnect().catch(() => this.onError('Голосовое соединение закрыто. Проверьте права и перезапустите сессию.'));
    });
    try { await entersState(this.connection, VoiceConnectionStatus.Ready, 20000); }
    catch {
      const detail = `${this.diagnostics.summary()}. ${this.diagnostics.hint()}`;
      console.warn(`[voice ${channel.guild.id}] startup failed: ${detail}`);
      this.close(); throw new UserError(`Discord Voice не подключился: ${detail}`);
    }
  }
  private async reconnect() {
    if (this.closed || this.reconnecting || !this.connection) return;
    this.reconnecting = true;
    try {
      try {
        await Promise.race([
          entersState(this.connection, VoiceConnectionStatus.Signalling, 5000),
          entersState(this.connection, VoiceConnectionStatus.Connecting, 5000)
        ]);
        await entersState(this.connection, VoiceConnectionStatus.Ready, 20000); return;
      } catch { /* Explicit rejoin after the transport failed to recover. */ }
      for (this.failures = 0; this.failures < 5 && !this.closed; this.failures++) {
        this.connection.rejoin();
        try { await entersState(this.connection, VoiceConnectionStatus.Ready, 15000); return; } catch { /* bounded retry */ }
      }
      if (!this.closed) {
        this.onError('Переподключение исчерпано. Очередь сохранена; выполните /jam stop и /jam start либо перезапустите бота.');
        this.connection.destroy(); this.onConnection();
      }
    } finally { this.reconnecting = false; }
  }
  play(file: string, positionMs = 0, paused = false) {
    this.active = false; this.player.stop(true); this.kill(); this.base = positionMs; this.desiredPaused = paused;
    // No shell, remote URLs, playlists or network protocols are accepted.
    const child = spawn(config.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin',
      '-protocol_whitelist', 'file,pipe', '-ss', String(positionMs / 1000), '-i', file,
      '-vn', '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1'], { windowsHide: true });
    this.process = child; child.stdin.end();
    child.stderr.resume();
    child.on('error', () => { if (this.process === child) {
      this.onError('FFmpeg не запустился. Установите его и проверьте FFMPEG_PATH.');
      const wasActive = this.active;
      this.active = false; this.kill(); this.player.stop(true); if (wasActive) this.onEnd();
    } });
    child.on('close', code => { if (code && this.process === child) this.onError('FFmpeg завершился с ошибкой; аудиофайл недоступен или повреждён.'); });
    this.active = true;
    try { this.player.play(createAudioResource(child.stdout, { inputType: StreamType.Raw })); }
    catch (e) { this.active = false; this.kill(); throw e; }
    if (paused) this.player.pause(true);
  }
  playPcm(stream: Readable, positionMs = 0, paused = false) {
    this.active = false; this.player.stop(true); this.kill();
    this.base = positionMs; this.desiredPaused = paused; this.sourceStream = stream; this.active = true;
    try { this.player.play(createAudioResource(stream, { inputType: StreamType.Raw })); }
    catch (error) { this.active = false; this.kill(); throw error; }
    if (paused) this.player.pause(true);
  }
  position() { return this.base + (this.player.state.status === AudioPlayerStatus.Idle ? 0 : this.player.state.resource.playbackDuration); }
  pause() { this.desiredPaused = true; return this.player.pause(true); }
  resume() { this.desiredPaused = false; return this.player.unpause(); }
  stop() { this.desiredPaused = false; this.active = false; this.player.stop(true); this.kill(); this.base = 0; }
  ready() { return this.connection?.state.status === VoiceConnectionStatus.Ready; }
  private kill() { const source = this.sourceStream; this.sourceStream = undefined; source?.destroy(); const child = this.process; this.process = undefined; child?.kill(); }
  close() { this.diagnostics?.dispose(); this.diagnostics = undefined; this.closed = true; this.connectionGeneration++; this.stop(); if (this.connection && this.connection.state.status !== VoiceConnectionStatus.Destroyed) this.connection.destroy(); this.connection = undefined; }
}
