# Installation And Account Setup

Gian installs the exact signed Catalog combination for darwin-arm64: this
Proxy with the official Codex CLI 0.171.0 as its managed Runtime. You can
instead choose an existing `codex` binary of version 0.100.0 or later (the
first with `codex app-server --listen stdio://`). A version other than
0.171.0 still runs and is shown as unverified.

Each Codex Agent has a Codex HOME, its state root for configuration,
sign-in and native sessions. The default is `~/.codex`; a managed HOME lives
under `<dataDir>/homes/codex/<agentId>/`. The Proxy maps the Agent HOME that
Gian provides onto `CODEX_HOME` for every Codex process it starts, and
creates the directory if it does not exist yet. A new HOME does not inherit
another Agent's sign-in or history.

Sign in once per HOME: open the Agent in Gian and choose Log in. Gian runs
`codex login` with that Agent's HOME in a terminal. Until you sign in,
sessions and the quota report that sign-in is required. A ChatGPT
subscription sign-in also enables the read-only quota view; API-key and
cloud-provider accounts have no subscription quota.

Codex processes that Gian starts never update themselves
(`check_for_update_on_startup=false`), so the managed Runtime stays at the
verified version.

Never paste account tokens, API keys, `auth.json` or login callback URLs into
a conversation or diagnostic report.
