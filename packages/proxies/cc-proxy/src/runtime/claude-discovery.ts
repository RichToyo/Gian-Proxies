/**
 * Claude Code capability discovery and stream-json parsing helpers.
 *
 * Everything here is runtime-independent: model and permission-mode
 * discovery that never starts a paid turn, settings/wrapper resolution, and
 * the parsers for Claude stream-json frames shared by the live runtime
 * (`claude-stream-runtime.ts`) and its tests.
 */

import { spawn } from 'node:child_process';
import { closeSync, openSync, readFileSync, readSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';

import type { TokenUsageUpdate } from '@gian/shared';
import type { EffortLevel, ModelCapabilities } from '../core/types.js';
import { probeClaudeNativeModels } from './native-model-catalog.js';

const NO_SESSION_PERSISTENCE_FLAG = '--no-session-persistence';
const CLAUDE_DEFAULT_MODEL_ID = 'claude-default';
const GATEWAY_MODELS_CACHE_MAX_BYTES = 1024 * 1024;
const GATEWAY_MODELS_MAX_ENTRIES = 1000;
const GATEWAY_MODEL_TEXT_MAX_LENGTH = 512;
const BUILTIN_FALLBACK_ALIAS_MODELS = new Set(['opus', 'sonnet', 'haiku']);
const CURRENT_SETTINGS_MODEL_DESCRIPTION = 'From the current Claude settings configuration.';
const BUILTIN_FALLBACK_ALIAS_DESCRIPTION = 'Unverified alias from the built-in list.';
const BUILTIN_FALLBACK_MODEL_ERROR_PREFIX =
  'This model is an unverified alias from the built-in fallback list; the current CLI may not support it.';

function nonNegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}

function optionalNonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

export interface ClaudeAssistantUsageSample {
  context: { used: number };
  model: string | null;
}

export function isClaudeCompactBoundary(event: Record<string, unknown>): boolean {
  return event.type === 'system' && event.subtype === 'compact_boundary';
}

const HANDLED_EVENT_TYPES = new Set([
  'assistant',
  'user',
  'result',
  // Streaming-input frames the runtime consumes itself.
  'stream_event',
  'control_request',
  'control_response',
  'control_cancel_request',
]);
const HANDLED_SYSTEM_SUBTYPES = new Set([
  'init',
  'task_started',
  'task_notification',
  'compact_boundary',
]);
/** High-frequency Claude Code 2.1.237+ progress pulses. Each would otherwise
 *  become a unique transcript activity and freeze the page. */
const IGNORED_EVENT_TYPES = new Set(['tool_progress']);
const IGNORED_SYSTEM_SUBTYPES = new Set([
  'thinking_tokens',
  'task_progress',
  'task_updated',
  'background_tasks_changed',
  'vcs_state_changed',
  // Per-run status pulses and session bookkeeping in streaming-input mode.
  'status',
  'session_title_changed',
  'session_state_changed',
]);

export type ClaudeStreamEventClass = 'handled' | 'ignored' | 'unknown';

/** Classify a Claude stream-json frame for transcript surfacing.
 *  `handled` already has a dedicated runtime emitter; `ignored` is known
 *  progress noise; `unknown` may surface once per (type, subtype) per turn. */
export function classifyClaudeStreamEvent(event: Record<string, unknown>): ClaudeStreamEventClass {
  const eventType = typeof event.type === 'string' ? event.type : '';
  if (!eventType) return 'ignored';
  if (HANDLED_EVENT_TYPES.has(eventType)) return 'handled';
  if (IGNORED_EVENT_TYPES.has(eventType)) return 'ignored';
  if (eventType === 'system') {
    const subtype = typeof event.subtype === 'string' ? event.subtype : '';
    if (HANDLED_SYSTEM_SUBTYPES.has(subtype)) return 'handled';
    if (IGNORED_SYSTEM_SUBTYPES.has(subtype)) return 'ignored';
    return 'unknown';
  }
  return 'unknown';
}

export function unknownClaudeEventKey(event: Record<string, unknown>): string {
  const eventType = typeof event.type === 'string' && event.type ? event.type : 'unknown';
  const subtype = typeof event.subtype === 'string' ? event.subtype : '';
  return subtype ? `${eventType}:${subtype}` : eventType;
}

/** A top-level assistant event is the only stream-json sample that describes
 * the prompt currently occupying Claude's context. `result.usage` is an
 * aggregate across API calls and must never be used as this numerator. */
export function parseClaudeAssistantUsage(
  event: Record<string, unknown>,
): ClaudeAssistantUsageSample | null {
  if (event.type !== 'assistant' || !event.message || typeof event.message !== 'object') {
    return null;
  }
  const message = event.message as Record<string, unknown>;
  if (!message.usage || typeof message.usage !== 'object') return null;
  const usage = message.usage as Record<string, unknown>;
  const input = optionalNonNegativeInteger(usage.input_tokens);
  if (input === null) return null;
  const rawCacheRead = usage.cache_read_input_tokens;
  const rawCacheCreation = usage.cache_creation_input_tokens;
  const cacheRead = optionalNonNegativeInteger(usage.cache_read_input_tokens);
  const cacheCreation = optionalNonNegativeInteger(usage.cache_creation_input_tokens);
  if (
    (rawCacheRead !== undefined && rawCacheRead !== null && cacheRead === null)
    || (rawCacheCreation !== undefined && rawCacheCreation !== null && cacheCreation === null)
  ) return null;
  const used = input + (cacheRead ?? 0) + (cacheCreation ?? 0);
  return {
    context: { used },
    model: typeof message.model === 'string' ? message.model : null,
  };
}

