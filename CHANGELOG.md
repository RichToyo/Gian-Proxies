# Gian Proxies Changelog

## Shared security repair candidates - 2026-10-25

- Shared dependency set: Proxy Protocol SDK 1.0.3 with zod exactly 4.6.6
  (wire protocol unchanged), body-parser 2.4.0 via the MCP SDK chain, and
  undici 8.12.2 via the DSH fetch/proxy chains. The managed DeepSeek Harness
  Runtime lock resolves a single zod 4.6.7 and undici 8.12.2.
- Claude Proxy 0.3.14 pins official Claude Code 2.1.310.
- Grok Proxy 0.3.14 pins official stable Grok CLI 1.0.70.
- Antigravity Proxy 0.0.4 pins upstream ACP Runtime 1.4.3.
- Codex Proxy 0.3.9 and Kimi Proxy 0.4.11 carry the new shared dependency set
  with unchanged verified Runtimes 0.164.0 and 2.3.1.
- DeepSeek Harness Proxy 0.3.8 ships the dependency-repaired managed Runtime
  (CLI still 0.2.1-rc.2); its bytes live under the new 0.3.8 tag, never
  overwriting 0.3.7.
- Six providers selected against signed RichToyo Catalog 38. ZCode is
  excluded pending its upstream lock review and keeps its exact 0.4.7/0.17.0
  tuple. Real Provider turns and target installation are not claimed.

## Runtime maintenance candidates - 2026-10-25

- Claude Proxy 0.3.14 pins official Claude Code 2.1.310 (GitHub latest
  v2.1.310 and npm latest; the vendor /stable pointer still reads 2.1.308 and
  is recorded as lagging). Changelog review found no documented headless
  spawn/wire compatibility changes; the nine selected startup flags were
  verified on the new binary.
- Grok Proxy 0.3.14 pins official stable Grok CLI 1.0.70 (x.ai/cli, official
  GCS mirror and npm latest agree; downloaded bytes are byte-identical across
  both sources). Spawn flags and the ACP initialize contract verified on the
  new binary (agentVersion 1.0.70, grokShell; session creation remains
  auth-gated). Per-version 1.0.68-1.0.70 notes remain NOT_OBSERVED in the
  accessible official changelog.
- Antigravity Proxy 0.0.4 pins upstream ACP Runtime 1.4.3, the current ACP
  registry version. The official dl.google.com ZIP passes the strict
  production pair validation; a bounded no-credential ACP initialize reports
  antigravity-acp 1.4.3 with a capability shape identical to 1.4.1 (raw
  old/new evidence retained).
- Only these three providers are selected against signed RichToyo Catalog 38.
  Real Provider turns and target installation are not claimed.

## Runtime maintenance candidates - 2026-10-24

- Claude Proxy 0.3.13 pins official Claude Code 2.1.309 (GitHub latest and npm
  latest; the vendor /stable pointer still reads 2.1.308 and is recorded as
  lagging, not as proof 2.1.309 is a prerelease).
- Kimi Proxy 0.4.10 pins Kimi Code 2.3.1; the only server-side change is the
  added optional session-takeover endpoint, which this Proxy does not use.
  Native session locks stay at their defaults.
- Codex Proxy 0.3.8 pins Codex CLI 0.164.0. Exact old/new app-server schema
  comparison: Proxy-used surfaces unchanged except imageGeneration output now
  allowing a durable fileId instead of a required inline result (plus optional
  inputImages); a new fixture regression projects both shapes. ServerRequest
  is byte-identical.
- Only these three providers are selected against signed RichToyo Catalog 36.
  Real Provider turns and target installation are not claimed.

## Runtime maintenance candidates - 2026-10-22

- Claude Proxy 0.3.12 pins official Claude Code 2.1.308.
- Kimi Proxy 0.4.9 pins Kimi Code 2.3.0, preserves native session-conflict errors, and reads the observed native server.token location without relying on startup banners.
- Grok Proxy 0.3.13 pins official Grok 1.0.67; npm platform bytes match the official standalone binary.
- Only these three providers are selected against signed RichToyo Catalog 35. Real Provider turns and target installation are not claimed.

## RichToyo Proxy generation - 2026-10-21

- Publish new English-only patches: Claude 0.3.11, Codex 0.3.7, Kimi 0.4.8,
  Grok 0.3.12, DeepSeek Harness 0.3.7, ZCode 0.4.7 and Antigravity 0.0.3.
  Existing releases remain immutable.
