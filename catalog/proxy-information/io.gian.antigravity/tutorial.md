# Antigravity

## 1. What it does in Gian

The Antigravity Integration connects the ACP server built into Google's official Antigravity CLI (`agy acp`) to Gian: create and manage Antigravity sessions in Gian, send text tasks, and review tool activity and approval requests. Proxy 0.1.1 pairs with the managed agy CLI 1.5.16; the Proxy and upstream Runtime versions are independent. Sessions, the model list and quota use your own agy sign-in.

## 2. Capabilities and limitations

Supported: text turns, native tool approvals, cancellation, context occupancy display, read-only quota, and session detach/resume. The model catalog lists only Gemini models actually advertised by the Runtime; Gian projects supported native variants into separate Model and Thinking controls and forwards the exact advertised native model ID. Mode is also native: `default` (normal permission prompts), `auto_edit` (auto-approve file edits), and `yolo` (auto-approve all tools), with conservative `default` as the default.

Not in this release: Fork, Side Chat, native history replay, multimedia input and billing-token totals. Initial input is text-only even when the upstream Runtime advertises additional media capabilities. Real Provider requests require separate acceptance; a successful installation does not prove a successful model request.

## 3. Runtime architecture

```text
Gian Host → Antigravity Proxy → shared agy acp process → Gemini
```

The Proxy and `agy acp` speak ACP (Agent Client Protocol) over stdio. One connection serves one Agent/Runtime binding. The model list and quota run short `agy` commands with the same binary, so they always describe the account the sessions use. Closing a session in Gian detaches it and does not delete native history.

## 4. Installation and dependencies

Install the Antigravity Integration from Gian's official Catalog. Gian verifies and prepares the Proxy and its pinned Runtime: Google's official Antigravity CLI 1.5.16 binary, installed as `agy`. You can instead choose an existing `agy` 1.5.9 or later, such as `~/.local/bin/agy` from the official installer. A standalone `agy_acp_server.par` with its `localharness_external` sibling still works when selected, but keeps a login separate from the CLI. See the Antigravity CLI guide at https://antigravity.google/docs/cli/getting-started .

## 5. First use

1. Run `agy` once in Terminal and complete the Google sign-in it opens. Gian does not start a sign-in itself.
2. Install and prepare the Antigravity Integration in Gian; confirm the Proxy and Runtime verify successfully.
3. Choose Model, Thinking and Mode for the Agent and start with a small text task; unsupported pairs fail before prompting instead of being guessed or silently replaced.

This guide does not imply this machine has completed real model-request acceptance.

## 6. HOME and isolation

The agy CLI always uses the OS account's `~/.gemini` and the macOS Keychain sign-in; an Agent HOME chosen in Gian does not change where it reads settings or credentials, so every agy on the Mac account shares one sign-in. Keep `HOME` set to the OS account home. The Proxy never copies credentials. agy processes that Gian starts do not update themselves; your terminal `agy` keeps updating normally.

## 7. Reverse proxies and custom endpoints

Use only officially supported authentication and endpoint configuration. The Proxy layer offers no custom endpoint setting; endpoint configuration cannot fix a Runtime version or protocol incompatibility. Native global MCP configuration can supplement Gian's per-session MCP descriptors, but that is not an isolation guarantee.

## 8. Operational notes

- Approval buttons return the exact option ID advertised for that request; rejecting is not an allow operation.
- A disconnected, cancelled or uncertain turn is never blindly replayed; inspect its state before continuing.
- Context occupancy is reported when available; monetary usage or billing-token totals are not synthesized.
- Legacy defaults containing a full native variant ID remain accepted when a separate Thinking value is omitted; conflicting explicit selections are rejected, not coerced.

## 9. Troubleshooting

- Sign-in required: run `agy` in Terminal and sign in, then retry; a successful version probe does not prove account readiness or a successful model turn.
- Catalog unavailable or timed out: check that the selected `agy` is executable and that `HOME` is the OS account home, then retry manually; do not clear stored Agent defaults or copy credentials as a workaround.
- Rejected Model/Thinking pair or stale catalog: refresh the current Proxy advertisement and review the retained explicit selection; do not replace it with a guessed native ID or a silent default.
- Runtime not detected or probe rejected: choose an `agy` 1.5.9 or later; a legacy server needs its harness sibling from the same archive; another ACP agent reporting the same version is not this Runtime.
- Runtime shown as unverified: your own `agy` updated past the verified 1.5.16; it still runs, or choose the managed Runtime.
- Approval no longer pending: reopen the current request; do not replay an option from an older turn.
- Interrupted or crashed turn: inspect native/session state before resending; cancellation or transport uncertainty does not authorize automatic resubmission.
- When reporting issues, include controlled error codes and the Proxy/Runtime versions — never tokens, account files or raw OAuth diagnostics.
