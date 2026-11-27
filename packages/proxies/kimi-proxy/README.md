# @gian/kimi-proxy

Shared Gian Proxy for Kimi Code, driven by the **Kimi Code 2.7 local server
API**: a supervised `kimi web --json` child, its REST routes and the
`/api/v1/ws` conversation feed.

- Host side: newline-delimited JSON-RPC `gian.proxy/2.1–2.3`, served by
  `@gian/proxy-kit`.
- Runtime side: HTTP + WebSocket to the proxy's own loopback `kimi web`.

```sh
node dist/src/cli/spawn.js --kimi-bin /absolute/path/to/kimi
```

Proxy **0.5.2**, targeting the
official Kimi Code Runtime **2.7.2** (`@moonshot-ai/kimi-code@2.7.2`,
darwin-arm64). Hosted qualification and publication are still required.

## Supported Runtime versions

Only **2.7.1 and 2.7.2** are accepted, by `runtime.probe` and again before
`kimi web` starts; anything else fails with a message naming the supported
versions. Reasons:

- 2.7 changed the server the Proxy drives: the session wire (`activity`
  replaces `busy`/`main_turn_active`, `cwd` left `metadata`), unwrapped global
  `session` events replace `event.session.work_changed` envelopes, the
  `usage` occupancy feed became `context`, a main agent can report `ended`,
  and `/messages` and `/children` are gone.
