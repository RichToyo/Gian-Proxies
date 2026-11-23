import { createRuntimeInstallPlanner } from '@gian/proxy-protocol';

import { ANTIGRAVITY_RUNTIME_ID, POSIX_CLI_ENTRY } from './layout.js';

/**
 * Managed product archive at the tar root: the official Antigravity CLI,
 * repacked byte-for-byte as `agy` so the Proxy launches it as `agy acp` with
 * the user's own CLI sign-in. Entry names are a layout recipe, not a
 * same-version certificate. The caller supplies `artifactSha256`. The Host
 * content fingerprint and that managed artifact digest are the immutable byte
 * identity. The shared planner accepts only `raw` and `tar.gz`. URLs, sizes,
 * and digests are not invented here; the Dev source builder pins Google's
 * release archive and repacks it. A legacy `agy_acp_server.par` stays usable
 * as a user-selected Runtime but is no longer a managed layout.
 */
export const MANAGED_PRODUCT_ARCHIVE_ENTRIES = [POSIX_CLI_ENTRY] as const;

export const planRuntimeInstallation = createRuntimeInstallPlanner({
  runtimeId: ANTIGRAVITY_RUNTIME_ID,
  kind: 'managed',
  format: 'tar.gz',
  entryRelativePath: POSIX_CLI_ENTRY,
});
