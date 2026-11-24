# @gian/codex-proxy

Shared structured-runtime adapter for Codex app-server.

The process bridges two newline-delimited JSON protocols:

- stdin/stdout facing Gian Host: `gian.proxy/2.1` to `2.3` (JSON-RPC, string
  ids), served by the shared `@gian/proxy-kit` wire server.
- stdin/stdout facing one shared Codex app-server child for all attached Gian
  sessions (`--listen stdio://`, JSONL with the `jsonrpc` header omitted).

Codex CLI 0.100.0 is the minimum version with the umbrella
`codex app-server --listen stdio://` form. The managed Runtime and the
Manifest's verified version are Codex CLI 0.171.0. Its protocol was checked
against the generated app-server schema (credential-free); real Provider turns
are verified separately.

## Concurrency and ordering

Requests run on one kit lane per session (or the Side Chat they target), so
sessions proceed concurrently on the shared app-server. `interaction.respond`,
`turn.interrupt` and `shutdown` overtake the session lane; `initialize` is a
barrier; catalog, native-session list, quota, Runtime probe and customization
requests are pipelined. Notifications are ordered per session: a request
holds only the sessions it acts on, their notifications follow its Response,
and other sessions keep streaming. `sidechat.close` writes its teardown before
its Response.

## Deadlines and recovery

Each app-server request has its own budget: 60 s for control requests, 300 s
for thread start, resume, fork, read and each `thread/list` page, 30 minutes
for `thread/compact/start`, 20 s for `turn/interrupt`. A timeout fails only
that request (`RUNTIME_UNAVAILABLE`, retryable) and triggers one liveness
probe; only a probe that also gets no answer retires the app-server, after
which sessions reattach on their next request. `turn.interrupt` answers once
Codex confirms, the turn ends, or 5 s pass; if Codex never confirms, only that
thread is recovered (turn ended as interrupted, thread unsubscribed and
reattached before its next request).

## Errors, sign-in and quota

Codex's own error text reaches turn failures, including `turn/completed`
TurnErrors and both string and object `codexErrorInfo` forms (variant and
HTTP status go to `details`). `unauthorized`, HTTP 401 and Codex's sign-in
wording map to `RUNTIME_AUTH_REQUIRED` with actionable text, so the Host can
open its account repair. App-server JSON-RPC errors keep their native code. A
bounded, redacted tail of Codex stderr is attached to runtime failures.
Quota reads log one redacted `[codex-proxy:quota]` line per non-ready result
and finish within 25 s.

Only the five interactive server requests (command, file-change and
permission approvals, `item/tool/requestUserInput`,
`mcpServer/elicitation/request`) become interactions. Every other request
fails closed: legacy v1 approvals are denied, `item/tool/call` returns
`success: false`, and anything else gets a JSON-RPC `-32601` error.

## HOME

The Proxy maps `GIAN_AGENT_HOME` onto `CODEX_HOME` at startup (creating the
directory if needed, since Codex rejects a missing `CODEX_HOME`). Without
`GIAN_AGENT_HOME`, an inherited `CODEX_HOME` or Codex's default `~/.codex`
applies.

The entry point may take an absolute managed binary path:

```sh
node dist/src/cli/spawn.js --codex-bin /absolute/path/to/codex
```

Implemented host-facing methods are listed by `initialize`. Process scope is
`shared`. Native list/adopt/replay, rename, steer, and interaction (approvals
plus `requestUserInput`) are advertised. `session.native.delete` and
`integration.mcp.streamableHttp` are not.

Native rollout replay is chunk-read and disk-paged, including exact pinned Fork
ancestry. Total history size is not capped at 64 MiB; individual records and
wire pages remain bounded. Appends reuse the committed read offset, and replay
cursors retain immutable snapshots through file rewrites or attachment close.
Derived replay files are private, disposable caches under the plugin data
directory (or private system temporary storage), never replacements for native
rollouts. Normal attachment/process shutdown removes them; restart rebuilds
history rather than trusting a cache left by an unclean exit.
Background history failures report a Session-scoped diagnostic without changing
its completed Turn or other Sessions. Runtime handler failures also retain the
originating Session when its native thread identity is known. Each thread's
rollout path is cached (seeded by the app-server's `thread.path`) and
revalidated on every lookup, so refreshing history after a turn no longer
walks every rollout under the HOME.

```sh
pnpm -F @gian/codex-proxy typecheck
pnpm -F @gian/codex-proxy test
```
