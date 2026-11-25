# Gian Proxies Changelog

## Kimi Proxy 0.5.1 candidate - 2026-11-25

Fixes for conversations that stopped continuing or lost replies with 0.5.0, found by a real Kimi Code 2.7.2 smoke regression (questions, approvals, interrupts, steers, background work, Proxy restarts and Host recovery).

- A Kimi server left behind by a Proxy that was killed (crash, force quit, an update that stopped the Proxy hard) kept every session lock, so each later turn failed with `SESSION_BUSY` ("This session is in use by another Kimi Code Web instance"). A watchdog now stops the server when its Proxy is gone, and a starting Proxy, or a turn refused with that lock, stops such leftovers (a `kimi-code` "Kimi Code Web" lock holder adopted by launchd on this Mac) and continues.
- When the Host recovers a stuck turn it re-attaches the session; 0.5.0 refused with "The native session is busy; refusing to rebind" while that turn still waited on a question or approval or still ran, and the conversation could not continue. The abandoned turn is now stopped natively and the session re-attaches.
- A steer that Kimi runs as the next native turn (it ends the running turn at its next step) now stays in the same Gian turn; 0.5.0 completed the turn first and dropped the steered reply. Interrupting such a turn also aborts its steer.
- An unsupported Kimi Code version reports `RUNTIME_UNAVAILABLE` with how to fix it, instead of `INTERNAL`.
- Runtime unchanged: Kimi Code 2.7.2.
- Exact-artifact hosted qualification and publication remain required.

## Claude Proxy 0.4.3 candidate - 2026-11-24

- Keep the Claude Code process while a Bash command or subagent started in the background, or a run Claude starts on its own when one finishes, is in progress. The 10-minute idle stop used to kill them. The runtime now follows Claude's `background_tasks_changed` list and its in-progress runs, and starts the idle clock only when nothing runs. Runs Claude starts on its own reach Gian through native history replay.
- Runtime unchanged: Claude Code 2.1.330.
- Exact-artifact hosted qualification and publication remain required.

## Codex Proxy 0.4.1 candidate - 2026-11-24

- Upgrade the managed Codex Runtime from 0.169.1 to official 0.171.0 (`rust-v0.171.0` archive `58c88032…`, 176190739 bytes).
- Serve sessions on per-session lanes of the shared proxy-kit: a slow session no longer stalls turns, steering or approvals in other sessions.
- A timed-out app-server request fails only that request instead of restarting the shared app-server. `turn.interrupt` is bounded by a watchdog, and Host stops end as `interrupted`.
- Keep Codex's own error text. Sign-in failures and HTTP 401 report `RUNTIME_AUTH_REQUIRED`, and unknown server requests are refused.
- Map `GIAN_AGENT_HOME` onto `CODEX_HOME` in the Proxy, log the cause of quota failures, and cache rollout paths instead of rescanning history.
- 0.4.0 is withdrawn and is skipped.
- Exact-artifact hosted qualification and publication remain required.

## Kimi Proxy 0.5.0 candidate - 2026-11-24

- Port to Kimi Code 2.7 and upgrade the managed Runtime from 2.6.3 to 2.7.2 (`46cb6bf4…`, 61167615 bytes). The Proxy drives `kimi web --json --port 0`, the 2.7 session API and its `context` usage frame, and forks through `:fork` (Side Chat and turn forks). Only Kimi Code 2.7.1 and 2.7.2 are accepted; the legacy and 2.6 runtimes are removed.
- Serve sessions on per-session lanes of the shared proxy-kit. A prompt queued behind a background or foreign native turn binds to its own turn.
- Keep Kimi's own error text; `auth.*` and provider authentication errors report `RUNTIME_AUTH_REQUIRED`.
- Report usage as one delta per Gian turn. Gian 0.6.16 or later records it; earlier Gian versions drop Kimi delta usage.
- Map `GIAN_AGENT_HOME` onto `KIMI_CODE_HOME` in the Proxy; automatic updates stay off.
- Exact-artifact hosted qualification and publication remain required.

## DeepSeek Harness Proxy 0.4.1 candidate - 2026-11-24

- Upgrade the managed Runtime from 0.2.2-rc.3 to 0.2.2-rc.5 and bundle Bridge 0.1.12 with Agent presets synced to rc.5.
- Launch DSH with telemetry and the DeepSeek Session-log upload disabled, in the Agent Home (`DSH_HOME`).
- Serve sessions on per-session lanes in the Proxy and the Bridge. The Bridge fences execution that arrives after its request deadline and exits on EOF. Shutdown, signals and crashes stop the DSH process group, and a failed start reports DSH's exit status and a bounded stderr tail.
- Keep DSH's own failure text; credential errors report `RUNTIME_AUTH_REQUIRED`.
- Count cached prompt tokens as input, report context occupancy, derive the catalog revision from its content and announce only real catalog changes.
- 0.4.0 is withdrawn and is skipped.
- Exact-artifact hosted qualification and publication remain required.

