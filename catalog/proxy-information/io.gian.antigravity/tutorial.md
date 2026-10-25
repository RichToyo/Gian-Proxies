# Antigravity

## 1. What it does in Gian

The Antigravity Integration connects Google's official Antigravity ACP Server to Gian: create and manage Antigravity sessions in Gian, send text tasks, and review tool activity and approval requests. Proxy 0.0.4 pairs with upstream ACP Runtime 1.4.3; the Proxy and upstream Runtime versions are independent. This is not a wrapper around the separate `agy --print` CLI.

## 2. Capabilities and limitations

Supported: text turns, native tool approvals, cancellation, context occupancy display, and session detach/resume. The model catalog lists only Gemini models actually advertised by the Runtime; Gian projects supported native variants into separate Model and Thinking controls and forwards the exact advertised native model ID. Mode is also native: `default` (normal permission prompts), `auto_edit` (auto-approve file edits), and `yolo` (auto-approve all tools), with conservative `default` as the default.

Not in this release: Fork, Side Chat, native history replay, multimedia input and billing-token totals. Initial input is text-only even when the upstream Runtime advertises additional media capabilities. Real Provider requests require separate acceptance; a successful installation does not prove a successful model request.

## 3. Runtime architecture

```text
Gian Host → Antigravity Proxy → shared ACP Server (agy_acp_server.par + localharness_external) → Gemini
```

The Proxy and the ACP Server speak ACP (Agent Client Protocol) over stdio. One connection serves one Agent/Runtime binding; upstream manages a separate local harness per native session. Closing a session in Gian detaches it and does not delete native history.

## 4. Installation and dependencies

Install the Antigravity Integration from Gian's official Catalog. Gian verifies and prepares the Proxy and its pinned Runtime; the Runtime must keep `agy_acp_server.par` and `localharness_external` together from the same pinned official 1.4.3 archive. Gian does not replace this server with a system `agy` executable. The cold Gemini model query needs the separate official `agy` CLI — a different component from the ACP Server; a missing helper means an unavailable catalog, not an empty model list. See the official ACP setup guide at https://antigravity.google/docs/ide/extensions/zed/ .

## 5. First use

1. Install and prepare the Antigravity Integration in Gian; confirm the Proxy and Runtime verify successfully.
2. When an account is required, sign in through the official ACP authentication flow (an explicit user action that may open a browser).
3. Choose Model, Thinking and Mode for the Agent and start with a small text task; unsupported pairs fail before prompting instead of being guessed or silently replaced.

This guide does not imply this machine has completed real model-request acceptance.

## 6. HOME and isolation

Catalog inspection uses the OS account HOME and its default `~/.gemini` configuration; a managed or custom HOME is rejected for that query. The Proxy never copies credentials and never silently rewrites the selected HOME. Runtime files and account configuration live in separate locations; do not use the nested `antigravity-acp` directory as the Gemini root. On macOS, changing the filesystem HOME does not by itself isolate Keychain state.

## 7. Reverse proxies and custom endpoints

Use only officially supported authentication and endpoint configuration. The Proxy layer offers no custom endpoint setting; endpoint configuration cannot fix a Runtime version or protocol incompatibility. Native global MCP configuration can supplement Gian's per-session MCP descriptors, but that is not an isolation guarantee.

## 8. Operational notes

- Approval buttons return the exact option ID advertised for that request; rejecting is not an allow operation.
- A disconnected, cancelled or uncertain turn is never blindly replayed; inspect its state before continuing.
- Context occupancy is reported when available; monetary usage or billing-token totals are not synthesized.
- Legacy defaults containing a full native variant ID remain accepted when a separate Thinking value is omitted; conflicting explicit selections are rejected, not coerced.

## 9. Troubleshooting

- Catalog unavailable or timed out: check the separate official `agy` helper installation and the default OS HOME/Gemini root, then retry manually; do not clear stored Agent defaults or copy credentials as a workaround.
- Rejected Model/Thinking pair or stale catalog: refresh the current Proxy advertisement and review the retained explicit selection; do not replace it with a guessed native ID or a silent default.
- Runtime not detected or probe rejected: confirm the server and harness from one verified 1.4.3 archive are executable siblings; another ACP agent reporting the same version is not this Runtime.
- Account setup required: use the official ACP sign-in action; a successful version probe does not prove account readiness or a successful model turn.
- Approval no longer pending: reopen the current request; do not replay an option from an older turn.
- Interrupted or crashed turn: inspect native/session state before resending; cancellation or transport uncertainty does not authorize automatic resubmission.
- When reporting issues, include controlled error codes and the Proxy/Runtime versions — never tokens, account files or raw OAuth diagnostics.
