# Codex

Codex Proxy connects Gian to OpenAI's official Codex CLI through its
structured app-server (`codex app-server --listen stdio://`). The managed
Runtime is Codex CLI 0.171.0, OpenAI's darwin-arm64 release package. The
Proxy version and the Runtime version are independent.

One shared Proxy process serves the Codex sessions of a launch binding, and
each session has its own request lane. A slow resume of a large history, a
native-history page or a quota read in one session does not hold up a turn,
an approval or a stop in another. A request that exceeds its own deadline
fails alone; the shared app-server is restarted only when it stops answering
entirely, and then each session reattaches its thread on its next request.

Sessions support text, images and skills, steering, approvals, questions and
MCP elicitation, reasoning, plan, diff and usage events, native-history
discovery and replay, rename, forks at a terminal turn, Side Chat, and
negotiated Gian MCP Host services. Generic local-file input and native-history
deletion are not advertised. Codex server requests that Gian does not
implement are refused instead of guessed at.

Codex uses the sign-in of the Agent's Codex HOME. A missing or expired
sign-in is reported as sign-in required, with Codex's own message, so Gian
can offer the Agent's Log in action.

This source describes a release candidate, not a successful qualification or
publication. Installable Proxy and Runtime URLs, digests and the certificate
identity come from hosted qualification and the signed Catalog. Real account
and Desktop acceptance are separate.