## Grok Proxy 0.4.0 candidate - 2026-11-24

- Upgrade the managed Grok CLI from 1.0.89 to 1.0.92 (`8b5f67b2…`, 190640272 bytes; xAI publishes no digest, so the bytes are matched independently).
- Serve gian.proxy/2 through the shared proxy-kit.
- Keep Grok's own error text with a bounded stderr tail, and decide sign-in by the ACP authentication error code.
- After a crash, a forced interrupt or an idle stop, resume the native session in a new child. Interrupts are bounded by a 10-second watchdog. An idle child stops after 10 minutes (`GIAN_GROK_IDLE_TIMEOUT_MS`), but never while a background task or a turn Grok runs on its own is in progress.
- Change model and effort through `session/set_config_option`; take turn usage from `PromptResponse.usage` and context only from `usage_update`; discover binaries under the machine HOME.
- With Gian 0.6.16 or later, `grok login` in the Agent terminal signs in the Agent HOME.
- Exact-artifact hosted qualification and publication remain required.

## ZCode Proxy 0.5.0 candidate - 2026-11-24

- Upgrade the Gian-built Runtime from App-source 3.16.2 (`3c5b227`, CLI 0.17.0) to v3.18.2 (`fec9759`, CLI 0.17.1). ZCode 3.18 encrypts `credentials.json` with a Keychain key; the Proxy stages the keyring binding and answers `interaction/requestCredentialCipher` as the upstream Host does.
- End failed turns (3.18 `turn.failed`) with ZCode's own text instead of leaving the session busy; sign-in, API-key and Keychain failures report `RUNTIME_AUTH_REQUIRED`.
- Report per-call context occupancy and one usage delta per turn; scope provider failures to their turn; bound interrupts with a watchdog; inherit the environment (including `PATH` and proxy variables) minus Gian internals.
- Serve sessions through the shared proxy-kit. An idle app-server stops after 10 minutes and restarts transparently, but never while a background task runs.
- Exact-artifact hosted qualification and publication remain required.

## Antigravity Proxy 0.1.1 candidate - 2026-11-24

- Upgrade the managed Runtime from agy 1.5.14 to the official Antigravity CLI 1.5.16 (Google release manifest; archive SHA-512 `33f5617d…`, 86506312 bytes; binary signed by Google LLC), repacked byte-for-byte as `agy` (asset `42490dbd…`, 86463263 bytes, deterministic).
- Upstream `agy acp` fixes (1.5.15): a turn now stays open until the non-daemon background tasks and subagents it started finish, and reports their combined usage; in-progress tool calls are closed on cancel; `session/load` finishes history replay before answering; an unknown session id answers `-32002` instead of `-32603`.
- No Proxy code change. `AGY_CLI_DISABLE_AUTO_UPDATE=true` is still honoured by 1.5.16, and sessions, the model list and quota keep reusing the user's own agy sign-in.
- Exact-artifact hosted qualification and publication remain required.

## Claude Proxy 0.4.2 candidate - 2026-11-23

