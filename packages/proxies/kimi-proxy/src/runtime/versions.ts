/** Kimi Code releases whose server API this Proxy has reviewed.
 *
 * Only the 2.7 generation is spoken: 2.7 changed the session wire (`activity`
 * replaces `busy`, `cwd` moved out of metadata), turned session-work frames
 * into unwrapped global `session` events, renamed the `usage` feed to
 * `context`, and removed `/messages` and `/children`. 2.7.0 is excluded
 * because its turn-boundary fork mis-slices restored sessions that contain
 * in-turn steers (fixed in 2.7.1). Unknown versions, including later 2.7.x
 * patches, are refused rather than assumed compatible: Kimi has changed its
 * event protocol in a patch release before (2.6.2). */
export const SUPPORTED_KIMI_VERSIONS: readonly string[] = Object.freeze(['2.7.1', '2.7.2']);
export const MANAGED_KIMI_VERSION = '2.7.2';

export function parseKimiVersion(text: string): string | null {
  return text.match(/\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/)?.[0] ?? null;
}

export function unsupportedKimiVersionMessage(version: string): string {
  return `Kimi Code ${version} is not supported by this Proxy. Use Kimi Code `
    + `${SUPPORTED_KIMI_VERSIONS.join(' or ')} (the managed Runtime is ${MANAGED_KIMI_VERSION}); `
    + 'other versions speak a different local server protocol.';
}

export function assertSupportedKimiVersion(version: string): void {
  if (!SUPPORTED_KIMI_VERSIONS.includes(version)) throw new Error(unsupportedKimiVersionMessage(version));
}