- Update Claude's MCP SDK to 1.32.0 and bound approval HTTP request bytes,
  JSON element counts and nesting before SDK validation.
- Remove the remaining first-party localized ZCode fork comment. Original
  upstream Runtime source and notices remain unchanged.
- Retain the declared Runtime versions and the gian.proxy wire contract.
  New signed Catalog generations use the existing signing identity.

## ZCode Proxy 0.4.6 - 2026-10-21

- Update the managed Runtime source to reviewed App-source 3.16.2 at
  `3c5b227`; its CLI version remains 0.17.0. Keep the immutable dependency
  lock and hash-bound standalone integration.
- Review temporary Bash output lifecycle/fallback, plugin-read concurrency,
  workflow quota handling and read-only workflow child sessions. No new
  Gian capabilities are advertised; the existing strict history-list fix stays.

## Claude Proxy 0.3.10 - 2026-10-21

- Target the current official Claude Code 2.1.304 Runtime, promoted to the
  /latest and /stable channels, npm latest and GitHub latest on
  2026-10-19; the darwin-arm64 checksum and size match the official 2.1.304
  manifest. No documented headless spawn/wire compatibility changes were
  found in the official 2.1.304 changelog; the nine selected startup flags
  the adapter spawns or parses were verified on the new binary.
  Authenticated wire/Provider turns are NOT_RUN.
- The gian.proxy wire contract is unchanged.

## ZCode Proxy 0.4.5 - 2026-10-20

- Pin reviewed App-source 3.16.1 / CLI 0.17.0 at immutable source `0a1fc56`.
- Preserve hash-bound standalone authentication and model-catalog integration.
- Review additive protocol fields and new SQLite migrations; isolated native
  migration contracts and synthetic old/new history/restore checks pass.
- Fix native history listing by omitting `includeArchived`, removed from the
  strict 0.17.0 schema; preserve a native source fixture and regression.
- Correct unsupported native-delete explanations for upstream soft deletion;
  Gian session.close continues to detach without deleting native history.
- No new optional capabilities or real Provider-turn claims.

## Claude Proxy 0.3.9 - 2026-10-20

- Target the current official Claude Code 2.1.303 Runtime, promoted to the
  /latest channel, npm latest and GitHub latest; the darwin-arm64 checksum
  and size match the official 2.1.303 manifest. Upstream 2.1.303 is a
  bug-fix/reliability entry with no wire-protocol or spawn-surface changes;
  the nine selected startup flags the adapter spawns or parses were
  re-verified on the new binary.
- The gian.proxy wire contract is unchanged.

## Antigravity Proxy 0.0.2 - 2026-10-20

- Target the upstream Antigravity ACP Runtime 1.4.1, the current version in
  the official ACP registry; the darwin-arm64 ZIP from dl.google.com passes
  the strict production pair validation (exact server+harness members,
  pinned SHA-256/size).
- A bounded no-credential ACP initialize on the new pair reports
  `agentInfo.name` antigravity-acp and version 1.4.1; the core
  session/prompt/MCP/auth capabilities are unchanged, while 1.4.1 newly
  advertises optional `_meta.antigravity` metadata (`tier`,
  `systemPrompt.append`) that is not adopted or verified as a Gian
  capability. Deeper surface facts remain 1.3.0-researched and are labeled
  as such. The gian.proxy wire contract is unchanged.

## DeepSeek Harness Proxy 0.3.6 - 2026-10-20

- Target `@deepseek-ai/dsh` 0.2.1-rc.2, now the npm `latest` dist-tag
  (published 2026-10-17); the `next` channel coincides and `alpha` stays
  separate. The bundled Bridge moves to 0.1.7: npm semver treats prerelease
  tuples strictly (`^0.2.0-rc.2` does NOT satisfy 0.2.1-rc.2), so the Bridge
  peer range now explicitly admits both RC lines (`^0.2.0-rc.2 ||
  0.2.1-rc.2`), covered by a real-semver regression test.
- Exact npm package-payload comparison of the bridge-used surfaces:
  `SESSION_FORMAT_VERSION` stays 4 (no data migration),
  KNOWN_SESSION_EVENT_TYPES only gains `job/registered`, `job/settled` and
  `working-directory/change` (unknown durable events already project through
  the generic activity path), and cordis moves patch-only. Un-reverified
  behavior comments keep their historical 0.2.0-rc.2 citations.
