import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AudioPlayerStatus } from '@discordjs/voice';
import { Voice } from '../src/voice.js';
import { config } from '../src/config.js';
test('Actual FFmpeg local WAV -> PCM -> Opus frames through the voice player', { timeout: 15000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lfg-codec-')); const file = join(dir, 'generated.wav'); const voice = new Voice();
  try {
    const result = spawnSync(config.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.5', file], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, 'FFmpeg is required for audio integration validation');
    voice.play(file);
    const state = voice.player.state; assert.notEqual(state.status, AudioPlayerStatus.Idle);
    if (state.status === AudioPlayerStatus.Idle) throw new Error('No resource');
    let packets = 0; let bytes = 0;
    for await (const chunk of state.resource.playStream) { packets++; bytes += chunk.length; }
    assert.ok(packets >= 10, `Expected Opus frames, got ${packets}`); assert.ok(bytes > 100);
  } finally { voice.close(); rmSync(dir, { recursive: true, force: true }); }
});
