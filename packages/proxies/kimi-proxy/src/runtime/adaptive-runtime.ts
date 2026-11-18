import { EventEmitter } from 'node:events';
import { runBoundedCommand } from '@gian/proxy-protocol/node';
import { KimiConversationRuntime } from './conversation-runtime.js';
import { KimiServerRuntime, type KimiServerEventFrame, type ResyncNotice, type SessionCursor } from './kimi-server.js';
import type { KimiServerRestClient } from './rest-client.js';

type Mode = 'legacy' | 'conversation';
type Frame = Record<string, unknown>;
type Handlers = {
  on(event: 'session-event', listener: (frame: KimiServerEventFrame) => void): void;
  on(event: 'conversation-event', listener: (frame: Frame) => void): void;
  on(event: 'resync', listener: (notice: ResyncNotice) => void): void;
  on(event: 'down', listener: () => void): void;
};

/** Unknown versions are not assumed to use either protocol generation. */
export function kimiRuntimeMode(version: string): Mode {
  if (['2.6.2', '2.6.3'].includes(version)) return 'conversation';
  if (['2.1.1', '2.2.0', '2.3.0', '2.3.2', '2.3.3'].includes(version)) return 'legacy';
  throw new Error(`Kimi Runtime ${version} has no reviewed event protocol.`);
}

export class KimiAdaptiveRuntime {
  private readonly events = new EventEmitter();
  private selected: KimiServerRuntime | KimiConversationRuntime | null = null;
  private selectedMode: Mode | null = null;
  private starting: Promise<void> | null = null;
  private stopped = false;

  constructor(private readonly options: { kimiBin: string; endpoint?: { baseUrl: string; token: string }; mode?: Mode }) {}
  on: Handlers['on'] = (event, listener) => { this.events.on(event, listener); };
  get mode(): Mode | null { return this.selectedMode; }
  get rest(): KimiServerRestClient {
    if (!this.selected) throw new Error('Kimi runtime is not started.');
    return this.selected.rest;
  }

  async start(): Promise<void> {
    if (this.stopped) throw new Error('Kimi runtime is stopped.');
    if (this.starting) return this.starting;
    if (this.selected) { await this.selected.start(); return; }
    this.starting = this.select().finally(() => { this.starting = null; });
    return this.starting;
  }

  private async select(): Promise<void> {
    let mode = this.options.mode;
    if (!mode && this.options.endpoint) mode = 'legacy';
    if (!mode) {
      const result = await runBoundedCommand(this.options.kimiBin, ['--version'], {
        timeoutMs: 8_000, env: { ...process.env, KIMI_CODE_NO_AUTO_UPDATE: '1' },
      });
      const version = `${result.stdout}\n${result.stderr}`.match(/\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/)?.[0];
      if (!version) throw new Error('Kimi Runtime did not report a version.');
      mode = kimiRuntimeMode(version);
    }
    if (this.stopped) throw new Error('Kimi runtime is stopped.');
    const options = { kimiBin: this.options.kimiBin, ...(this.options.endpoint ? { endpoint: this.options.endpoint } : {}) };
    if (mode === 'conversation') {
      const runtime = new KimiConversationRuntime(options);
      runtime.on('conversation-event', frame => this.events.emit('conversation-event', frame));
      runtime.on('resync', sessionId => this.events.emit('resync', { sessionId, reason: 'conversation-disconnect', currentSeq: null, epoch: null } satisfies ResyncNotice));
      runtime.on('down', () => this.events.emit('down'));
      this.selected = runtime;
    } else {
      const runtime = new KimiServerRuntime(options);
      runtime.on('session-event', frame => this.events.emit('session-event', frame));
      runtime.on('resync', notice => this.events.emit('resync', notice));
      runtime.on('down', () => this.events.emit('down'));
      this.selected = runtime;
    }
    this.selectedMode = mode;
    try { await this.selected.start(); } catch (error) { this.selected = null; this.selectedMode = null; throw error; }
  }

  async subscribe(sessionId: string, cursor?: SessionCursor): Promise<void> {
    if (this.selected instanceof KimiServerRuntime) return this.selected.subscribe(sessionId, cursor);
    if (this.selected instanceof KimiConversationRuntime) return this.selected.subscribe(sessionId);
    throw new Error('Kimi runtime is not started.');
  }

  advanceCursor(sessionId: string, cursor: SessionCursor): void {
    if (this.selected instanceof KimiServerRuntime) this.selected.advanceCursor(sessionId, cursor);
  }

  forgetSession(sessionId: string): void { this.selected?.forgetSession(sessionId); }

  async stop(): Promise<void> {
    this.stopped = true;
    const selected = this.selected;
    await selected?.stop();
    if (this.starting) await this.starting.catch(() => undefined);
    if (this.selected && this.selected !== selected) await this.selected.stop();
    this.selected = null; this.selectedMode = null;
  }
}