- The gian.proxy wire contract is unchanged.

## Claude Proxy 0.3.8 - 2026-10-18

- Target the current official Claude Code 2.1.302 Runtime, promoted to the
  /latest channel, npm latest and GitHub latest on 2026-10-16; the
  darwin-arm64 checksum and size match the official 2.1.302 manifest.
- Review the upstream 2.1.302 changelog: no wire-protocol or spawn-surface
  changes affect the adapter; the flag surface was re-verified on the new
  binary. The gian.proxy wire contract is unchanged.

## Grok Proxy 0.3.11 - 2026-10-18

- Target the managed Grok CLI 1.0.62 Runtime, promoted to stable on x.ai/cli,
  the official GCS mirror and npm `@xai-official/grok` latest; bytes from
  x.ai and GCS are identical.
- Verify the spawn surface and the ACP initialize contract on the new binary
  (`agentVersion` 1.0.62, `grokShell`, unchanged capability shape; raw
  handshake evidence preserved). Per-version upstream notes for
  1.0.53–1.0.62 are NOT_OBSERVED in the accessible official changelog, whose
  latest entry remains 1.0.52 — recorded honestly instead of blocking the
  promoted stable channel.
- Known limitation unchanged: native approval cards under
  auto/always_approve snapshots remain unverified — the permission wire path
  requires an authenticated session, which this release does not exercise.
- The gian.proxy wire contract is unchanged.

## Claude Proxy 0.3.7 - 2026-10-17

- Target the current official Claude Code 2.1.301 Runtime, promoted to the
  /latest channel, npm latest and GitHub latest on 2026-10-15; the
  darwin-arm64 checksum and size match the official 2.1.301 manifest.
- Review the upstream 2.1.301 changelog: no wire-protocol or spawn-surface
  changes affect the adapter; the flag surface was re-verified on the new
  binary. The gian.proxy wire contract is unchanged.

## Codex Proxy 0.3.6 - 2026-10-17

- Target the managed Codex CLI 0.163.0 Runtime (first stable of the 0.163
  line, published 2026-10-15), up from 0.162.1; the archive SHA-256 matches
  the official `rust-v0.163.0` GitHub asset metadata.
- Protocol review against exact old/new app-server schema files: every
  Proxy-used surface is additive-only (optional `excludedThreadIds`,
  `retain`, read-state notifications, response-item fields); ServerRequest
  is byte-identical and no method the Proxy calls was removed or changed
  (unrelated realtime voice enums also changed; the Proxy does not use
  them). Live no-credential `initialize` handshakes succeed identically on
  0.162.1 and 0.163.0.
- The gian.proxy wire contract is unchanged.

## Grok Proxy 0.3.10 - 2026-10-17

- Target the managed Grok CLI 1.0.60 Runtime, promoted to stable on x.ai/cli,
  the official GCS mirror and npm `@xai-official/grok` latest; bytes from
  x.ai and GCS are identical.
- Verify the spawn surface and the ACP initialize contract on the new binary
  (`agentVersion` 1.0.60, `grokShell`, unchanged capability shape);
  version-specific upstream notes for 1.0.53–1.0.60 are NOT_OBSERVED in the
  accessible official changelog, which currently shows 1.0.52 as its latest
  entry — recorded honestly instead of blocking the promoted stable channel.
- Known limitation unchanged: native approval cards under
  auto/always_approve snapshots remain unverified — the permission wire path
  requires an authenticated session, which this release does not exercise.
- The gian.proxy wire contract is unchanged.

## Claude Proxy 0.3.6 - 2026-10-15

- Target the current official Claude Code 2.1.300 Runtime, up from 2.1.296;
  the darwin-arm64 checksum and size match the official 2.1.300 manifest.
- Review the upstream 2.1.297–2.1.300 changelog: no wire-protocol or
  spawn-surface changes affect the adapter; `--effort`, `--permission-mode`,
  `--output-format stream-json`, `--session-id`/`--resume` and
  `--no-session-persistence` are all present on the new binary.
- The gian.proxy wire contract is unchanged. The previous 2.1.296 Runtime
  and all existing published artifacts remain immutable.

## Codex Proxy 0.3.5 - 2026-10-15

