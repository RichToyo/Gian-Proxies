# Troubleshooting

- Sign-in required (`RUNTIME_AUTH_REQUIRED`): Codex reported a missing,
  expired or revoked sign-in for this Agent's HOME. Choose Log in in the
  Agent details, then retry. The message ends with Codex's own text.
- Quota unavailable or timed out: the Host log has one
  `[codex-proxy:quota]` line per failed read, naming the failing step and
  Codex's (redacted) error text. A read that exceeds 25 s reports `timeout`.
- A request timed out (`RUNTIME_UNAVAILABLE`, retryable): one Codex request
  exceeded its own deadline. Other sessions keep running; retry. If Codex
  stops answering entirely, the Proxy restarts the app-server and each
  session reattaches its thread on its next request.
- "Stop not confirmed": Codex did not confirm a stop within 20 s. Gian ended
  the turn, released the thread and reattaches it before the next message.
  Check the native result before sending the work again.
- Runtime stopped: the turn failure includes the most recent Codex stderr
  lines, with credentials redacted. Keep them for the report.
- Native history missing: check that the session still uses the Agent HOME it
  was created with. A thread missing from another HOME is not deleted.
- Fork, Side Chat or steer rejected: wait for the active turn or interaction,
  or use a boundary the session currently allows.
- A Codex feature that needs a server request Gian does not implement (for
  example a dynamic tool or client attestation) fails in Codex and is logged
  as a refused server request.

Report controlled error codes and the Proxy and Runtime versions, without
tokens, account files or unrelated conversations.
