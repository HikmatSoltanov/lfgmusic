import type { Catalog } from './catalog.js';
import type { Voice } from './voice.js';
import type { Playback } from './types.js';
/** Metadata-led transport for an administrator's exact, authorized local recording. */
export class Mirror {
  private active?: string;
  private paused = false;
  private target = 0;
  private exhausted?: { id: string; position: number };
  constructor(private catalog: Catalog, private voice: Voice) {}
  audioStatus(): 'playing' | 'paused' | 'unavailable' {
    return this.active && this.voice.ready() ? this.paused ? 'paused' : 'playing' : 'unavailable';
  }
  ended() {
    if (this.active) this.exhausted = { id: this.active, position: this.target };
    this.active = undefined;
  }
  private stop() { this.voice.stop(); this.active = undefined; }
  sync(p?: Playback): string {
    if (!p?.track) { this.stop(); return ''; }
    const t = p.track;
    if (this.exhausted && this.exhausted.id !== t.id) this.exhausted = undefined;
    const target = Math.max(0, Math.min(t.durationMs, p.progressMs + (p.playing ? Date.now() - p.fetchedAt : 0)));
    const recording = this.catalog.all().find(r => r.spotifyTrackId === t.id);
    if (!recording) { this.stop(); return 'Для текущего Spotify-трека нет разрешённого аудио с точным spotifyTrackId. В Discord — тишина.'; }
    if (!this.voice.ready()) { this.stop(); return 'Ожидание восстановления голосового соединения.'; }
    if (this.exhausted?.id === t.id && target >= this.exhausted.position - 2000) {
      this.stop(); return 'Аудиофайл закончился или не декодируется. Проверьте точность соответствия и длительность записи.';
    }
    this.exhausted = undefined;
    if (target >= recording.durationMs || target >= t.durationMs - 100) { this.stop(); return 'Конец доступной записи; ожидание следующего трека.'; }
    try {
      const changed = this.active !== t.id;
      if (changed || Math.abs(this.voice.position() - target) > 2500) {
        this.voice.play(this.catalog.file(recording.id), target, !p.playing);
        this.active = t.id; this.paused = !p.playing;
      } else if (this.paused !== !p.playing) {
        if (p.playing) this.voice.resume(); else this.voice.pause();
        this.paused = !p.playing;
      }
      this.target = target; return '';
    } catch { this.stop(); return 'Разрешённый аудиофайл отсутствует или выходит за AUDIO_ROOT. В Discord — тишина.'; }
  }
}
