import { EventEmitter } from 'node:events';
import { KimiConversationChannel } from './conversation-channel.js';
import { KimiServerRestClient } from './rest-client.js';
import { KimiServerSupervisor, type KimiServerSupervisorResult } from './server-supervisor.js';
import { WsSocket } from './ws.js';

type Frame = Record<string, unknown>;
type EventHandlers = {
  on(event: 'conversation-event', listener: (frame: Frame) => void): void;
  on(event: 'resync', listener: (sessionId: string) => void): void;
  on(event: 'down', listener: () => void): void;
};

/** Runtime for the native 2.6.2 conversation socket. Every reconnect opens a
 * new channel and requests native snapshots; no prior cursor is fabricated. */
export class KimiConversationRuntime {
  private readonly events = new EventEmitter();
  private readonly sessions = new Set<string>();
  private supervisor: KimiServerSupervisorResult | null = null;
  private client: KimiServerRestClient | null = null;
  private socket: WsSocket | null = null;
  private channel: KimiConversationChannel | null = null;
  private starting: Promise<void> | null = null;
  private connecting: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private attempts = 0;
  private stopped = false;

  constructor(private readonly options: { kimiBin: string; endpoint?: { baseUrl: string; token: string } }) {}

  on: EventHandlers['on'] = (event, listener) => { this.events.on(event, listener); };

  get rest(): KimiServerRestClient {
    if (!this.client) throw new Error('Kimi conversation runtime is not started.');
    return this.client;
  }

  get serverPid(): number | null { return this.supervisor?.pid ?? null; }

  async start(): Promise<void> {
    if (this.stopped) throw new Error('Kimi conversation runtime is stopped.');
    if (this.client) return;
    if (this.starting) return this.starting;
    this.starting = this.startSupervisor().finally(() => { this.starting = null; });
    return this.starting;
  }

  private async startSupervisor(): Promise<void> {
    const supervisor = await new KimiServerSupervisor(this.options).start();
    if (this.stopped) { await supervisor.stop(); throw new Error('Kimi conversation runtime is stopped.'); }
    this.supervisor = supervisor;
    this.client = new KimiServerRestClient(supervisor.endpoint);
    void supervisor.exit.then(() => {
      if (this.stopped || this.supervisor !== supervisor) return;
      this.supervisor = null; this.client = null; this.clearTimer();
      this.disposeSocket(); this.events.emit('down');
    });
  }

  async subscribe(sessionId: string): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.ensureConnected();
        const channel = this.channel;
        if (!channel) throw new Error('Kimi conversation channel is unavailable.');
        await channel.refresh(sessionId);
        if (this.channel !== channel || this.stopped) throw new Error('Kimi conversation channel changed during subscription.');
        this.sessions.add(sessionId);
        return;
      } catch (error) {
        const transient = error instanceof Error && [
          'Kimi conversation channel is unavailable.',
          'Kimi conversation channel changed during subscription.',
          'Kimi conversation channel closed before subscription was acknowledged.',
          'WebSocket is not open.',
        ].includes(error.message);
        if (!transient || this.stopped || attempt >= 2) throw error;
        await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)));
      }
    }
  }

  forgetSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    try { this.channel?.forget(sessionId); } catch { /* disconnect owns recovery */ }
  }

  private async ensureConnected(): Promise<void> {
    if (this.stopped || !this.supervisor) throw new Error('Kimi conversation runtime is stopped or unavailable.');
    if (this.connecting) return this.connecting;
    if (this.socket?.status === 'open' && this.channel) return;
    this.connecting = this.connect().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  private async connect(): Promise<void> {
    const supervisor = this.supervisor;
    if (!supervisor) throw new Error('Kimi conversation runtime is unavailable.');
    const socket = await WsSocket.connect({ url: `${supervisor.endpoint.baseUrl.replace(/^http/, 'ws')}/api/v1/ws`,
      headers: { Authorization: `Bearer ${supervisor.endpoint.token}` }, connectTimeoutMs: 10_000 });
    if (this.stopped || this.supervisor !== supervisor) {
      try { socket.close(); } catch { /* already closed */ }
      throw new Error('Kimi conversation runtime changed while connecting.');
    }
    const channel = new KimiConversationChannel(frame => socket.sendText(JSON.stringify(frame)),
      frame => this.events.emit('conversation-event', frame));
    this.socket = socket; this.channel = channel;
    socket.on('message', (raw: string) => {
      if (this.socket !== socket || this.stopped) return;
      try { channel.receive(raw); } catch { this.disconnect(socket); }
    });
    socket.on('close', () => this.disconnect(socket));
    try {
      await Promise.all([...this.sessions].map(sessionId => channel.subscribe(sessionId)));
      if (this.socket !== socket || this.stopped) throw new Error('Kimi conversation socket closed while reconnecting.');
      this.attempts = 0; this.clearTimer();
    } catch (error) {
      this.disconnect(socket);
      throw error;
    }
  }

  private disconnect(socket: WsSocket): void {
    if (this.socket !== socket) return;
    this.socket = null;
    const channel = this.channel; this.channel = null; channel?.close();
    try { if (socket.status === 'open') socket.close(); } catch { /* already closed */ }
    if (this.stopped || !this.client) return;
    for (const sessionId of this.sessions) this.events.emit('resync', sessionId);
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped || !this.client || this.timer) return;
    const delay = Math.min(10_000, 500 * 2 ** this.attempts++);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.stopped && !this.socket) void this.ensureConnected().catch(() => this.scheduleReconnect());
    }, delay);
    this.timer.unref();
  }

  private clearTimer(): void { if (this.timer) clearTimeout(this.timer); this.timer = null; }

  private disposeSocket(): void {
    const socket = this.socket; this.socket = null;
    this.channel?.close(); this.channel = null;
    try { if (socket?.status === 'open') socket.close(); } catch { /* already closed */ }
  }

  async stop(): Promise<void> {
    this.stopped = true; this.clearTimer(); this.sessions.clear(); this.disposeSocket();
    const supervisor = this.supervisor; this.supervisor = null; this.client = null;
    await supervisor?.stop();
  }
}
