import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

/**
 * Codex's state root for this Proxy process.
 *
 * The Host sets GIAN_AGENT_HOME for every Agent, and the Proxy maps it onto
 * Codex's own CODEX_HOME. The Host's per-provider CODEX_HOME is only a
 * temporary bridge, so it never wins over GIAN_AGENT_HOME. Only without
 * GIAN_AGENT_HOME do an inherited CODEX_HOME or Codex's default
 * (`$HOME/.codex`) apply.
 */
export function resolveCodexHome(env: NodeJS.ProcessEnv = process.env): string {
  const agentHome = env.GIAN_AGENT_HOME;
  if (agentHome && isAbsolute(agentHome)) return agentHome;
  const configured = env.CODEX_HOME;
  if (configured && isAbsolute(configured)) return configured;
  const home = env.HOME && isAbsolute(env.HOME) ? env.HOME : homedir();
  return join(home, '.codex');
}

/**
 * Point every Codex child of this process at the Agent HOME. Codex refuses
 * to start when CODEX_HOME names a missing directory, so the Agent HOME is
 * created (owner-only) if needed. Returns the mapped home, or null when the
 * Host supplied no Agent HOME.
 */
export function applyAgentHome(env: NodeJS.ProcessEnv = process.env): string | null {
  const agentHome = env.GIAN_AGENT_HOME;
  if (!agentHome || !isAbsolute(agentHome)) return null;
  env.CODEX_HOME = agentHome;
  try {
    mkdirSync(agentHome, { recursive: true, mode: 0o700 });
  } catch {
    // Codex reports an unusable CODEX_HOME itself, with its own text.
  }
  return agentHome;
}
