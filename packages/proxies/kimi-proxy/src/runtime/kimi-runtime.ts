import { EventEmitter } from 'node:events';
import { runBoundedCommand } from '@gian/proxy-protocol/node';
import { KimiConversationRuntime } from './conversation-runtime.js';
import { kimiChildEnvironment } from './home.js';
import type { KimiServerRestClient } from './rest-client.js';
import { assertSupportedKimiVersion, parseKimiVersion } from './versions.js';

type Frame = Record<string, unknown>;
type Handlers = {
  on(event: 'conversation-event', listener: (frame: Frame) => void): void;
  on(event: 'resync', listener: (sessionId: string) => void): void;
  on(event: 'down', listener: () => void): void;
};

/** The lazily started Kimi 2.7 server runtime. The binary's version is
 *  checked before `kimi web` is spawned, so an unsupported PATH or user
 *  install fails with an actionable message instead of mid-turn. */
export class KimiRuntime {
  private readonly events = new EventEmitter();
  private selected: KimiConversationRuntime | null = null;
  private starting: Promise<void> | null = null;
  private stopped = false;

  constructor(private readonly options: { kimiBin: string; endpoint?: { baseUrl: string; token: string } }) {}
  on: Handlers['on'] = (event, listener) => { this.events.on(event, listener); };
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
    if (!this.options.endpoint) {
      const result = await runBoundedCommand(this.options.kimiBin, ['--version'], {
        timeoutMs: 8_000, env: kimiChildEnvironment(process.env),
      });
      const version = parseKimiVersion(`${result.stdout}\n${result.stderr}`);
      if (!version) throw new Error('Kimi Runtime did not report a version.');
      assertSupportedKimiVersion(version);
    }
    if (this.stopped) throw new Error('Kimi runtime is stopped.');
    const runtime = new KimiConversationRuntime({
      kimiBin: this.options.kimiBin,
      ...(this.options.endpoint ? { endpoint: this.options.endpoint } : {}),
    });
    runtime.on('conversation-event', frame => this.events.emit('conversation-event', frame));
    runtime.on('resync', sessionId => this.events.emit('resync', sessionId));
    runtime.on('down', () => this.events.emit('down'));
    this.selected = runtime;
    try { await runtime.start(); } catch (error) { this.selected = null; throw error; }
  }

  async subscribe(sessionId: string): Promise<void> {
    if (!this.selected) throw new Error('Kimi runtime is not started.');
    return this.selected.subscribe(sessionId);
  }

  forgetSession(sessionId: string): void { this.selected?.forgetSession(sessionId); }

  async stop(): Promise<void> {
    this.stopped = true;
    const selected = this.selected;
    await selected?.stop();
    if (this.starting) await this.starting.catch(() => undefined);
    if (this.selected && this.selected !== selected) await this.selected.stop();
    this.selected = null;
  }
}