export function parseClaudeResultUsage(
  event: Record<string, unknown>,
  currentContext: { used: number } | null,
  currentModel: string | null,
): TokenUsageUpdate | null {
  if (event.type !== 'result') return null;

  let contextWindow: number | undefined;
  if (event.modelUsage && typeof event.modelUsage === 'object') {
    const entries = Object.entries(event.modelUsage as Record<string, unknown>);
    const selected = entries.find(([model]) => model === currentModel)?.[1]
      ?? (entries.length === 1 ? entries[0]?.[1] : undefined);
    if (selected && typeof selected === 'object') {
      const rawWindow = (selected as Record<string, unknown>).contextWindow
        ?? (selected as Record<string, unknown>).context_window;
      const parsedWindow = nonNegativeInteger(rawWindow);
      if (parsedWindow > 0) contextWindow = parsedWindow;
    }
  }

  let conversation: TokenUsageUpdate['conversation'];
  let sawModelTokenFields = false;
  if (event.modelUsage && typeof event.modelUsage === 'object') {
    let sawTokenUsage = false;
    let invalidModelUsage = false;
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedInputTokens = 0;
    for (const value of Object.values(event.modelUsage as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue;
      const usage = value as Record<string, unknown>;
      const hasTokenFields = [
        'inputTokens',
        'input_tokens',
        'outputTokens',
        'output_tokens',
        'cacheReadInputTokens',
        'cache_read_input_tokens',
        'cacheCreationInputTokens',
        'cache_creation_input_tokens',
      ].some(field => Object.hasOwn(usage, field));
      // Newer Claude emits context-only modelUsage entries alongside the
      // legacy top-level aggregate. Those contain no token fields and may
      // fall through. Once a model advertises any token counter, however,
      // it participates in the whole-tree snapshot and must be complete.
      if (!hasTokenFields) continue;
      sawModelTokenFields = true;
      const input = optionalNonNegativeInteger(usage.inputTokens ?? usage.input_tokens);
      const output = optionalNonNegativeInteger(usage.outputTokens ?? usage.output_tokens);
      const rawCacheRead = usage.cacheReadInputTokens ?? usage.cache_read_input_tokens;
      const rawCacheCreation = usage.cacheCreationInputTokens
        ?? usage.cache_creation_input_tokens;
      const cacheRead = optionalNonNegativeInteger(
        rawCacheRead,
      );
      const cacheCreation = optionalNonNegativeInteger(
        rawCacheCreation,
      );
      // The stream-json v1 modelUsage counters are a complete snapshot.
      // Context-only entries are valid (and handled above), but a partial or
      // malformed counter set must not become a zero-filled conversation.
      if (
        input === null
        || output === null
        || (rawCacheRead !== undefined && rawCacheRead !== null && cacheRead === null)
        || (rawCacheCreation !== undefined && rawCacheCreation !== null && cacheCreation === null)
      ) {
        invalidModelUsage = true;
        break;
      }
      sawTokenUsage = true;
      const cached = (cacheRead ?? 0) + (cacheCreation ?? 0);
      inputTokens += (input ?? 0) + cached;
      outputTokens += output ?? 0;
      cachedInputTokens += cached;
    }
    if (sawTokenUsage && !invalidModelUsage) {
      conversation = {
        mode: 'delta',
        inputTokens,
        outputTokens,
        cachedInputTokens,
        totalTokens: inputTokens + outputTokens,
      };
    }
  }

  // Older Claude CLI builds may expose only the top-level query aggregate.
  // It excludes subagents but remains a valid per-invocation fallback.
  if (!conversation && !sawModelTokenFields && event.usage && typeof event.usage === 'object') {
    const usage = event.usage as Record<string, unknown>;
    const input = optionalNonNegativeInteger(usage.input_tokens);
    const output = optionalNonNegativeInteger(usage.output_tokens);
    const rawCacheRead = usage.cache_read_input_tokens;
    const rawCacheCreation = usage.cache_creation_input_tokens;
    const cacheRead = optionalNonNegativeInteger(usage.cache_read_input_tokens);
    const cacheCreation = optionalNonNegativeInteger(usage.cache_creation_input_tokens);
    if (
      input !== null
      && output !== null
      && !(rawCacheRead !== undefined && rawCacheRead !== null && cacheRead === null)
      && !(rawCacheCreation !== undefined && rawCacheCreation !== null && cacheCreation === null)
    ) {
      const cachedInputTokens = (cacheRead ?? 0) + (cacheCreation ?? 0);
      const inputTokens = input + cachedInputTokens;
      const outputTokens = output;
      conversation = {
        mode: 'delta',
        inputTokens,
        outputTokens,
        cachedInputTokens,
        totalTokens: inputTokens + outputTokens,
      };
    }
  }

  if (!currentContext && !conversation) return null;
  return {
    ...(currentContext
      ? {
          context: {
            used: currentContext.used,
            ...(contextWindow === undefined ? {} : { window: contextWindow }),
          },
        }
      : {}),
    ...(conversation ? { conversation } : {}),
  };
}

function allowClaudePrintProbe(): boolean {
  return process.env.GIAN_ALLOW_CLAUDE_PRINT_PROBE === '1';
}

export function shouldRetryWithoutNoSessionPersistence(stderr: string): boolean {
  const s = stderr.toLowerCase();
  return s.includes(NO_SESSION_PERSISTENCE_FLAG)
    && (s.includes('unknown option') || s.includes('unknown argument') || s.includes('not recognized'));
}

/**
 * Ask Claude Code what model it would use by spawning a throwaway print-mode
 * process and reading the `system init` event. The process is killed as soon
 * as init arrives, before a real assistant turn is needed.
 */
function probeCurrentModel(): Promise<string | null> {
  const run = (includeNoSessionPersistence: boolean): Promise<{ model: string | null; retry: boolean }> => new Promise((resolve) => {
    const args = [
      '-p', 'x',
      '--output-format', 'stream-json',
      '--verbose',
      ...(includeNoSessionPersistence ? [NO_SESSION_PERSISTENCE_FLAG] : []),
      '--dangerously-skip-permissions',
    ];
    const proc = spawn(claudeExecutable(), args, { stdio: ['pipe', 'pipe', 'pipe'] });
    proc.stdin.end();

    let resolved = false;
    // Capture stderr so a spawn-time CLI rejection (unknown flag, wrong
    // binary version) surfaces in cc-proxy stderr instead of looking like
    // a silent null — discovery used to swallow this and the UI just sat
    // on an empty model list forever.
    let stderrBuf = '';
    const finish = (model: string | null, retry = false) => {
      if (resolved) return;
      resolved = true;
      resolve({ model, retry });
      try { proc.kill('SIGTERM'); } catch { /* ignore */ }
    };
    proc.stderr!.on('data', d => { stderrBuf += d.toString(); });
    const lines = createInterface({ input: proc.stdout! });
    lines.on('line', (line) => {
      if (resolved) return;
      try {
        const event = JSON.parse(line.trim()) as Record<string, unknown>;
        if (event.type === 'system' && event.subtype === 'init' && typeof event.model === 'string') {
          finish(event.model);
        }
      } catch { /* ignore */ }
    });

    proc.on('exit', (code) => {
      if (!resolved) {
        if (includeNoSessionPersistence && shouldRetryWithoutNoSessionPersistence(stderrBuf)) {
          finish(null, true);
          return;
        }
        if (code !== 0 && stderrBuf.trim()) {
          console.error(`[cc-proxy:probe model] claude exited ${code}: ${stderrBuf.trim().split('\n')[0]}`);
        }
        finish(null);
      }
    });

    // Survive a missing `claude` binary without crashing the proxy process.
    proc.on('error', (err) => {
      if (!resolved) {
        console.error(`[cc-proxy:probe model] spawn error: ${err.message}`);
        finish(null);
      }
    });

    // Timeout after 30s.
    setTimeout(() => finish(null), 30_000);
  });

  return new Promise((resolve) => {
    void run(true).then(first => {
      if (!first.retry) {
        resolve(first.model);
        return;
      }
      void run(false).then(second => resolve(second.model));
    });
  });
}

export function parseEffortLevelsFromHelp(helpText: string): EffortLevel[] {
  const effortSection = helpText.match(/--effort\s+<level>[\s\S]*?\(([^)]*)\)/);
  if (!effortSection?.[1]) return [];
  const seen = new Set<string>();
  const levels: EffortLevel[] = [];
  for (const raw of effortSection[1].split(',')) {
    const level = raw.trim();
    if (!level || seen.has(level)) continue;
    seen.add(level);
    levels.push(level);
  }
  return levels;
}

