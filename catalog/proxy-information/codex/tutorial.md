# Codex

## 1. What it does in Gian

Codex Integration brings Codex app-server sessions, model choices, tools, approvals and history into Gian. The managed Codex CLI performs the work; Codex Desktop need not be running. Responses come from structured protocols, not webpage or terminal-screen scraping.

The Gian Proxy adapts the protocol. Codex handles the model Provider, endpoint and authentication within the selected Agent's configuration environment.

## 2. Capabilities and limitations

- Supports text, images, declared Skill input, renaming, native-session discovery and history replay.
- Supports Sidechat, session forks, available Turn-boundary forks and turn.steer, subject to session state, boundaries and pending interactions.
- Supports permissions, questions, MCP elicitation, reasoning, Plan, Diff and usage events. Options such as Fast depend on the current Runtime and model.
- Codex server requests that Gian does not implement (dynamic tools, client attestation, external token refresh, legacy approvals) are refused, so the native operation fails instead of waiting or receiving a guessed answer.
- Supports negotiated Gian MCP Host services and protocol 2.3 read-only customization inventory. A CLI's ability to run a tool does not authorize every Host service.
- Does not declare generic input.localFile or native-history deletion. Reading an authorized workspace file is different from attaching an arbitrary file through the protocol.

Use the current app-server model catalog, not a historical fixed list. Service quotas and model capabilities may temporarily prevent use of a listed model.

## 3. Runtime architecture

```text
Gian Host
  -> reusable Codex Proxy
      -> Codex app-server --listen stdio://
          -> native threads and model service
```

The Proxy has shared scope within its launch binding. Structured stdio maps native threads, Turns, tools and interactions to Gian events. Shared scope does not mean that Agents share HOME or that only one app-server can exist on the machine. Program identity, configuration environment and session identity remain separate. Sidechat uses an independent thread, not the parent's history.

Each session has its own request lane in the shared process. A slow resume of a large rollout, a native-history page or a quota read in one session does not delay another session's turn, approval or stop. Every app-server request has its own deadline: ordinary requests 60 s, history requests (thread start, resume, fork, read and each list page) 300 s, a compaction 30 minutes. A request past its deadline fails alone; the Proxy restarts the shared app-server only when a follow-up liveness probe also gets no answer, and each session then reattaches its thread before its next request.

## 4. Installation and dependencies

Install Codex from Agent Integrations. Gian verifies the signed Catalog's Proxy/CLI archives, sizes, digests, Manifest and installation plan, then extracts, checks the actual version and activates them. The managed Runtime of this release is the official Codex CLI 0.171.0 package for darwin-arm64. An existing `codex` 0.100.0 or later can be selected instead and runs as unverified unless it is the verified version.

```text
<dataDir>/runtimes/codex/<runtime-version>/<artifact-sha256>/bin/codex
```

This is not the Codex executable on PATH or a Codex Desktop directory. Do not replace or relink its binary. The Catalog combination is the actual target; historical Manifest compatibility declarations are not an arbitrary version-selection menu. Gian App/Host supplies Node. Network failures must remain diagnosable, not be hidden by disabling signature or integrity checks.

## 5. First use

1. Install Codex Integration and confirm Runtime activation.
2. Add an Agent. The default HOME is `~/.codex`; choose a new managed HOME for isolation.
3. Click Log in in that Agent's details to run `codex login` with its selected HOME. An ordinary Gian conversation is not a login form. Until then, turns and quota report sign-in required (`RUNTIME_AUTH_REQUIRED`) with Codex's own message.
4. Check program and configuration status. A new HOME not inheriting another Agent's login is expected.
5. Create a workspace session and check model, thinking and permission choices. Use Fast only when the Runtime/model provides it.
6. Start with a small task; inspect real approvals, Plan/Diff and completion instead of treating a sent request as success.

Native-session discovery is HOME-scoped. A thread missing from another HOME has not necessarily been deleted.

## 6. HOME and isolation

CODEX_HOME selects the Agent's Codex state root. The Proxy sets it from the Agent HOME that Gian provides (GIAN_AGENT_HOME) for every Codex process it starts, and creates that directory if it is missing, because Codex refuses a CODEX_HOME that does not exist. It defaults to `~/.codex`; a separate managed HOME lives at:

```text
<dataDir>/homes/codex/<agentId>/
```

It contains configuration, login state and native sessions. Each saved Agent has one HOME; choose a managed HOME when a separate account or history is needed.

HOME is not a sandbox. Codex policy and Gian authorization still govern workspace access, commands and networking. Project configuration, program installation and CODEX_HOME are different locations. Gian does not require copying credentials: log in normally in a new HOME or explicitly select an existing one. Existing sessions retain their original binding.

## 7. Reverse proxies and custom endpoints

Use Provider/endpoint settings supported by the current Codex version in this Agent's CODEX_HOME or official maintenance flow. Do not change the Gian Catalog URL or replace the managed CLI path.

Check model identifiers, API protocol, authentication and streaming. A service claiming only Chat Completions compatibility is not necessarily compatible with Codex's required APIs, tools, reasoning or usage reporting. Verify Codex in the same HOME before investigating Gian's adapter.

Keep tokens and API keys out of source, screenshots and Issues. Configure separate Agent HOME directories instead of changing machine-wide variables to switch every session's endpoint.

## 8. Operational notes

- Update the whole certified combination shared by the Proxy type, not the CLI's latest release independently.
- Active Turns and maintenance terminals can delay updates. Queued messages should resume afterward rather than count as permanent Runtime users.
- Use supported fork and Sidechat boundaries; do not edit native thread IDs or merge parent and child identities.
- A tool card is not proof of tool success. Handle native errors and permission requests explicitly.
- Stop answers within a few seconds. Codex confirms a stop only once the turn has wound down; if it does not confirm within 20 s, Gian ends the turn with a "Stop not confirmed" notice, releases the thread from the app-server and reattaches it before the next message.
- Codex processes that Gian starts never update themselves (`check_for_update_on_startup=false`).
- Retaining an older Runtime does not guarantee rollback of a migrated HOME. Preserve logs and native history on failure.

## 9. Troubleshooting

| Symptom | Check | Next step |
| --- | --- | --- |
| Proxy version visible but Runtime missing | Source-development Proxy versus active generation | Install the full Integration and inspect Host state |
| Empty models or quota errors | This HOME's Provider and service status, and the `[codex-proxy:quota]` line in the Host log | Check in the same maintenance terminal, not another HOME |
| Sign-in required | `RUNTIME_AUTH_REQUIRED` with Codex's text | Use Log in for that Agent, then retry |
| Request timed out | `RUNTIME_UNAVAILABLE` (retryable) for one request | Retry; other sessions are unaffected |
| Stop not confirmed | Notice on the stopped turn | Check the native result before resending; the thread reattaches automatically |
| Runtime stopped | Turn failure with recent Codex stderr (redacted) | Keep the text for the report; the next request restarts the app-server |
| Fast is missing | Runtime and model support | Respect the returned capabilities; do not inject undeclared options |
| Native history missing | Agent/session CODEX_HOME binding | Return to the original HOME; do not disguise a new thread as restoration |
| Ordinary file attachment rejected | Declared input types | Read/reference authorized workspace files or use supported inputs |
| Fork or Steer rejected | Turn state, boundaries and interactions | Use currently allowed actions without bypassing lifecycle constraints |
| Update waits or fails | Active tasks, terminals and failure stage | Stop actual users and retry; retain locks, receipts and native history |
