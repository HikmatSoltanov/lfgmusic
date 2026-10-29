import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { NetworkingStatusCode, type VoiceConnection } from '@discordjs/voice';
import { VoiceDiagnostics } from '../src/voice-diagnostics.js';
function fixture() {
  const connection = Object.assign(new EventEmitter(), { state: { status: 'signalling' } });
  const network = Object.assign(new EventEmitter(), { state: { code: NetworkingStatusCode.OpeningWs, connectionOptions: { token: 'never-log-this-token' } } });
  const lines: string[] = [];
  const diagnostics = new VoiceDiagnostics(connection as unknown as VoiceConnection, 'guild', line => lines.push(line));
  const attach = () => connection.emit('stateChange', connection.state, { status: 'connecting', networking: network });
  const phase = (code: NetworkingStatusCode) => { const old = network.state; network.state = { ...old, code }; network.emit('stateChange', old, network.state); };
  return { connection, network, lines, diagnostics, attach, phase };
}
test('Voice diagnostics distinguish missing gateway events, WebSocket and UDP discovery', () => {
  const f = fixture();
  try {
    assert.match(f.diagnostics.summary(), /network=not-started/);
    f.attach(); assert.match(f.diagnostics.summary(), /OpeningWs/); assert.match(f.diagnostics.hint(), /WebSocket/);
    f.phase(NetworkingStatusCode.Identifying); assert.match(f.diagnostics.hint(), /идентификацию/);
    f.phase(NetworkingStatusCode.UdpHandshaking); assert.match(f.diagnostics.summary(), /UdpHandshaking/); assert.match(f.diagnostics.hint(), /UDP IP-discovery/);
    assert.ok(!f.lines.join('\n').includes('never-log-this-token'));
  } finally { f.diagnostics.dispose(); }
});
test('Voice close codes and DAVE failures are preserved without exposing error payloads', () => {
  const f = fixture();
  try {
    f.attach(); f.network.emit('close', 4017);
    f.connection.emit('error', new Error('DAVE failed with never-log-this-token'));
    assert.match(f.diagnostics.summary(), /closeCode=4017, error=DAVE/);
    assert.match(f.diagnostics.hint(), /DAVE/);
    assert.ok(!f.lines.join('\n').includes('never-log-this-token'));
  } finally { f.diagnostics.dispose(); }
  assert.equal(f.network.listenerCount('close'), 0); assert.equal(f.connection.listenerCount('stateChange'), 0);
});
test('Replaced voice transports detach old diagnostic listeners', () => {
  const f = fixture();
  try {
    f.attach(); const next = Object.assign(new EventEmitter(), { state: { code: NetworkingStatusCode.Identifying } });
    f.connection.emit('stateChange', f.connection.state, { status: 'connecting', networking: next });
    assert.equal(f.network.listenerCount('stateChange'), 0); assert.equal(next.listenerCount('stateChange'), 1);
    assert.match(f.diagnostics.summary(), /Identifying/);
  } finally { f.diagnostics.dispose(); }
});