/** Parse the exact native `--permission-mode` choices out of `claude --help`.
 *  The catalog uses this list so it can never advertise a mode the configured
 *  Runtime does not actually accept. */
export function parseClaudePermissionModesFromHelp(helpText: string): string[] {
  const section = helpText.match(/--permission-mode\s+<mode>[\s\S]*?\(choices:\s*([^)]*)\)/);
  if (!section?.[1]) return [];
  const seen = new Set<string>();
  const modes: string[] = [];
  for (const match of section[1].matchAll(/"([^"]+)"/g)) {
    const mode = match[1]?.trim();
    if (!mode || seen.has(mode)) continue;
    seen.add(mode);
    modes.push(mode);
  }
  return modes;
}

function probeClaudeHelp(): Promise<string> {
  return new Promise((resolve) => {
    const proc = spawn(claudeExecutable(), ['--help'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let resolved = false;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      resolve(output);
    };
    proc.stdout?.on('data', d => { output += d.toString(); });
    proc.stderr?.on('data', d => { output += d.toString(); });
    proc.on('error', () => finish());
    proc.on('exit', () => finish());
    setTimeout(() => {
      finish();
      try { proc.kill('SIGTERM'); } catch { /* ignore */ }
    }, 10_000);
  });
}


const SCRIPT_PROBE_BYTES = 16 * 1024;

/** Expand a leading `~` against the given home directory. */
function expandHome(raw: string, home: string): string {
  if (raw === '~') return home;
  if (raw.startsWith('~/')) return join(home, raw.slice(2));
  return raw;
}

/** Absolute `HOME=` / `export HOME=` in a wrapper. `$` and relative values
 *  fail closed so `$HOME` inside `CLAUDE_CONFIG_DIR` is not expanded against
 *  the Host's own home. */
export function extractHomeFromScript(scriptText: string): string | null {
  const match = scriptText.match(/(?:^|[\n;])\s*(?:export\s+)?HOME\s*=\s*("[^"\n]*"|'[^'\n]*'|[^\s;#]+)/);
  if (!match?.[1]) return null;
  let value = match[1];
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  value = value.trim();
  if (!value || value.includes('$') || !isAbsolute(value)) return null;
  return value;
}

/**
 * Extract the value assigned to CLAUDE_CONFIG_DIR in a wrapper script,
 * resolving only the expansions we understand: `$HOME`, a leading `~`, and
 * `${VAR:-default}` / `${VAR-default}` (the default wins, which matches how
 * the wrapper behaves when the outer variable is unset). Returns null when
 * there is no assignment or the value still contains expansions we can't
 * resolve locally.
 */
export function extractClaudeConfigDirFromScript(scriptText: string, home: string = homedir()): string | null {
  const match = scriptText.match(/CLAUDE_CONFIG_DIR\s*=\s*("[^"\n]*"|'[^'\n]*'|[^\s;]+)/);
  if (!match?.[1]) return null;
  let value = match[1];
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  value = value.replace(/\$\{[A-Za-z_][A-Za-z0-9_]*:?-([^}]*)\}/g, '$1');
  value = expandHome(value.replace(/\$HOME/g, home), home);
  if (!value || value.includes('$') || !isAbsolute(value)) return null;
  return value;
}

/** Extract a literal `ANTHROPIC_BASE_URL` assignment from a wrapper script.
 *  `$` expansions are not resolved here: an unreadable value fails closed
 *  instead of being compared with the gateway cache. */
export function extractAnthropicBaseUrlFromScript(scriptText: string): string | null {
  const match = scriptText.match(/ANTHROPIC_BASE_URL\s*=\s*("[^"\n]*"|'[^'\n]*'|[^\s;]+)/);
  if (!match?.[1]) return null;
  let value = match[1];
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  value = value.trim();
  if (!value || value.includes('$') || value.length > 2048) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1F\x7F]/.test(value) || !/^https?:\/\//i.test(value)) return null;
  return value;
}

function readWrapperAnthropicBaseUrl(executable: string = claudeExecutable()): string | null {
  const head = readFileHead(executable, SCRIPT_PROBE_BYTES);
  // A NUL byte means a real binary, not a wrapper script.
  if (!head || head.includes(0)) return null;
  return extractAnthropicBaseUrlFromScript(head.toString('utf8'));
}

/** Read the first `maxBytes` of a file, or null when unreadable. */
function readFileHead(path: string, maxBytes: number): Buffer | null {
  try {
    const fd = openSync(path, 'r');
    try {
      const buf = Buffer.alloc(maxBytes);
      const bytesRead = readSync(fd, buf, 0, maxBytes, 0);
      return buf.subarray(0, bytesRead);
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

function readSettingsObject(path: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Top-level merge. `settings.local.json` overrides the same key and leaves
 *  every other key from `settings.json`. */
export function readMergedClaudeSettings(dir: string): unknown | null {
  const base = readSettingsObject(join(dir, 'settings.json'));
  const local = readSettingsObject(join(dir, 'settings.local.json'));
  if (!base && !local) return null;
  if (!base) return local;
  if (!local) return base;
  return { ...base, ...local };
}

/** A readable settings file in the directory. Model discovery merges both
 *  files; this path only identifies the profile directory. */
function preferredSettingsFile(dir: string): string | null {
  for (const name of ['settings.local.json', 'settings.json']) {
    const path = join(dir, name);
    try {
      JSON.parse(readFileSync(path, 'utf8'));
      return path;
    } catch {
      // Missing, unreadable, or invalid JSON — try the other file.
    }
  }
  return null;
}

/**
 * Locate the Claude settings file the configured CLI actually reads, trying
 * in order:
 *   a. `$CLAUDE_CONFIG_DIR` (when the env var is set),
 *   b. a CLAUDE_CONFIG_DIR assignment inside the configured CLI when that CLI
 *      is a text wrapper script (binary executables are skipped),
 *   c. `~/.claude` under a wrapper `HOME=` when the script assigns one,
 *      otherwise the process home.
 * Within a directory, valid `settings.local.json` is preferred over
 * `settings.json`. A wrapper `HOME=` also supplies `$HOME` for that script.
 * An explicit CLAUDE_CONFIG_DIR, and a wrapper HOME, are authoritative:
 * a missing or invalid profile there must not borrow the process home.
 * Only legacy, unscoped discovery falls through to the process home.
 */
export function resolveClaudeSettingsPath(options?: {
  env?: NodeJS.ProcessEnv;
  home?: string;
  executable?: string;
}): string | null {
  const env = options?.env ?? process.env;
  const home = options?.home ?? homedir();
  const executable = options?.executable ?? claudeExecutable();

  const fromEnv = env.CLAUDE_CONFIG_DIR?.trim();
  if (fromEnv) {
    const expanded = expandHome(fromEnv, home);
    if (!isAbsolute(expanded)) return null;
    return preferredSettingsFile(expanded);
  }

  const dirs: string[] = [];
  let scriptHome: string | null = null;
  const head = readFileHead(executable, SCRIPT_PROBE_BYTES);
  // A NUL byte means we're looking at a real binary, not a wrapper script.
  if (head && !head.includes(0)) {
    const script = head.toString('utf8');
    scriptHome = extractHomeFromScript(script);
    const dir = extractClaudeConfigDirFromScript(script, scriptHome ?? home);
    if (dir) dirs.push(dir);
  }

  // Claude reads ~/.claude from the HOME it was started with. A wrapper
  // assignment is that home, so a missing profile must not borrow another.
  dirs.push(join(scriptHome ?? home, '.claude'));
  for (const dir of dirs) {
    const found = preferredSettingsFile(dir);
    if (found) return found;
  }
  return null;
}

/** Pull the `availableModels` string list out of a parsed Claude settings
 *  object. Returns [] for anything that isn't a usable non-empty list. */
export function parseAvailableModels(settings: unknown): string[] {
  if (!settings || typeof settings !== 'object') return [];
  const raw = (settings as Record<string, unknown>).availableModels;
  if (!Array.isArray(raw)) return [];
  return raw.filter((m): m is string => typeof m === 'string' && m.length > 0);
}

/** The settings.json `model` field, trimmed. Aliases and full model ids are
 *  kept verbatim so the catalog can offer the value the CLI is configured
 *  to use. Blank and non-string values are ignored. */
export function parseSettingsModel(settings: unknown): string | null {
  if (!settings || typeof settings !== 'object') return null;
  const raw = (settings as Record<string, unknown>).model;
  if (typeof raw !== 'string') return null;
  const model = raw.trim();
  if (!model || model.length > GATEWAY_MODEL_TEXT_MAX_LENGTH) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1F\x7F]/.test(model)) return null;
  return model;
}

interface ClaudeGatewayModel {
  id: string;
  displayName: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSafeGatewayText(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= GATEWAY_MODEL_TEXT_MAX_LENGTH
    && value.trim().length > 0
    // Model ids and display names are rendered in the UI and included in
    // debug output. Reject control characters from the local cache rather
    // than letting a corrupt cache inject terminal/UI control sequences.
    // eslint-disable-next-line no-control-regex
    && !/[\x00-\x1F\x7F]/.test(value);
}

function isGatewayModelDiscoveryEnabled(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true';
}

function gatewayDiscoveryExplicitlyDisabled(settings: unknown): boolean {
  if (!isRecord(settings) || !isRecord(settings.env)) return false;
  if (!('CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY' in settings.env)) return false;
  return !isGatewayModelDiscoveryEnabled(
    settings.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY,
  );
}

/** Base URL from settings.env, and only when that profile turned gateway
 *  discovery on. A URL with discovery left unset stays unused. */
function enabledSettingsGatewayBaseUrl(settings: unknown): string | null {
  if (!isRecord(settings) || !isRecord(settings.env)) return null;
  if (!isGatewayModelDiscoveryEnabled(
    settings.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY,
  )) return null;
  const raw = settings.env.ANTHROPIC_BASE_URL;
  if (typeof raw !== 'string') return null;
  const baseUrl = raw.trim();
  return baseUrl || null;
}

/** Validate Claude Code's gateway-model discovery cache. A cache is usable
 *  when discovery is not explicitly disabled and its baseUrl exactly matches
 *  either the enabled settings.env.ANTHROPIC_BASE_URL or the wrapper script's
 *  ANTHROPIC_BASE_URL. Every model entry must still have the expected
 *  id/display_name shape. Invalid caches fail closed to []. */
function parseGatewayModelsCache(
  settings: unknown,
  cache: unknown,
  wrapperBaseUrl?: string | null,
): ClaudeGatewayModel[] {
  if (gatewayDiscoveryExplicitlyDisabled(settings) || !isRecord(cache)) return [];
  const expectedBaseUrls = new Set<string>();
  const settingsBaseUrl = enabledSettingsGatewayBaseUrl(settings);
  if (settingsBaseUrl) expectedBaseUrls.add(settingsBaseUrl);
  const wrapper = wrapperBaseUrl?.trim() ?? '';
  if (wrapper) expectedBaseUrls.add(wrapper);
  if (expectedBaseUrls.size === 0) return [];
  const rawCacheBaseUrl = cache.baseUrl;
  if (typeof rawCacheBaseUrl !== 'string') return [];
  const cacheBaseUrl = rawCacheBaseUrl.trim();
  if (!cacheBaseUrl || !expectedBaseUrls.has(cacheBaseUrl)) return [];
  if (!Array.isArray(cache.models)
    || cache.models.length === 0
    || cache.models.length > GATEWAY_MODELS_MAX_ENTRIES) return [];

  const seen = new Set<string>();
  const models: ClaudeGatewayModel[] = [];
  for (const rawModel of cache.models) {
    if (!isRecord(rawModel)
      || !isSafeGatewayText(rawModel.id)
      || !isSafeGatewayText(rawModel.display_name)) return [];
    if (seen.has(rawModel.id)) continue;
    seen.add(rawModel.id);
    models.push({ id: rawModel.id, displayName: rawModel.display_name });
  }
  return models;
}

/** Read only the bounded gateway cache owned by the resolved settings
 * profile. Missing, oversized, unreadable, malformed, or mismatched caches
 * are deliberately indistinguishable and return []. */
function readGatewayModelsCache(
  settingsPath: string,
  settings: unknown,
  wrapperBaseUrl?: string | null,
): ClaudeGatewayModel[] {
  const cachePath = join(dirname(settingsPath), 'cache', 'gateway-models.json');
  const raw = readFileHead(cachePath, GATEWAY_MODELS_CACHE_MAX_BYTES + 1);
  if (!raw || raw.byteLength > GATEWAY_MODELS_CACHE_MAX_BYTES) return [];
  try {
    return parseGatewayModelsCache(settings, JSON.parse(raw.toString('utf8')), wrapperBaseUrl);
  } catch {
    return [];
  }
}

function isUnrecognizedModelError(text: string): boolean {
  const sample = text.toLowerCase();
  return /model[^\n]{0,160}(does not exist|doesn't exist|do not exist|not found|unknown|unsupported|not supported|invalid|not available|no access)/.test(sample)
    || /(unknown|invalid|unsupported|unrecognized) model\b/.test(sample)
    || /no such model/.test(sample)
    || /not a valid model/.test(sample);
}

export function annotateBuiltinFallbackModelError(
  fallbackActive: boolean,
  model: string | null,
  detail: string,
): string {
  if (!fallbackActive || !model || !BUILTIN_FALLBACK_ALIAS_MODELS.has(model)) return detail;
  if (!isUnrecognizedModelError(detail)) return detail;
  return `${BUILTIN_FALLBACK_MODEL_ERROR_PREFIX}\n${detail}`;
}

/** Stable slug for building capability ids out of arbitrary model strings. */
function slugifyModelId(model: string): string {
  const slug = model.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'model';
}


export function claudeExecutable(): string {
  // Honor an explicit override first (escape hatch for launchd contexts where
  // PATH is sparse). Otherwise lean on the inherited PATH — Claude Code can
  // live in /opt/homebrew/bin, ~/.local/bin, /usr/local/bin, or a custom
  // location, so hardcoding any one path is strictly worse than PATH lookup.
  const configured = process.env.CLAUDE_BIN?.trim();
  if (configured) return configured;
  return 'claude';
}

/** Label the empty-model Default entry with the model Claude reported at
 *  init. Returns false when nothing changed, including a repeat of the same
 *  id. Concrete catalog rows are left alone. */
export function labelDefaultModel(models: ModelCapabilities[], detectedModelId: string): boolean {
  const id = detectedModelId.trim();
  if (!id) return false;
  const entry = models.find((model) => model.isDefault && model.model === '');
  if (!entry) return false;
  const displayName = `Default · ${id}`;
  if (entry.displayName === displayName) return false;
  entry.displayName = displayName;
  return true;
}

/**
 * Normalize a session display name for the Claude CLI `--name` flag
 * (SESSION-NAME-001). Strips control characters (incl. CR/LF) and caps the
 * length so a pasted multi-line name can't smuggle extra argv content or blow
 * up the terminal-title. Returns null for empty/whitespace-only input so the
 * caller omits the flag entirely.
 */
export function sanitizeDisplayName(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const cleaned = [...raw.replace(/[\x00-\x1F\x7F]/g, ' ').trim()]
    .slice(0, 200)
    .join('');
  return cleaned.length > 0 ? cleaned : null;
}


export interface ClaudeCapabilities {
  models: ModelCapabilities[];
  /** Native `--permission-mode` choices from the configured CLI help. */
  permissionModes: string[];
  /** True only while the menu is the built-in opus/sonnet/haiku list. */
  builtinFallbackActive: boolean;
}

/** Billing-safe capability discovery: local configuration, `claude --help`
 *  and, when no explicit menu exists, Claude's initialize control response.
 *  No user message is ever sent. */
export async function discoverClaudeCapabilities(options: {
  signal?: AbortSignal;
  debug?: (message: string) => void;
} = {}): Promise<ClaudeCapabilities> {
  const debug = options.debug ?? (() => undefined);
  let models: ModelCapabilities[];
  let builtinFallbackActive = false;
  debug('[runtime] Discovering Claude capabilities (billing-safe)...');
  const [probedDefaultModel, helpText] = await Promise.all([
    allowClaudePrintProbe() ? probeCurrentModel() : Promise.resolve(null),
    probeClaudeHelp(),
  ]);
  const supportedEfforts = parseEffortLevelsFromHelp(helpText);
  const permissionModes = parseClaudePermissionModesFromHelp(helpText);
  // Model menu sources, in priority order. The native control handshake
  // sends no user message and cannot start a model inference turn.
  //  1. `availableModels` from the Claude settings.json the configured CLI
  //     reads, plus `settings.model` when that value is not already listed.
  //  2. The gateway discovery cache from that same profile, when its
  //     baseUrl matches an enabled settings.env.ANTHROPIC_BASE_URL or an
  //     ANTHROPIC_BASE_URL assignment in the configured CLI wrapper.
  //     `settings.model` is still added when the cache does not contain it.
  //     An explicit discovery disable in settings rejects the cache.
  //  3. Claude's native initialize.models catalog (including variants and
  //     per-model effort levels), preserving the configured current model.
  //  4. `settings.model` alone if the native catalog is unavailable.
  //  5. The static alias menu (opus / sonnet / haiku + Default). Those
  //     aliases are unverified and may be unknown to the current CLI.
  // `probeCurrentModel` (gated off by default) only enriches the Default
  // entry's label with the resolved concrete name; it never changes which
  // models are offered.
  let settingsModels: string[] = [];
  let gatewayModels: ClaudeGatewayModel[] = [];
  let configuredModel: string | null = null;
  try {
    const settingsPath = resolveClaudeSettingsPath();
    const wrapperBaseUrl = readWrapperAnthropicBaseUrl();
    if (settingsPath) {
      const settings = readMergedClaudeSettings(dirname(settingsPath))
        ?? JSON.parse(readFileSync(settingsPath, 'utf8')) as unknown;
      settingsModels = parseAvailableModels(settings);
      configuredModel = parseSettingsModel(settings);
      if (settingsModels.length > 0) {
        debug(`[runtime] Model menu from ${settingsPath} availableModels (${settingsModels.length} entries)`);
      } else {
        gatewayModels = readGatewayModelsCache(settingsPath, settings, wrapperBaseUrl);
        if (gatewayModels.length > 0) {
          debug(`[runtime] Model menu from ${dirname(settingsPath)} gateway cache (${gatewayModels.length} entries)`);
        }
      }
    }
  } catch (err) {
    debug(`[runtime] Claude settings discovery failed, using static aliases: ${err}`);
  }
  const nativeModels = settingsModels.length === 0 && gatewayModels.length === 0
    ? await probeClaudeNativeModels(claudeExecutable(), options.signal ? { signal: options.signal } : {})
    : [];
  const nativeEfforts = (model: (typeof nativeModels)[number]): EffortLevel[] => (
    model.supportsEffort
      ? model.supportedEffortLevels.length > 0 ? model.supportedEffortLevels : supportedEfforts
      : []
  );
  const alias = (
    id: string,
    model: string,
    displayName: string,
    description: string,
    isDefault = false,
  ): ModelCapabilities => ({
    id, model, displayName, description,
    hidden: false, isDefault, defaultEffort: null, supportedEfforts,
  });
  // Empty model means "do not pass --model"; Claude Code picks the
  // configured default. Resolving the concrete name requires `claude -p`,
  // so it is only attempted behind GIAN_ALLOW_CLAUDE_PRINT_PROBE.
  const defaultEntry = alias(
    CLAUDE_DEFAULT_MODEL_ID,
    '',
    probedDefaultModel ? `Default · ${probedDefaultModel}` : 'Default',
    "Uses Claude Code's configured default model.",
    true,
  );
  const nativeDefault = nativeModels.find((model) => model.value === 'default');
  if (nativeDefault) {
    defaultEntry.displayName = nativeDefault.displayName;
    defaultEntry.description = nativeDefault.description;
    defaultEntry.supportedEfforts = nativeEfforts(nativeDefault);
  }
  type MenuEntry = {
    idPrefix: string;
    model: string;
    displayName: string;
    description: string;
    supportedEfforts?: EffortLevel[];
  };
  const configuredEntry = (model: string): MenuEntry => ({
    idPrefix: 'claude-settings',
    model,
    displayName: model,
    description: CURRENT_SETTINGS_MODEL_DESCRIPTION,
  });
  let menu: MenuEntry[] | null = null;
  if (settingsModels.length > 0) {
    menu = settingsModels.map((model) => ({
      idPrefix: 'claude-settings',
      model,
      displayName: model,
      description: 'From Claude settings availableModels.',
    }));
    if (configuredModel && !settingsModels.includes(configuredModel)) {
      menu.push(configuredEntry(configuredModel));
    }
  } else if (gatewayModels.length > 0) {
    menu = gatewayModels.map((model) => ({
      idPrefix: 'claude-gateway',
      model: model.id,
      displayName: model.displayName,
      description: 'From Claude gateway model discovery cache.',
    }));
    if (configuredModel && !gatewayModels.some((model) => model.id === configuredModel)) {
      menu.push(configuredEntry(configuredModel));
    }
  } else if (nativeModels.length > 0) {
    menu = nativeModels.filter((model) => model.value !== 'default').map((model) => ({
      // Keep the selected 0.3.3 configuration id when it is now native.
      idPrefix: model.value === configuredModel ? 'claude-settings'
        : BUILTIN_FALLBACK_ALIAS_MODELS.has(model.value) ? 'claude-alias' : 'claude-native',
      model: model.value,
      displayName: model.displayName,
      description: model.description,
      supportedEfforts: nativeEfforts(model),
    }));
    if (configuredModel && configuredModel !== 'default'
      && !nativeModels.some((model) => model.value === configuredModel)) {
      menu.push(configuredEntry(configuredModel));
    }
    debug(`[runtime] Model menu from Claude initialize (${nativeModels.length} entries)`);
  } else if (configuredModel) {
    menu = [configuredEntry(configuredModel)];
  }
  if (menu) {
    builtinFallbackActive = false;
    const usedIds = new Set<string>();
    models = [
      defaultEntry,
      ...menu.map((entry) => {
        const slug = slugifyModelId(entry.model);
        let id = `${entry.idPrefix}-${slug}`;
        for (let n = 2; usedIds.has(id); n++) id = `${entry.idPrefix}-${slug}-${n}`;
        usedIds.add(id);
        const model = alias(id, entry.model, entry.displayName, entry.description);
        if (entry.supportedEfforts) model.supportedEfforts = entry.supportedEfforts;
        return model;
      }),
    ];
  } else {
    builtinFallbackActive = true;
    models = [
      defaultEntry,
      alias('claude-alias-opus', 'opus', 'Opus', `Most capable for complex work. ${BUILTIN_FALLBACK_ALIAS_DESCRIPTION}`),
      alias('claude-alias-sonnet', 'sonnet', 'Sonnet', `Best for everyday tasks. ${BUILTIN_FALLBACK_ALIAS_DESCRIPTION}`),
      alias('claude-alias-haiku', 'haiku', 'Haiku', `Fastest for quick answers. ${BUILTIN_FALLBACK_ALIAS_DESCRIPTION}`),
    ];
  }
  debug(`[runtime] Discovered ${models.length} models: ${models.map((m) => m.model || '(default)').join(', ')}`);
  return { models, permissionModes, builtinFallbackActive };
}

const MODEL_USAGE_COUNTERS = [
  ['inputTokens', 'input_tokens'],
  ['outputTokens', 'output_tokens'],
  ['cacheReadInputTokens', 'cache_read_input_tokens'],
  ['cacheCreationInputTokens', 'cache_creation_input_tokens'],
] as const;

/** Per-model running token counters, keyed by the camelCase counter name. */
export type ClaudeModelUsageTotals = Record<string, Record<string, number>>;

function usageCounter(entry: Record<string, unknown>, camel: string, snake: string): number | null {
  return optionalNonNegativeInteger(entry[camel] ?? entry[snake]);
}

/** The running counters in a `result.modelUsage` (or saved `cost-state`)
 *  record. Malformed entries and counters are left out. */
export function claudeModelUsageTotals(modelUsage: unknown): ClaudeModelUsageTotals {
  const totals: ClaudeModelUsageTotals = {};
  if (!isRecord(modelUsage)) return totals;
  for (const [model, raw] of Object.entries(modelUsage)) {
    if (!isRecord(raw)) continue;
    const counters: Record<string, number> = {};
    for (const [camel, snake] of MODEL_USAGE_COUNTERS) {
      const value = usageCounter(raw, camel, snake);
      if (value !== null) counters[camel] = value;
    }
    totals[model] = counters;
  }
  return totals;
}

/** In streaming-input mode `result.modelUsage` is the session's running
 *  total, and a resumed session continues from the total its transcript
 *  saved. Gian reports conversation usage per turn, so this rewrites each
 *  counter as the change since `baseline`. Non-counter fields (e.g.
 *  `contextWindow`) pass through. A counter below its baseline means the
 *  total was reset (`/clear`), so that model's new total is the change.
 *  Invalid counters are left as-is for `parseClaudeResultUsage` to reject. */
export function subtractClaudeModelUsage(
  modelUsage: unknown,
  baseline: ClaudeModelUsageTotals,
): Record<string, unknown> | undefined {
  if (!isRecord(modelUsage)) return undefined;
  const delta: Record<string, unknown> = {};
  for (const [model, raw] of Object.entries(modelUsage)) {
    if (!isRecord(raw)) {
      delta[model] = raw;
      continue;
    }
    const before = baseline[model] ?? {};
    const reset = MODEL_USAGE_COUNTERS.some(([camel, snake]) => {
      const now = usageCounter(raw, camel, snake);
      return now !== null && now < (before[camel] ?? 0);
    });
    const entry: Record<string, unknown> = { ...raw };
    for (const [camel, snake] of MODEL_USAGE_COUNTERS) {
      for (const key of [camel, snake]) {
        const now = optionalNonNegativeInteger(raw[key]);
        if (now === null) continue;
        entry[key] = reset ? now : now - (before[camel] ?? 0);
      }
    }
    delta[model] = entry;
  }
  return delta;
}
