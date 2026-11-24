# Troubleshooting

- Sign-in required: run `agy` in Terminal and complete the Google sign-in,
  then retry. Gian reuses that sign-in. A successful version probe does not
  prove account readiness or a successful model turn.
- Catalog unavailable or timed out: check that the selected `agy` is
  executable and that `HOME` is the OS account home, then use manual retry.
  Do not clear stored Agent defaults or copy credentials as a workaround.
- Rejected Model/Thinking pair or stale catalog: refresh the current Proxy
  advertisement and review the retained explicit selection. Do not replace it
  with a guessed native ID or silent default.
- Runtime not detected or probe rejected: choose an `agy` 1.5.9 or later
  (`agy --version`). A legacy `agy_acp_server.par` needs its
  `localharness_external` sibling from the same archive. Another ACP agent
  reporting the same version is not the Antigravity Runtime.
- Runtime shown as unverified: your own `agy` updated past the verified
  1.5.16. It still runs; choose the managed Runtime for the verified version.
- Approval no longer pending: reopen the current request. Do not replay an
  option from an older turn or Inbox occurrence.
- Interrupted or crashed turn: inspect native/session state before sending
  again. Cancellation and transport uncertainty do not authorize automatic
  resubmission.
- Unsupported Fork, Side Chat, image input or native history replay: these
  capabilities are not implemented by this Proxy; enabling a control or
  changing Mode cannot make them available.

Report controlled error codes and the Proxy/Runtime versions without tokens,
account files, raw OAuth diagnostics or unrelated conversations. Complete
Desktop/reconnect acceptance is separate from Proxy artifact qualification.
