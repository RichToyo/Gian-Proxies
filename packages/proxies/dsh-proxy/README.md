# @gian/dsh-proxy

`ai.deepseek.harness` — shared-scope Gian Proxy speaking `gian.proxy/2.1+`
(JSON-RPC 2.0 / NDJSON / stdio) and supervising one shared DSH Host per launch
binding. Each binding owns a `gian-<hash>` profile below the shared `DSH_HOME`,
so formal and development installations share credentials, history, and official
settings without rewriting one another's Runtime or Bridge composition.

## Layout

- `manifest.json` — Manifest v4 (`id: ai.deepseek.harness`, `process.scope:
  shared`, protocol range `>=2.2 <3.0`, verified runtime `0.2.2-rc.5`).
- `src/core/service.ts` — session/turn projection, stable `sourceTurnId` /
  `stepId` / `eventId` identity, terminal-state enforcement, runtime-exit
  terminalization.
- `src/protocol/v2-adapter.ts` — `gian.proxy` dispatcher and capability
  narrowing from verified bridge facts.
- `src/runtime/bridge-client.ts` — bridge/1.0 JSON-RPC client + DSH child
  supervisor (start/request timeouts, POSIX process-group shutdown, exit
  fan-out).
- `src/cli/spawn.ts` — stdio entry.

## Runtime baseline

The source candidate targets `@deepseek-ai/dsh@0.2.2-rc.5` at official
tag `dsh-v0.2.2-rc.5` (commit `9c2670d3bce5275e0d1610272958121af87787bb`).
The published baseline is still 0.2.2-rc.3 until rc.5 passes exact-artifact
qualification. rc.4 added the `CONTENT_REFUSED` LLM error; rc.5 chooses the
web_search provider per model route.
Capabilities are advertised only when the connected Bridge reports the native
boundary; other operations fail closed with `CAPABILITY_NOT_SUPPORTED`.

## Capability matrix

| Capability | Status | Native evidence |
|---|---|---|
| `input.localFile` / `input.localImage` | supported | `ctx.attachments.saveFile/saveImages` → durable `FileAttachmentRef`/`ImageAttachmentRef` content blocks; admission before turn acceptance |
| `input.skill` | supported | `ctx.skills.get` + runtime `renderSkillContent`; native `skill-invocation` instructions-form injection |
| `turn.steer` | supported | `agent.steer` consumed at the open turn's next step boundary; active-turn-only, retry-idempotent |
| `session.fork` / `session.fork.atTurn` | supported | `agents.create` with `parentSession`/`isSeeded`/verified seed prefix; atTurn cuts at the durable `turn/end` seq; unverifiable boundaries → `FORK_BOUNDARY_UNAVAILABLE` |
| `session.native.list` | supported | `ctx.sessionPersistence.list()` metadata (read-only; subagent and fork-lineage children excluded) |
| `session.resume` / replay | supported (Gian-owned) | `AgentRegistry.resume` behind the per-process Host binding proof; unattested native adoption fails closed (no ownership identity in the storage contract) |
| `event.plan` | supported | `todo/write` → `plan.updated` (stable `planId`, content-derived step ids); `plan/mode` stays a generic activity (different semantics, documented) |
| `event.diff` | supported | `tool/result` `FsDiffMeta` hunks → per-file `diff.updated` with stable `diffId`; no meta → no diff, never guessed from tool arguments |
| `interaction` | supported | approvals + structured user questions (select/multi/text/plan-review), `responseId` idempotency with `CONFLICT` on changed answers, `turn_ended`/`runtime_ended` settlement |
| subagent activity | partial | `subagent/start`/`end` and attributed child tool activity project to agent activities with native runIds; child events are not in the parent durable log, so replay does not re-project them |
| `event.reasoning` / `usage` / `step` / `request` | supported | durable `assistant/message` blocks, per-step usage, step boundaries, request headers |
| `session.rename` | unsupported | `SessionHeader` has no title; `SessionTitleService.rename` exists in 0.2.1-rc.2 and is not connected |
| `session.native.delete` | unsupported | `SessionPersistence` contract exposes create/open/flush/stat/list only — no delete |
| `sidechat` | supported at idle turn boundaries | a native fork creates a transient child with an opaque sealed resume reference; `resume` reattaches it, while `close` detaches and tombstones the reference without claiming Provider data deletion. Active-input anchors remain unavailable. |
| `integration.mcp.streamableHttp` | unsupported | MCP servers are static profile plugin instances with no session isolation boundary; Host MCP injection fails loud (`hostServices` rejected) |
| `customization.list` | partial | `skill` kind inventories `ctx.skills` read-only (`provider_api`, stable `ci1_` ids); `mcp`/`hook`/`rule` answer `provider_unsupported` — no enumeration API in this build |
| Agent Presets vs approval mode | distinct | Agent Presets stay session-bound (`agent_preset`); approval maps to real `ctx.permissionPresets` presets (`permission_preset`) |

