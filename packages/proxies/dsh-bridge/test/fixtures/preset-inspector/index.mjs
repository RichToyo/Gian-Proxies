import { watch } from 'node:fs';
import { appendFile, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

const scopeModule = createRequire(process.argv[1]).resolve('@deepseek-ai/dsh-scope');
const { scopeOf } = await import(pathToFileURL(scopeModule).href);

export default class GianCanaryPresetInspector {
  static inject = ['agentPresets', 'settings', 'tools'];

  constructor(ctx) {
    this.ctx = ctx;
    this.reportPath = process.env.GIAN_DSH_CANARY_REPORT;
    this.triggerPath = process.env.GIAN_DSH_CANARY_SETTINGS_TRIGGER;
    this.updating = false;
    ctx.on('agent/created', async ({ agent, source }) => {
      try {
        const tools = ctx.agentPresets.serviceFor(agent, 'tools') ?? agent.ctx.tools;
        const scope = scopeOf(agent.ctx);
        const schemas = tools.schemas(scope);
        const prompt = ctx.agentPresets.serviceFor(agent, 'systemPrompt') ?? agent.ctx.systemPrompt;
        if (!prompt || typeof prompt.assemble !== 'function') throw new Error('Native system prompt assembly is unavailable');
        const assembled = await prompt.assemble({ scope, agent });
        if (!Array.isArray(assembled.tools)) throw new Error('Native model tool view is unavailable');
        await this.report({
          type: 'agent',
          nativeSessionId: agent.session.id,
          source,
          preset: ctx.agentPresets.composedPreset(agent.ctx),
          tools: schemas.map(schema => schema.name).sort(),
          modelTools: assembled.tools.map(schema => schema.name).sort(),
        });
      } catch (error) {
        await this.report({ type: 'agent-error', stack: error?.stack ?? String(error) });
        throw error;
      }
    });
    if (this.triggerPath) {
      this.watcher = watch(dirname(this.triggerPath), (_event, filename) => {
        if (filename === basename(this.triggerPath) && !this.updating) {
          this.updating = this.updateDefault();
        }
      });
      ctx.effect(() => () => this.watcher.close());
    }
  }

  async report(value) {
    if (this.reportPath) await appendFile(this.reportPath, `${JSON.stringify(value)}\n`, 'utf8');
  }

  async updateDefault() {
    try {
      const selectedDefault = await readFile(this.triggerPath, 'utf8');
      const descriptor = this.ctx.settings.describe({ redactSecrets: true })
        .find(item => item.ns === 'agent-preset-registry');
      await this.report({ type: 'settings-started', selectedDefault: selectedDefault.trim() });
      void this.ctx.settings.update(
        'agent-preset-registry',
        { selectedDefault: selectedDefault.trim() },
        descriptor?.revision,
      ).catch(async error => {
        await this.report({ type: 'settings-error', message: error instanceof Error ? error.message : String(error) });
      });
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        await this.report({ type: 'settings-error', message: error instanceof Error ? error.message : String(error) });
      }
    }
  }
}