- Target the managed Codex CLI 0.162.1 Runtime, up from the 0.161.0 pin
  published with Codex Proxy 0.3.4; the archive SHA-256 matches the official
  `rust-v0.162.1` GitHub asset metadata.
- Upstream 0.162.0/0.162.1 changes are additive for the app-server surface
  the Proxy bridges; the adapter and the gian.proxy wire contract are
  unchanged.

## Kimi Proxy 0.4.7 - 2026-10-15

- Target the Kimi Code CLI 2.2.0 Runtime, up from the 2.1.1 pin published
  with Kimi Proxy 0.4.6; the archive SHA-256 matches the official
  `@moonshot-ai/kimi-code@2.2.0` GitHub asset metadata.
- The published server-api reference diff from 2.1.1 to 2.2.0 is purely
  additive (new Remote Control endpoints, optional request fields), and a
  live 2.2.0 `/openapi.json` + `/asyncapi.json` probe confirmed every REST
  route and WebSocket message type this Proxy uses. The adapter and the
  gian.proxy wire contract are unchanged.

## Grok Proxy 0.3.9 - 2026-10-15

- Target the managed Grok CLI 1.0.52 Runtime, up from the 1.0.46 pin
  published with Grok Proxy 0.3.8; the bytes are identical from `x.ai/cli`
  and the official GCS mirror.
- Verify the spawn surface on the new binary (`agent stdio`, `--no-leader`,
  `--deny`, `--disallowed-tools`, `GROK_SANDBOX`) and the ACP initialize
  contract (`grokShell`, model/reasoning catalog); extension methods stay
  lazily confirmed per attach.
- Known limitation: native approval cards observed for compound shell
  commands under 1.0.46 despite `auto`/`always_approve` snapshots remain
  unverified on 1.0.52 — the permission wire path requires an authenticated
  session, which this release does not exercise. No behavior fix is claimed.
- The gian.proxy wire contract is unchanged.

## Claude Proxy 0.3.5 - 2026-10-12

- Resolve model defaults before checking conditional effort support, so an
  effort-only creation draft can use the configured default model.
- Omit disabled effort defaults and retain the resolved model-specific
  catalog for validation of the first turn.
- Target the current official Claude Code 2.1.296 Runtime. The previous
  2.1.285 Runtime and all existing published artifacts remain immutable.
- Owner-selected direct publication; all tests, Runtime probes and archive
  self-tests are NOT_RUN.

## Claude Proxy 0.3.4 - 2026-10-11

- Read Claude Code's native model catalog through a metadata-only initialize
  handshake, including native variants and each model's effort levels.
- A configured default such as `opus` no longer hides the rest of `/model`.
  Preserve existing model configuration ids and explicit gateway menus.
- Bound the discovery process and clean it up on timeout or Proxy shutdown;
  discovery disables hooks, MCP, tools and transcript persistence and sends
  no user message.
- Owner-selected direct publication. Tests, Runtime probes and archive
  self-tests were not run. Retain the existing Claude Code 2.1.285 Runtime.

## Claude Proxy 0.3.3 - 2026-10-11

- Target the managed Claude Code 2.1.285 Runtime, up from the 2.1.280 pin
  published with Claude Proxy 0.3.2.
- Keep the Claude session across an interrupt and resume it on the next turn
  with the current model and effort; resume waits for the CLI session init
  instead of passing an id Claude never created.
- A CLI exit during an active turn fails the turn with the exit code, signal
  and streamed length; unexpected exits are retryable, while provider errors
  such as authentication failure stay not retryable.
- Discover the model catalog from the wrapper's own HOME and settings; the
  gian.proxy wire contract is unchanged.

## Codex Proxy 0.3.4 - 2026-10-11

- Target the managed Codex CLI 0.161.0 Runtime, up from the 0.159.2 pin
  published with Codex Proxy 0.3.3.
- Page long native histories through disk with pinned Fork ancestry, stable
  event identity, immutable cursors and bounded incremental reads; replay
  failures stay isolated to their attachment generation.
- Report the actual Proxy package version to the Runtime instead of a stale
  hardcoded value. The gian.proxy wire contract is unchanged.

## Kimi Proxy 0.4.6 - 2026-10-11

- Preserve turns across Runtime disconnects: notification counters reset on a
  new stream binding, event delivery resumes from durable cursors, and only a
  child process exit is treated as runtime-down.
