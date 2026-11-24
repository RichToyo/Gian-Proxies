/**
 * gian.proxy request scheduling for the DSH Proxy (proxy-kit lanes).
 */

import type { WireRequest } from '@gian/proxy-kit';

/** Requests that answer a DSH blocked inside a session request (an approval,
 *  a running turn), so they never queue behind it. */
export const OVERTAKE_METHODS = new Set(['interaction.respond', 'turn.interrupt', 'shutdown']);
/** `initialize` runs alone: no other request starts before it settles. */
export const BARRIER_METHODS = new Set(['initialize']);
/** Process-level reads: concurrent with every session, hold nothing, never
 *  emit. A 20 s balance read or a customization scan blocks no one. */
export const PIPELINED_METHODS = new Set([
  'account.quota.read',
  'catalog.list',
  'catalog.resolve',
  'customization.list',
  'customization.detail',
  'runtime.discover',
  'runtime.probe',
  'session.native.list',
]);

/**
 * Session lane of a request: requests for one Gian session run in order,
 * different sessions run side by side. A fork or Side Chat runs in the lane
 * of the session it reads (source / parent); sidechat.close in its own.
 */
export function dshLaneKey(request: WireRequest): string {
  const params = request.params ?? {};
  for (const key of ['sessionId', 'sourceSessionId', 'parentSessionId', 'sidechatId'] as const) {
    if (request.method === 'session.fork' && key === 'sessionId') continue;
    if ((request.method === 'sidechat.create' || request.method === 'sidechat.resume') && key === 'sidechatId') continue;
    const value = params[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return '';
}