- Upgrade the managed Claude Code Runtime from 2.1.327 to official 2.1.330 (`f7c5093b…`, 363855808 bytes, from Anthropic's release manifest). Upstream fixes include a multi-minute freeze after compacting a very long conversation, `--resume` failing when the last saved message has an invalid timestamp, lower memory use in long SDK sessions, and background agents left waiting after an interrupt.
- No Proxy code change: the streaming-input mode, native control requests and `turn.steer` from 0.4.1 are unchanged.
- Exact-artifact hosted qualification and publication remain required.

## Antigravity Proxy 0.1.0 candidate - 2026-11-22

- Run sessions through the ACP server built into the agy CLI (`agy acp`, 1.5.9 or later) instead of the standalone `agy_acp_server.par`. Sessions, the model list and quota now use the user's own agy sign-in; one `agy` login in Terminal is enough. A signed-out CLI reports `RUNTIME_AUTH_REQUIRED` with sign-in instructions for sessions and the model list.
- The agy CLI has no Gemini home override and always reads the account's `~/.gemini` and Keychain sign-in. For an agy Runtime the Proxy no longer maps the Host Agent HOME onto `GEMINI_HOME`, reports `~/.gemini` as the probe's config home, and keeps only the `HOME` check for the model list and quota. A Gian-managed Agent HOME therefore no longer breaks the model list.
- Set `AGY_CLI_DISABLE_AUTO_UPDATE=true` on every agy Gian launches, so the CLI never replaces its own binary under a running Proxy. A user's terminal `agy` keeps updating.
- Replace the managed ACP registry pair (1.5.0) with the official Antigravity CLI 1.5.14 from Google's release manifest, pinned by SHA-256 and SHA-512 and repacked byte-for-byte as `agy`. Verified Runtime versions are now `1.5.14`. A user-selected legacy `.par` server keeps the paired-harness contract.
- Adopt `@gian/proxy-kit` for the gian.proxy/2 wire server.
- Exact-artifact hosted qualification and publication remain required.

## Claude Proxy 0.4.1 candidate - 2026-11-21

0.4.0 is a withdrawn Claude Proxy version (the unified 0.4.0 bump of 2026-09-20) and is never reused. It was published in error on 2026-11-20 and never entered a signed Catalog; 0.4.1 is the same code.

- Keep the official Claude Code 2.1.327 Runtime from 0.3.26, with exact artifact qualification required.
- Run each session in one long-lived Claude Code process in streaming-input mode (the Agent SDK protocol) instead of a new `claude -p` process per turn. Prompts no longer travel in argv; text streams as it is generated.
- Approvals, plan review and AskUserQuestion come back as `can_use_tool` control requests. The approval MCP server, its per-turn config file and the deny-with-message answer workaround are removed, and with them the `@modelcontextprotocol/sdk` and `zod` dependencies.
- Interrupt stops the turn and keeps the process; queued steer input is cancelled with it. An interrupt Claude does not confirm within 10 s stops the process, and the next turn resumes the session.
- Advertise `turn.steer`: input sent during a turn joins it.
- Model, permission mode and effort change in the running process. Bypass, new attachment folders and a return to default effort restart it with `--resume`.
- Idle processes stop after 10 minutes (`GIAN_CLAUDE_IDLE_TIMEOUT_MS`) and the next turn resumes the session.
- Fix conversation token usage: Claude reports a running total, which 0.3.x passed on as each turn's usage, so resumed turns were counted again. Usage is now the change since the previous total, measured from the transcript's saved total after a resume.
- A Claude that fails while starting fails the turn with its own error text.
- Adopt `@gian/proxy-kit` for the gian.proxy/2 wire server.

## Grok Proxy 0.3.17 candidate - 2026-11-19

- Target official Grok CLI 1.0.89 with exact hosted artifact qualification required.

## Kimi Proxy 0.4.17 candidate - 2026-11-19

- Target the official Kimi Code 2.6.3 Runtime while retaining reviewed legacy and conversation protocol selection.
- Exact-artifact hosted qualification and publication remain required.

## Claude Proxy 0.3.26 candidate - 2026-11-18

- Target the official Claude Code 2.1.327 Runtime with exact artifact qualification required.

## Antigravity Proxy 0.0.9 - 2026-11-17

- Fix ACP 1.5.0 Thinking selection by exposing a consistent `thinking` option and preserving native setter IDs.
- Retain the published ACP 1.5.0 Runtime and its native approval modes.
- Owner-authorized direct publication: all tests, Runtime probes and archive self-tests are NOT_RUN.

## Kimi Proxy 0.4.16 candidate - 2026-11-17

- Target the official Kimi Code 2.6.2 Runtime with a reviewed native conversation, interaction and replay migration.
- Preserve owned background work and reconnect without automatically resending prompts or answering permissions.
- Exact-artifact hosted qualification and immutable publication remain required.

## Codex Proxy 0.3.14 - 2026-11-16

- Upgrade the managed Codex Runtime to 0.169.0 and cancel human-only or unknown approval kinds until human origin can be verified.
- Select Codex against signed Catalog 63 for exact-artifact hosted qualification.

## Claude Proxy 0.3.25 - 2026-11-15

- Upgrade the managed Claude Runtime to 2.1.325 with upstream security and session fixes.
- Preserve upstream sandbox permission defaults and qualify against signed Catalog 62.

## DSH Proxy 0.3.13 - 2026-11-14

- Upgrade the managed DeepSeek Runtime to 0.2.2-rc.3 with exact dependency and native API checks.
- Select DSH against signed Catalog 60 for exact-artifact hosted qualification.

## Antigravity Proxy 0.0.8 - 2026-11-14

- Upgrade the managed ACP Runtime to official registry 1.5.0 with the validated paired archive.
- Select Antigravity against signed Catalog 60 for exact-artifact hosted qualification.

## Claude Proxy 0.3.24 - 2026-11-14

- Upgrade the managed Claude Runtime to 2.1.323, including upstream permission and sandbox fixes.
- Select Claude against signed Catalog 59 for exact-artifact hosted qualification.

## DSH Proxy 0.3.12 - 2026-11-13

- Upgrade the managed DeepSeek Runtime to 0.2.2-rc.2 and preserve native subagent attribution.
- Select DSH against signed Catalog 58 for exact-artifact hosted qualification.

## Runtime maintenance candidate - Claude 2026-11-11

- Select Claude Proxy 0.3.23 and Runtime 2.1.322 against signed Catalog 57.
- Pin official bytes including model, MCP OAuth and permission fixes.
- Hosted qualification and immutable publication remain required.

## Runtime maintenance candidate - DeepSeek 2026-11-10

- Select DeepSeek Proxy 0.3.11 and Runtime 0.2.2-rc.1 against signed Catalog 56.
- Pin security-fixed MCP client and fflate dependencies; preserve prior peer support.
- Use native model selection when available and retain the legacy fallback.
- Hosted qualification and immutable publication remain required.

## Runtime maintenance candidate - Antigravity 2026-11-10

- Select Antigravity 0.0.7 and Runtime 1.4.5 against signed Catalog 55.
- Add opt-in bounded cleanup diagnostics while retaining fail-closed behavior.
- Qualification and immutable publication remain required.

## Runtime maintenance candidate - Codex 2026-11-07

- Select Codex 0.3.13 against signed Catalog 55, preserving excluded tuples.
- Pin official Codex 0.167.0 and close expired native approval interactions.
- Required-human approval stays disabled until human origin can be verified.

## Runtime maintenance candidate - Grok 2026-11-07

- Select Grok 0.3.16 against signed Catalog 54, preserving excluded tuples.
- Pin official Grok CLI 1.0.77, with matching official xAI and npm bytes.
- Require hosted qualification and native ACP initialization before publication.

## Runtime maintenance candidate - 2026-11-07

- Select Claude 0.3.22 against signed Catalog 53, preserving excluded tuples.
- Pin the official Claude Code 2.1.319 binary, including upstream permission,
  MCP task and session resume fixes. Hosted qualification remains required.

## Runtime maintenance candidates - 2026-11-05

- Select Claude 0.3.21 against signed Catalog 52 and preserve excluded tuples.
- Upgrade the managed Claude Code Runtime from 2.1.317 to official 2.1.318
  using the pinned official binary. Upstream notes include permission prompt
  timing, session continuation and MCP configuration locking fixes.
- Qualification and immutable publication remain required; real Provider and
  Desktop acceptance are separate.

## Runtime maintenance candidates - 2026-11-04

- Select Claude 0.3.20 against signed Catalog 51 and preserve excluded tuples.
- Upgrade the managed Claude Code Runtime from 2.1.316 to official 2.1.317
  using the pinned official binary. The upstream notes include SDK hook failure,
  network disclosure confirmation and MCP session stability changes.
- Qualification and immutable publication remain required; real Provider and
  Desktop acceptance are separate.

## Runtime maintenance candidates - 2026-11-01

- Select Claude 0.3.19 against signed Catalog 50. Preserve the complete
  excluded Codex, Kimi, DeepSeek Harness, Grok, Antigravity and ZCode tuples
  and all their Runtime pins.
- Upgrade the managed Claude Code Runtime from 2.1.314 to official 2.1.316
  with exact pinned binary bytes; the official 2.1.314 through 2.1.316
  changelog review found no proxy spawn-flag or permission-mode surface
  change, while upstream fixed orphaned shell commands on exit and
  `claude -p` auto-mode stop explanations.
- These are release candidates until the hosted artifact qualification and
  immutable publication steps succeed. Real Provider and Desktop acceptance
  remain separate from artifact qualification.

## Claude Proxy 0.3.18 - 2026-10-31

- Prevent repeated Claude conversation usage updates from causing a session
  protocol failure, while retaining context updates and diagnostic signals.
- Select only Claude against signed Catalog 49. Other Proxy and Runtime
  coordinates are retained; real Provider and Desktop acceptance are separate.

## Runtime maintenance candidates - 2026-10-31

- Select Claude 0.3.17 and Codex 0.3.12 against signed Catalog 48. Preserve
  the complete excluded Kimi, DeepSeek Harness, Grok, Antigravity and ZCode
  tuples and all their Runtime pins.
- Upgrade the managed Claude Code Runtime from 2.1.312 to official 2.1.314
  with exact pinned binary bytes; the official changelog from 2.1.312 through
  2.1.314 was reviewed.
- Upgrade the managed Codex Runtime from 0.165.0 to official 0.166.0 with
  exact pinned archive bytes; the app-server schema delta is additive and the
  removed review `detached` delivery mode is unused by this Proxy.
- These are release candidates until the hosted artifact qualification and
  immutable publication steps succeed. Real Provider and Desktop acceptance
  remain separate from artifact qualification.

## Runtime maintenance candidates - 2026-10-30

- Select Antigravity 0.0.6 against signed Catalog 46. Preserve the complete
  excluded Claude, Codex, Kimi, Grok, DeepSeek Harness and ZCode tuples and
  all their Runtime pins.
- Upgrade the managed Antigravity ACP Runtime from 1.4.3 to official ACP
  registry 1.4.4 with the pinned official pair archive.
- These are release candidates until the hosted artifact qualification and
  immutable publication steps succeed. Real Provider and Desktop acceptance
  remain separate from artifact qualification.

## Runtime maintenance candidates - 2026-10-29

- Select Claude 0.3.16 and Codex 0.3.11 against signed Catalog 45. Preserve
  the complete excluded Kimi, Grok, DeepSeek Harness, Antigravity and ZCode
  tuples and all their Runtime pins.
- Upgrade the managed Claude Code Runtime from 2.1.310 to official 2.1.312,
  with its exact binary size and SHA-256 pinned for macOS Apple Silicon. The
  official 2.1.311-2.1.312 changelog documents no headless spawn or wire
  contract change.
- Upgrade the managed Codex Runtime from 0.164.0 to official 0.165.0, with
  its exact archive size and SHA-256 pinned for macOS Apple Silicon. The
  app-server schema delta is one additive `modelNotFound` error variant on
  existing surfaces.
- Retain first-party official-account quota inspection on both Proxies.
  These are release candidates until the hosted artifact qualification and
  immutable publication steps succeed. Real Provider and Desktop acceptance
  remain separate from artifact qualification.

## Kimi Proxy 0.4.14 - 2026-10-28

- Fix repeated TodoList and plan-review updates that return to an earlier
  state reusing an event identity, which could prevent Gian from receiving
  subsequent output and the completed-turn notification.
- Preserve adjacent-plan suppression and native-event replay idempotency.
- Upgrade the managed Kimi Code Runtime from 2.3.2 to official 2.3.3, with
  its exact archive size and SHA-256 pinned for macOS Apple Silicon.
- Only Kimi is selected against signed Catalog 43. Other Proxy and Runtime
  coordinates are unchanged. Real Provider and Desktop acceptance remain
  separate from hosted artifact qualification.

## Official quota candidates - 2026-10-27

- Select Claude 0.3.15, Codex 0.3.10, Kimi 0.4.13, Grok 0.3.15,
  DeepSeek Harness 0.3.9 and Antigravity 0.0.5 against signed Catalog 41.
  Preserve the complete excluded ZCode tuple and all existing Runtime pins.
- Add structured read-only official-account quota readers with first-party
  identity checks, bounded requests and explicit unsupported/auth/error states.
- Accept Antigravity help on stderr and its supported native quota-group
  envelopes without sending a model prompt or confusing CLI and ACP accounts.
- Project complete Kimi main-agent cumulative Token totals with cache counted
  once. Context occupancy and placeholder metadata are not consumption.
- These are release candidates until the hosted artifact qualification and
  immutable publication steps succeed. Real Provider and Desktop acceptance
  remain separate from artifact qualification.

## Runtime maintenance candidates - 2026-10-26

- Kimi Proxy 0.4.12 pins Kimi Code 2.3.2 (GitHub latest, published
  2026-10-25; archive SHA-256 matches the official asset metadata). The
  2.3.1-to-2.3.2 diff touches no kap-server file (22 files across agent-core
  swarm/tooling, transcript folding and docs; shared tool-driven swarm entry
  is now disabled until the user enables swarm mode, which can affect
  web-runtime behavior - this Proxy declares/enables no swarm policy and its
  generic isError/replay handling stays compatible). A bounded no-Provider native
  probe confirms 2.3.2 serves the same 112 REST paths and the production
  token layout.
- Only Kimi is selected against signed RichToyo Catalog 40. All other
  published tuples are preserved exactly. Real Provider turns and target
  installation are not claimed.

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
