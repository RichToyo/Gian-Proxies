# Gian Proxy Kit

The shared gian.proxy/2 wire server for Gian Proxies. A Proxy supplies its
handler (`handle` + `close`) and its domain error mapping; the kit owns the
wire rules that every Proxy previously re-implemented in its own `spawn.ts`.

The kit is a workspace package. Each Proxy artifact bundles the exact kit
source it was built with, so Proxies keep releasing independently.

## What the kit owns

- **Framing**: strict NDJSON input through `readNdjsonLines` from
  `@gian/proxy-protocol`. Invalid UTF-8 or a line over 16 MiB is a framing
  violation: the kit answers `-32700` with a `null` id, drains in-flight work
  and exits 1.
- **Request shape**: JSON-RPC 2.0, non-empty string ids, object params.
  Malformed lines get a standard JSON-RPC error without domain data (with the
  recovered id when possible) and the loop keeps serving.
- **Notification order**: `emit` output is held while any session-lane or
  overtake request is in flight and written, in emission order, once the last
  of them has been answered. `sidechat.close` releases before its Response
  (Contract §10.5.4). `emitImmediate` writes at once, for notifications no
  in-flight request caused.
- **Dispatch lanes**:
  - session lane (default): strictly serialized, holds notifications. With
    `laneKey`, requests are serialized per key (e.g. per session) and
    different keys run concurrently;
  - `overtakeMethods`: concurrent, so they can answer a runtime blocked inside
    a session-lane request, and still hold notifications;
  - `pipelinedMethods`: concurrent, hold nothing, must not emit;
  - `barrierMethods`: start once every in-flight request has settled; later
    requests wait for them (e.g. `initialize`).
- **Handlers**: `handle(request)` returns the result and the kit writes the
  Response; `dispatch(request, respond)` writes its own Response at the moment
  it calls `respond`, for adapters that order notifications around it. A
  dispatch that settles without responding is answered with an error.
- **Lifecycle**: `shutdown` answers, stops reading, drains every tracked
  request, then calls `close()` once. EOF and SIGINT/SIGTERM drain the same
  way. A failing `close()` exits 1. An uncaught error is reported (by default
  as `runtime.error`; `onCrash` replaces that when error text may carry
  secrets), then `close()` retires the runtime and the Proxy exits 1.
  `failClosedOnDispatchRejection` treats a rejecting request task the same
  way. `writer.maxLineBytes` enforces an outbound frame limit.
- **Entry helpers**: `runSelfTest`, `parseProxyArgs` and `readPluginVersion`
  (pass the caller's `import.meta.url`; omit the fallback to fail closed).
- **Outcome adapters**: `resolveDispatchOutcome` for adapters whose `dispatch`
  returns their request's notifications; `isJsonRpcErrorObject` for error
  mappers that pass ready-made JSON-RPC errors through.

## Usage

```ts
await runProxyServer({
  tag: 'codex-proxy',
  toJsonRpcError: jsonRpcError,
  pipelinedMethods: new Set(['customization.list', 'customization.detail']),
  async createHandler(emit) {
    const adapter = new Adapter(service, PLUGIN_VERSION, emit);
    await service.initialize();
    return {
      handle: (request) => adapter.handle(request),
      close: async () => { await adapter.close(); await service.close(); },
    };
  },
});
```

An adapter that returns its notifications from `dispatch`:

```ts
async createHandler(emit, emitImmediate) {
  const adapter = new Adapter(service, PLUGIN_VERSION, emitImmediate);
  return {
    handle: async (request) => resolveDispatchOutcome(await adapter.dispatch(request), emit),
    close: () => service.shutdown(),
  };
}
```

An adapter that writes its own Responses, serialized per session:

```ts
await runProxyServer({
  tag: 'example-proxy',
  toJsonRpcError: standardError,
  laneKey: (request) => String(request.params.sessionId ?? ''),
  barrierMethods: new Set(['initialize']),
  overtakeMethods: new Set(['interaction.respond', 'turn.interrupt', 'shutdown']),
  async createHandler(_emit, emitImmediate) {
    const adapter = new Adapter(service, PLUGIN_VERSION, emitImmediate);
    return {
      dispatch: (request, respond) => adapter.dispatch(request, respond),
      close: () => adapter.close(),
    };
  },
});
```

## Adopted by

| Proxy | Lanes | Notifications |
|---|---|---|
| `cc-proxy` | session + pipelined customization | adapter deferral released into `emit` |

The other Proxies still run their own loops. They move to the kit one at a
time once `cc-proxy` has shipped on it.
