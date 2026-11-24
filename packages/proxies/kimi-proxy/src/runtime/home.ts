import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

/** Kimi Code's state root (`KIMI_CODE_HOME`, honoured by Kimi 2.7.x).
 *
 * The Host hands every Proxy the constrained Agent home as `GIAN_AGENT_HOME`;
 * the Proxy owns the translation into the provider variable. An absolute
 * `GIAN_AGENT_HOME` therefore wins over an inherited `KIMI_CODE_HOME` (the
 * Host's temporary bridge). Without either, Kimi's own default applies. */
export function resolveKimiCodeHome(env: NodeJS.ProcessEnv = process.env): string {
  const agentHome = env.GIAN_AGENT_HOME;
  if (typeof agentHome === 'string' && isAbsolute(agentHome)) return agentHome;
  const configured = env.KIMI_CODE_HOME;
  if (typeof configured === 'string' && isAbsolute(configured)) return configured;
  const home = typeof env.HOME === 'string' && isAbsolute(env.HOME) ? env.HOME : homedir();
  return join(home, '.kimi-code');
}

/** Bind the provider variable once at startup so every reader in this
 *  process (Runtime spawn, probe, customization scan, quota) sees one home. */
export function bindKimiCodeHome(env: NodeJS.ProcessEnv = process.env): void {
  const agentHome = env.GIAN_AGENT_HOME;
  if (typeof agentHome === 'string' && isAbsolute(agentHome)) env.KIMI_CODE_HOME = agentHome;
}

/** Environment for every `kimi` child: the resolved home and no self-update
 *  (2.7.2 accepts 1/true/yes/on for KIMI_CODE_NO_AUTO_UPDATE). */
export function kimiChildEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...env, KIMI_CODE_HOME: resolveKimiCodeHome(env), KIMI_CODE_NO_AUTO_UPDATE: '1' };
}