Catalog Provider, model, and reasoning selections use the native Agent model
API when available and the legacy per-Agent waterfall on older DSH versions;
per-model reasoning choices regenerate on model switch and stale effort clears.
Catalog input descriptors mirror the runtime-truth attachment/skill surfaces.

## Launch, lifecycle and errors

- **Launch policy** — every DSH runs with `DSH_TELEMETRY_DISABLED=1` and
  `DSH_HOME` mapped from the Host's `GIAN_AGENT_HOME`; the managed launch adds
  `--patch <profile>/gian-launch.patch.yml`, which disables
  `session-log-deepseek` (the official-API Session-log upload) above the home
  patch. The Bridge host patch disables the same row for any other launch of
  the profile. Stale `gian-<hash>` profiles (Bridge link dangling) are removed.
- **Requests** — `@gian/proxy-kit` with one lane per Gian session;
  `interaction.respond`, `turn.interrupt` and `shutdown` overtake,
  `initialize` is a barrier, process-level reads are pipelined. The adapter
  holds a session's notifications only while one of its own requests is in
  flight. Bridge requests carry `deadlineAt` 2 s before the client timeout;
  the Bridge refuses or rolls back work after it.
- **Lifecycle** — `start()` waits for the Bridge `initialize` handshake (60 s);
  boot failures and runtime exits report DSH's exit status and a 4 KiB stderr
  tail. EOF, `shutdown`, SIGINT/SIGTERM and crashes close stdin, SIGTERM the DSH
  process group, SIGKILL it after 1.5 s and reap stragglers; a Proxy killed
  outright closes the pipe and the Bridge exits DSH on EOF.
- **Errors** — DSH's own failure text reaches `turn.failed`; credential codes
  become `RUNTIME_AUTH_REQUIRED` naming `<HOME>/.credentials.yaml`, transient
  codes are retryable, and a HOME without a usable Provider answers
  `RUNTIME_AUTH_REQUIRED` from `catalog.list` / `session.create` instead of
  failing `initialize`.
- **Usage** — `inputTokens` includes cache reads/writes (`cachedInputTokens`
  is that part); each step reports context occupancy against the latest
  `request/context` window.

## Identity and replay

`sourceTurnId` (`nativeSessionId:turn:N`), `stepId`, `contentId`, `planId`,
and `diffId` derivations are identical in live projection and replay, and
replay `eventId`s reuse the live hash inputs over the durable native seq — a
Host can reconcile both streams without duplicates. Transient assistant chunks
(live-only in DSH 0.2.1-rc.2) carry attempt/index identity and are never replayed
or fabricated. Approval audit events (`approval/asked`/`decided`) project to
interactions on replay only; live interaction ids come from the answerer
waterfall, which upstream does not correlate with the durable audit id — the
one identity seam upstream does not expose.

## Test

```sh
pnpm -F @gian/dsh-proxy test
```

The suite runs the complete `gian.proxy` contract through
`@gian/proxy-protocol`'s `HostProtocolValidator` against a fake bridge runtime:
initialize identity and capability narrowing, catalog (input descriptors,
permission presets, agent presets), session create/reattach idempotency, turn
lifecycle, steering, fork (head and turn-anchored), Side Chat
create/resume/close, native list, plan/diff projections, interaction
idempotency, replay identity parity, runtime-crash terminalization, and the
real stdio CLI path — zero model calls.
