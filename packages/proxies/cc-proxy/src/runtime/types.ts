import { EventEmitter } from 'node:events';

import type { TokenUsageUpdate } from '@gian/shared';
import type { EffortLevel, ModelCapabilities, PermissionMode } from '../core/types.js';

export interface ClaudeAgentTaskUpdate {
  taskId: string;
  toolUseId: string;
  description?: string;
  agentType?: string;
  status: 'running' | 'done' | 'error';
  summary?: string;
  outputFile?: string;
  startedAt?: number;
  completedAt?: number;
}

/**
 * Events emitted by the runtime:
 *
 *   'channelReply'         – the active turn completed; carries any final text
 *                            that was not already streamed
 *   'turnFailed'           – the active turn ended with an error while the
 *                            Claude Code process stays alive
 *   'permissionRequest'    – Claude Code needs user approval for a tool
 *                            (ExitPlanMode routes here too — host detects via toolName)
 *   'permissionCancelled'  – Claude Code withdrew a pending approval request
 *   'autoClassifierDenied' – auto-mode classifier blocked an action
 *   'autoCircuitBreaker'   – process aborted by auto-mode circuit breaker
 *   'processExited'        – the Claude Code process died during a turn
 *   'debug'                – Debug / log message
 */
export interface ClaudeRuntimeEvents {
  channelReply: [sessionId: string, text: string];
  turnFailed: [sessionId: string, errorDetail: string, streamedLength: number];
  permissionCancelled: [sessionId: string, requestId: string];
  /** Assistant text as it streams. Each emit APPENDS `text` to the block
   *  `itemId`, so the UI renders the agent's commentary interleaved with tool
   *  calls instead of one summary at the end. `itemId` is stable across all
   *  deltas of one logical block so the renderer can update in place. */
  assistantText: [sessionId: string, text: string, itemId: string];
  /** Thinking/reasoning as it streams, with the same append semantics.
   *  Emitted under the event.reasoning capability. */
  assistantReasoning: [sessionId: string, text: string, itemId: string];
  permissionRequest: [sessionId: string, requestId: string, toolName: string, description: string, inputPreview: string];
  autoClassifierDenied: [sessionId: string, action: string, reason: string, consecutive: number, total: number];
  autoCircuitBreaker: [sessionId: string, trigger: 'consecutive' | 'total', consecutive: number, total: number];
  toolUse: [
    sessionId: string,
    toolName: string,
    input: Record<string, unknown>,
    callId: string,
  ];
  toolResult: [
    sessionId: string,
    callId: string,
    output: unknown,
    isError: boolean,
  ];
  /** Claude's native task_started / task_notification lifecycle. */
  agentTask: [sessionId: string, update: ClaudeAgentTaskUpdate];
  /** Current context samples from assistant events plus the result event's
   *  per-turn conversation delta and authoritative context-window size. */
  tokenUsage: [sessionId: string, usage: TokenUsageUpdate];
  /** A stream-json event that is not one of the recognized Claude shapes.
   *  The adapter degrades these to a generic activity instead of silently
   *  dropping user-visible Provider output. */
  unknownClaudeEvent: [sessionId: string, event: Record<string, unknown>];
  processExited: [
    sessionId: string,
    code: number | null,
    signal: string | null,
    errorDetail?: string,
    /** Assistant text already emitted for this turn, in UTF-16 code units. */
    streamedLength?: number,
  ];
  /** The empty-model Default entry was labeled with the model from init. */
  defaultModelLabeled: [modelId: string];
  debug: [message: string];
}

export interface ClaudeRuntime extends EventEmitter<ClaudeRuntimeEvents> {
  readOfficialQuota?(params: import('@gian/proxy-protocol').OfficialQuotaReadParams): Promise<import('@gian/proxy-protocol').ProxyOfficialQuotaReadResult>;
  /** Initialize the runtime. Returns 0 (no server port). */
  start(): Promise<number>;

  /** Register a session. The Claude Code process starts with its first turn. */
  spawnSession(options: {
    sessionId: string;
    claudeSessionId: string;
    cwd: string;
    model?: string | null;
    isResume: boolean;
    mcpServers?: import('../core/types.js').ClaudeMcpServer[];
  }): Promise<void>;

  /** Update the provider-facing model used from the next turn on, without
   *  discarding the registered native session. */
  setSessionModel(sessionId: string, model: string | null): void;

  /** Start a turn with a user message. */
  sendMessage(sessionId: string, content: string, options?: {
    /** Native permission mode for this turn; null/undefined keeps Claude's
     *  default. */
    permissionMode?: PermissionMode | null;
    /** Effort for this turn, validated against Claude CLI discovery. */
    effort?: EffortLevel | null;
    /** Session display name (SESSION-NAME-001). Applied as `--name` only when
     *  the native session is created. */
    displayName?: string | null;
    /** Session-owned attachment directories that Claude may read this turn. */
    additionalDirectories?: string[];
  }): Promise<void>;

  /** Add a user message to the active turn. Claude folds it in at its next
   *  step, or runs it right after if the turn was already finishing. Optional
   *  so test doubles can omit it; then steering is not supported. */
  steer?(sessionId: string, content: string): Promise<void>;

  /** Rotate the underlying Claude session id (used by Gian's `/clear`
   *  intercept to start a fresh conversation without losing the Gian
   *  session). */
  resetClaudeSessionId(sessionId: string, newClaudeSessionId: string): void;

  /** Respond to a permission request (allow / deny).
   *
   *  `extra.updatedInput` replaces the tool input on an allow, so the agent
   *  runs the tool with the modified input.
   *
   *  `extra.answers` answers an AskUserQuestion on an allow: they are merged
   *  into the tool input as its `answers` field (question text → answer;
   *  multi-select answers are comma-separated), which is how Claude Code
   *  receives answers from an SDK host.
   *
   *  `extra.message` is the reason the model sees on a deny. */
  respondPermission(
    sessionId: string,
    requestId: string,
    behavior: 'allow' | 'deny',
    extra?: {
      updatedInput?: Record<string, unknown>;
      answers?: Record<string, string | string[]>;
      message?: string;
    },
  ): Promise<void>;

  /** Stop the Claude Code process and drop the registered session. */
  killSession(sessionId: string): void;

  /** Stop the active turn without dropping the registered session. The next
   *  sendMessage continues the same Claude session id. Optional so test
   *  doubles can keep using killSession as their only stop. */
  interruptActiveProcess?(sessionId: string): void;

  /** Check whether a session is registered with the runtime. */
  isSessionAlive(sessionId: string): boolean;

  /** Actual model id last reported by claude CLI's `system init` event for
   *  this session — may differ from the stored alias (e.g. `claude-opus-4-7`
   *  vs `claude-opus-4-7[1m]` when CLI auto-promotes). Returns null if no
   *  turn has run yet. */
  getDetectedModelId(sessionId: string): string | null;

  /** Shut down everything – kill all processes. */
  stop(): Promise<void>;

  /** Return discovered model choices (populated after start). For Claude this
   *  may be a billing-safe "default/no --model override" option rather than
   *  a concrete resolved model id. */
  getModels(): ModelCapabilities[];

  /** Native `--permission-mode` choices discovered from the configured
   *  Claude CLI help. Optional so lightweight Fake Runtimes can omit it. */
  getPermissionModes?(): string[];

  /** Resolve once the initial capability discovery finishes. Lets callers (like
   *  capabilities.list) avoid returning an empty models array when the
   *  proxy was just spawned. */
  awaitModelDiscovery(): Promise<void>;
}