- Declare the native cancel action on confirmation prompts, keeping valueless
  cancellation explicit for input gating. Keep the Kimi Code 2.1.1 Runtime pin
  and gian.proxy wire versions unchanged.

## Grok Proxy 0.3.8 - 2026-10-11

- Target the managed Grok CLI 1.0.46 Runtime, up from the 1.0.41 pin published
  with Grok Proxy 0.3.7.
- Catalog inspection no longer delays shutdown: successful model metadata
  inspections are reused, failed cleanup and empty snapshots are retried, and
  only inspection children are force-stopped — live sessions keep their
  graceful shutdown.
- Declare native cancellation action IDs so valueless cancellation stays
  explicit in the Host/Web input gating. The gian.proxy wire contract is
  unchanged.

## DeepSeek Harness Proxy 0.3.5 - 2026-10-11

- Target the DeepSeek Harness 0.2.0-rc.2 Runtime with Bridge 0.1.6, reading
  session logs as format 4; the published 0.3.3 pinned Runtime 0.1.5-rc.3
  (0.3.4 was prepared but never published).
- Add Side Chat with idle-only anchors, a sealed resume reference persisted
  across Proxy restarts, and a close barrier that terminalizes the active
  turn; native session.fork with a verified seed prefix and structured
  attachment/skill input.
- Replace a saved model the Runtime no longer advertises with the advertised
  default before turn.start, and carry a reselect notice on the turn. The
  gian.proxy wire contract is unchanged.

## Kimi Proxy 0.4.5 - 2026-10-07

- Materialize native cold Side Chat children before subscribing and reject
  failed subscription acknowledgements. Keep child events and terminal state
  bound to the actual child turn.
- Forward Stop to the native Runtime and settle interrupted turns without
  requiring Host fencing; preserve follow-up turns and interaction cancellation.
- Keep the Kimi Code 2.1.1 Runtime pin and gian.proxy wire versions unchanged.

## Catalog 1.19.0 - 2026-09-30

- Select the published Kimi Proxy 0.4.4 release and its unchanged Kimi Code 2.1.1 Runtime.
- Retain every other signed Proxy coordinate from Catalog 1.18.0, including Codex Proxy 0.3.3 / Codex CLI 0.159.2. No App release.

## Catalog 1.18.0 - 2026-09-30

- Select the published Codex Proxy 0.3.3 and its Codex CLI 0.159.2 Runtime.
- Retain every other signed Proxy coordinate from Catalog 1.17.0. No App release.

## Codex Proxy 0.3.3 - 2026-09-30

- Target the managed Codex CLI 0.159.2 Runtime with the existing app-server adapter.
- Retain the gian.proxy wire contract and the previously published Codex Proxy and Runtime for rollback.

## Kimi Proxy 0.4.4 - 2026-09-30

- Show assistant prose as its own text stream on each step. Thinking stays reasoning, also split per step, and tool results keep command, file, and search presentation.
- Enable fork and side chat after a completed turn while the session is idle. Forking from a specific turn stays unavailable.
- Accept volatile frames that reuse the current sequence, and include the turn prompt id on usage events.
- This release does not change the Proxy wire protocol or the Kimi Code 2.1.1 Runtime pin.

## Grok Proxy 0.3.7 - 2026-10-07

- Bind model and reasoning effort to the turn. Permission mode stays session-bound.
- Require `workspace.roots` to include the session directory. The Host may also list the session attachment directory; that path is not added to the sandbox.
- Hold turn events that arrive before `turn.started`, and drop usage deltas after the turn ends.
- Normalize native interaction IDs across tool metadata and interaction events;
  retain first-turn ordering and configuration validation during model changes.
- Refresh the Grok Build logos and show the default permission mode as Default.
- This release does not change the Proxy wire protocol or the Grok CLI 1.0.41 Runtime pin.

## Catalog 1.17.0 - 2026-09-28

- Select the published Kimi Proxy 0.4.3 release and its Kimi Code 2.1.1 Runtime.
- Retain every other signed Proxy coordinate from Catalog 1.16.0. No App release.

## Kimi Proxy 0.4.3 - 2026-09-28

- Keep previously returned Catalog revisions valid while the underlying Kimi
  model catalog is unchanged, so switching models can refresh the available
  reasoning efforts without an erroneous revision rejection.
- Require a new `catalog.list` when the underlying model catalog changes.
  This release does not change the Proxy wire protocol or the Kimi 2.1.1 Runtime pin.

