import { NetworkingStatusCode, type Networking, type VoiceConnection, type VoiceConnectionState } from '@discordjs/voice';
/** Only enum states and numeric close codes are logged, never packets, endpoints or tokens. */
export class VoiceDiagnostics {
  private network?: Networking;
  private phase?: NetworkingStatusCode;
  private voice = 'signalling';
  private closeCode?: number;
  private error = '';
  constructor(private connection: VoiceConnection, private guild: string, private log: (line: string) => void = console.warn) {
    connection.on('stateChange', this.onState);
    connection.on('error', this.onError);
    this.onState(connection.state, connection.state);
  }
  private line(text: string) { this.log(`[voice ${this.guild}] ${text}`); }
  private onState = (_old: VoiceConnectionState, state: VoiceConnectionState) => {
    this.voice = state.status;
    this.line(`connection=${state.status}${'closeCode' in state ? ` closeCode=${state.closeCode}` : ''}`);
    if ('closeCode' in state) this.closeCode = state.closeCode;
    const network = 'networking' in state ? state.networking : undefined;
    if (network && this.network !== network) {
      this.detachNetwork(); this.network = network;
      network.on('stateChange', this.onNetworkState); network.on('close', this.onNetworkClose);
      this.onNetworkState(network.state, network.state);
    }
  };
  private onNetworkState = (_old: { code: NetworkingStatusCode }, state: { code: NetworkingStatusCode }) => {
    if (state.code !== NetworkingStatusCode.Closed) this.phase = state.code;
    this.line(`network=${NetworkingStatusCode[state.code] || 'Unknown'}`);
  };
  private onNetworkClose = (code: number) => {
    if (Number.isInteger(code)) this.closeCode = code;
    this.line(`websocket closeCode=${Number.isInteger(code) ? code : 'unknown'}`);
  };
  private onError = (error: Error & { code?: string }) => {
    const allowed = ['ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET', 'ENETUNREACH', 'EHOSTUNREACH', 'EACCES', 'EPERM'];
    this.error = error.code && allowed.includes(error.code) ? error.code : /dave|snazzah|MLS/i.test(error.message) ? 'DAVE' : /encrypt|sodium|crypto/i.test(error.message) ? 'ENCRYPTION' : 'NETWORK_ERROR';
    this.line(`error=${this.error}`);
  };
  summary(): string {
    return `connection=${this.voice}, network=${this.phase === undefined ? 'not-started' : NetworkingStatusCode[this.phase]}${this.closeCode === undefined ? '' : `, closeCode=${this.closeCode}`}${this.error ? `, error=${this.error}` : ''}`;
  }
  hint(): string {
    if (this.closeCode === 4017 || this.closeCode === 4016 || this.error === 'DAVE' || this.error === 'ENCRYPTION') return 'Проверьте DAVE/шифрование через npm run doctor; не отключайте шифрование.';
    if (this.closeCode === 4014) return 'Discord отключил бота: проверьте доступ к каналу, перемещение/исключение и права.';
    if (this.phase === NetworkingStatusCode.UdpHandshaking) return 'Не завершён UDP IP-discovery. Проверьте исходящий UDP/NAT к Discord Voice на Wispbyte.';
    if (this.phase === NetworkingStatusCode.OpeningWs) return 'Не открылся голосовой WebSocket. Проверьте доступ к голосовому шлюзу Discord с хостинга.';
    if (this.phase === NetworkingStatusCode.Identifying) return 'Голосовой шлюз не подтвердил идентификацию. Проверьте closeCode и отсутствие второго процесса бота.';
    if (this.phase === NetworkingStatusCode.SelectingProtocol) return 'Discord не завершил выбор аудиопротокола. Проверьте соединение и версии voice/DAVE.';
    return 'Проверьте обычный голосовой канал, его лимит участников, Connect/Speak и получение voice-событий Discord.';
  }
  private detachNetwork() {
    this.network?.off('stateChange', this.onNetworkState); this.network?.off('close', this.onNetworkClose); this.network = undefined;
  }
  dispose() {
    this.connection.off('stateChange', this.onState); this.connection.off('error', this.onError); this.detachNetwork();
  }
}