- 2.7.0 is excluded: its turn-boundary fork mis-slices restored sessions with
  in-turn steers (fixed in 2.7.1, upstream #5165).
- Unknown versions, including later 2.7.x patches, are refused: Kimi changed
  its event protocol in a patch release before (2.6.2).
- The legacy protocol (2.1–2.3) and the 2.6 conversation generation were
  removed. Both depended on endpoints 2.7 deleted, were exercised only by
  fakes, and a store written by 2.7 is not readable by them anyway.

## Runtime and home

- The proxy spawns `kimi web --json --no-open --port 0 --host 127.0.0.1
  --log-level silent`. `--json` mints a private in-memory bearer token and
  prints one ready line (`{origin, ws_url, token,
  kimi_agent_protocol_version}`); the shared `server.token` is never read, so
  `kimi web rotate-token` cannot break a running Proxy. `--port 0` avoids the
  silent port+1 fallback of a fixed port. Startup failure reports the CLI's
  stderr tail. A crashed server marks sessions `stale` with a retryable
  `runtime.error`; the next request starts a new server.
- The server must not outlive the Proxy: it keeps the lock of every session
  it opened, and a new server is then refused with 40931 on every turn. A
  small shell watchdog stops the server when its Proxy process is gone. A
  starting Proxy, and a turn refused with 40931, stop leftovers of earlier
  Proxies: a `kimi-code` process adopted by launchd (parent pid 1) that holds
  a "Kimi Code Web" session lock on this host. A user's terminal Kimi or a
  server with a live parent is never touched.
- `GIAN_KIMI_TRACE_FRAMES=1` writes every native conversation frame to the
  Proxy's stderr (first 2000 characters each) for diagnosis.
- `GIAN_AGENT_HOME` (absolute) becomes `KIMI_CODE_HOME` inside the Proxy for
  every reader: the version check, `kimi web`, the probe, customization
  scans and quota. The Host's own `KIMI_CODE_HOME` is only a fallback.
  Every child also gets `KIMI_CODE_NO_AUTO_UPDATE=1`.

## Architecture

```
src/cli/spawn.ts                 proxy-kit server: per-session lanes, overtaking
                                 replies, initialize barrier, pipelined scans
src/protocol/v2-adapter.ts       gian.proxy surface, ledgers, catalog, per-session
                                 notification barriers (Response first)
src/core/service.ts              sessions, turns, interactions, fork/Side Chat,
                                 replay, native list/rename/delete
src/runtime/kimi-runtime.ts      version gate + lazy conversation runtime
src/runtime/server-supervisor.ts `kimi web --json` spawn/ready/stop, watchdog
src/runtime/orphan-servers.ts    leftover servers of killed Proxies
src/runtime/conversation-*.ts    channel, binding, settlement, turn projection,
                                 replay, usage, errors
src/runtime/home.ts, versions.ts home mapping and supported versions
```

## Capability map

| Capability | Mechanism |
|---|---|
| `input.text/localFile/localImage/skill` | `POST /sessions/{id}/prompts` content parts (`image` with a `path` source, `file` with `path`) and prompt-level `skills`. Gian input metadata rides the prompt so replay restores the exact input. |
| `turn.start` | Deterministic `prompt_id`; 40927 is a duplicate. A Gian turn binds to native work only through the prompt id in the native opener. `queued` (2.7.1: another native turn, e.g. a background-notification turn, finishes first) is admitted: the turn binds when its own opener appears, and a foreign turn that ends unclaimed is excluded. `failed` reports the native turn error. |
| `turn.interrupt` | `POST prompts/{id}:abort`; accepted aborts settle as `interrupted` with a 15 s watchdog. A prompt still queued when aborted ends as `interrupted` without a native turn. |
| `turn.steer` | Queue a prompt, then `POST prompts:steer`. If no native prompt is running the steer prompt is withdrawn and the request fails. |
| `interaction` | Native approval/question `interaction` frames; answers only for explicit Host actions via `POST /sessions/{id}/interactions/{iid}`. |
| `session.fork` / `session.fork.atTurn` | `POST /sessions/{id}:fork`. `turn_index` is the **native turn number** (`turn_number`; agent-core `sliceMainRecordsAtTurn` matches the persisted wire turn id, and upstream's own test passes `turns.at(-1).turn_number`), not a position. A Gian turn that spans background continuations forks after its last native turn; older turns are resolved from native history. Unknown or unfinished boundaries → `FORK_BOUNDARY_UNAVAILABLE`. |
| `sidechat.*` | `:fork` of the parent with the child metadata (`parent_session_id`, `child_session_kind: child`) that 2.6's `/children` wrote; opaque encrypted resume refs; close tombstones the ref (`providerDataDeleted:false`). Side Chat children are not offered by `session.native.list`. |
| `session.replay` / attach | `GET /sessions/{id}/agents/main/turns` pages. Cold sessions resume through the WebSocket `subscribe` itself (2.6+ `resumeSessionById`); 2.7 has no raw message history, so input not sent by Gian replays as its native text. |
| `session.rename` / `native.list` / `native.delete` | `POST /profile {title}`, `GET /sessions?busy=false&archived=false`, `POST /sessions/{id}:delete`. |
| `event.usage` | One `delta` per Gian turn: the sum of its native turns' `turn.usage` (input includes cache read/creation). 2.7 exposes no conversation totals (the session wire dropped `usage`; 2.6.3 always sent zeros). Context occupancy comes from the `context` feed. |
| `event.plan` / `event.diff` / reasoning | Native `todo` frames; per-turn `file-history` diffs; reasoning items. |
| Retries and notices | Native `turn.updated` retry state is a `kimi:retry` activity until the step succeeds or the turn ends; `notice` frames become `kimi:notice` activities. |
| `account.quota.read` | Managed Kimi provider only (`excluded` for others). |
| `customization.list/detail` | Read-only filesystem inventory. |

Unsupported: Host MCP injection (`POST /sessions` accepts no inline MCP
servers; writing the user's `mcp.json` would exceed Gian's boundary) and MCP
elicitation (no server route).

## Errors

- Failed turns carry Kimi's own `error.message`; `details` keep `nativeCode`,
  `statusCode`, `requestId` and `endReason`; `retryable` follows the native
  flag. `max_steps` completes with `limit_reached`.
- `auth.*` (login_required, token_missing, token_unauthorized,
  provisioning_required, model_not_resolved), `provider.auth_error` and REST
  40110–40113 become `RUNTIME_AUTH_REQUIRED` with a sign-in / `api_key` hint.
- Other REST business codes map in `normalizeKimiError` (40401
  `SESSION_NOT_FOUND`, 40901/40931 `SESSION_BUSY`, 40927/40932 `CONFLICT`,
  …) and keep the native code in `details`.
- An unsupported Kimi Code version is `RUNTIME_UNAVAILABLE` with the
  supported versions and how to install one.

## Recovery and steering

- A turn never ends with work open: gian.proxy requires every activity that
  entered `running`, every running step and every content stream to be
  terminal before `turn.completed` / `turn.failed`, or the Host quarantines
  the turn. The turn closes whatever Kimi left open right before its
  terminal (`succeeded` when it completed, `cancelled` when it was
  interrupted, fenced or abandoned, `failed` when it failed). A task that a
  later `task.list` snapshot no longer lists has ended even when its own end
  frame was lost (a reconnect), and is closed then.
- Nothing is sent on a stream the Host replaced (a re-attach): the Host
  validates every later event against the new stream. While a re-attach
  stops the abandoned turn the session sends nothing at all; the new stream
  starts afterwards at sequence 1. Event IDs, which
  derive from content, are made unique on a stream: the Host treats a
  repeated ID as a resend that does not advance the sequence.

- The Host re-attaches a session it still had here only after it stopped
  following that stream (its recovery of a stuck or orphaned turn, a session
  fault). A turn that stream still owned is abandoned: it is stopped natively,
  together with any question or approval it waits on, and the re-attach
  waits up to 10 s for Kimi to report the session idle. It is refused with a
  retryable `SESSION_BUSY` only while Kimi still runs other work.
- Kimi can end the running native turn at its next step boundary and run a
  steer as the next native turn. The steer's prompt ID is registered before
  it is sent, that native turn belongs to the same Gian turn, and the Gian
  turn ends only after it. A steer Kimi refuses is withdrawn; an interrupt or
  fence also aborts the turn's steers.

## Verification

- `pnpm --filter @gian/kimi-proxy test`: 121 tests. Unit tests for every
  conversation component, plus an end-to-end suite that drives the real CLI
  through the kit against a fake Kimi 2.7 server (`test/fixtures/
  fake-kimi-server.mjs`) with Host conformance validation.
- Credential-free checks against the real 2.7.2 binary (isolated HOME):
  `--version`, the `--json` ready line, healthz, `kap.md`, session
  create/get/subscribe/fork, `/messages` 404 and `/children` 40001, and the
  built Proxy's initialize/catalog/create/replay/rename/close/native.list/probe.
- Real smoke regression (`scripts/real-smoke.mjs`): the built Proxy driven
  like the Host against the real Kimi Code 2.7.2 with an OpenAI API key in an
  isolated home, with every frame checked by the Host's own
  `HostProtocolValidator` (a violation is what quarantines a turn in Gian): plain, back-to-back and long conversations, approvals,
  questions, interrupts at every stage, steers at every stage, background
  commands and subagents, plans, diffs, compaction, two sessions at once,
  replay, Host re-attach and recovery of stuck turns, and Proxy crash and
  graceful restarts.
