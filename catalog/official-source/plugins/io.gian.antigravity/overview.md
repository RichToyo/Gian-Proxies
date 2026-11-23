# Antigravity

Antigravity Proxy 0.1.0 connects Gian to the ACP server built into Google's
official Antigravity CLI (`agy acp`). The managed Runtime is agy 1.5.14,
Google's release binary installed as `agy`. The Proxy version and the
Runtime version are independent.

Sessions, the model list and quota all run the same `agy` and use your own
agy sign-in: sign in once with `agy` in Terminal and Gian reuses it. Only
actually advertised Gemini models are exposed. Gian projects supported native
variants into separate Model and Thinking controls and forwards the exact
advertised native model ID. Mode is also native: the Proxy does not replace
it with a Host permission preset.

Text turns, native tool approvals, cancellation, context occupancy and
session detach/resume use the ACP connection. Fork, Side Chat, native history
replay, multimedia input and billing-token totals are not advertised. Native
global MCP configuration can supplement Gian's per-session MCP descriptors;
this is not an isolation guarantee.

Installable Proxy/Runtime URLs, digests and certificate identity come from
hosted qualification and the signed Catalog. App/Desktop and authenticated
model acceptance are separate.

The logo identifies Google's upstream product. The Proxy is maintained by
Gian, not Google. See the [Antigravity CLI guide](https://antigravity.google/docs/cli/getting-started).