## Published Catalog history restored - 2026-09-28

- Restore the Catalog source that shipped without being merged to main. Grok
  0.3.6 is an official Catalog plugin, and the authored histories match Catalog
  1.16: Claude 0.3.2, Codex 0.3.2, Kimi 0.4.2, DeepSeek 0.3.3, ZCode 0.4.2, and
  Grok 0.3.6.
- DeepSeek Proxy 0.3.4 and ZCode Proxy 0.4.3 on main already match those
  published local builds. Source may stay ahead of the last signed snapshot.
- ZCode qualification uses a short macOS temporary directory so the Runtime
  socket fits `sun_path`, and keeps a redacted stderr tail when the catalog
  probe exits early.

## Catalog 1.10.0 - 2026-09-24

- Select the certified Claude 0.3.2, Codex 0.3.2, Kimi 0.3.3 and DeepSeek 0.3.2
  releases with their verified Runtime combinations; DeepSeek includes Bridge 0.1.4.
- Refresh Chinese and English version histories from the actual published assets.
- Retain ZCode 0.3.2 and its complete executable/certificate coordinates unchanged.
  Grok remains excluded. Existing Proxy archives are not rebuilt.

## 2026-09-24 - CLI compatibility update

- Claude Proxy 0.3.2 targets Claude Code 2.1.280 and preserves inherited Fork
  turn identities and idempotent Side Chat resume.
- Codex Proxy 0.3.2 targets Codex CLI 0.156.1, reads modern/lazy Fork history
  from the selected CODEX_HOME, and cleans up Runtime descendants on shutdown.
  Text translation uses fresh isolated threads; closing those threads no longer
  attempts to read their unsupported ephemeral history.
- Kimi Proxy 0.3.3 targets Kimi Code 2.1.0, fixes model-dependent thinking and
  replay identities, and does not consume a history ordinal for rejected turns.
  Native rename is no longer falsely advertised; Gian-local naming is unchanged.
- DeepSeek Proxy 0.3.2 bundles Bridge 0.1.4 and targets DSH 0.1.5-rc.3,
  forwarding transient stream chunks and accepting repeated Session close.
- Use public Proxy Protocol 1.0.1. Model-resolved Host validation requires the
  updated Host implementation; no App release or wire-version change is implied.
- Retain ZCode's existing signed combination unchanged; Grok remains excluded.

## Catalog 1.9.0 - 2026-09-23

- Add Chinese and English descriptions, nine-chapter tutorials and version
  histories for all five shipping Proxies. Compatible Gian clients follow
  their selected UI language; older clients retain the original documents.
- Bind localized metadata and documents to the signed asset manifest without
  changing the strict Catalog v1 index.
- Retain every Proxy, Runtime and certification coordinate from Catalog 1.8.0.
  No executable rebuild, Proxy version bump or App package is included.

## Catalog 1.8.0 - 2026-09-21

- Publish complete nine-chapter tutorials for the five shipping Integrations.
- Publish per-Proxy version histories with immutable release evidence and explicit
  gaps where historical feature notes cannot be recovered.
- Preserve Catalog v1 compatibility: tutorials occupy setup/usage/troubleshooting;
  overview carries the version history. The dedicated App history view remains
  a separate consumer change. Basic state examples are not installed-state data.
- Proxy versions, Runtime combinations, signing identity and executable archives
  are unchanged. No Proxy re-release or App upgrade is included.

## 2026-09-20 - Independent Delivery

Versions follow the individual Proxy packages on GianDev main:

| Proxy | Version |
| --- | --- |
| Claude | 0.3.1 |
| Codex | 0.3.1 |
| DSH | 0.3.1 |
| Kimi | 0.3.2 |
| ZCode | 0.3.2 |

The unified 0.4.0 releases and tags were withdrawn and replaced by the individual
versions above. Repository separation does not assign a shared Proxy version.

- Publish official Proxy packages and their signed Catalog from Gian-Proxies.
- Consume the immutable public Gian Proxy Protocol 1.0.0 package.
- Include DSH Bridge in the DSH Proxy archive, independent of the App bundle.
- Preserve per-Proxy versions, immutable release artifacts and signed Catalog
  anti-rollback sequencing. Existing App installations are not modified.
- ZCode keeps its standalone-startup diagnostics and remains subject to the
  upstream external-App limitations; this release does not restore missing models.
