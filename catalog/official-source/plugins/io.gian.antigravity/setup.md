# Installation And Account Setup

Requires Gian 0.6.7 or later. Older Hosts do not fully support creation with
the Proxy's native Mode values; upgrade Gian before using this Proxy.

Gian installs the exact signed Catalog combination for darwin-arm64: this
Proxy with the official Antigravity CLI 1.5.16 as its managed Runtime. You
can instead choose an existing `agy` 1.5.9 or later, such as the one the
official installer puts in `~/.local/bin/agy`. Other managed platforms are
not provided by this release.

Sign in once with the agy CLI: run `agy` in Terminal and complete the Google
sign-in it opens. Gian does not start a sign-in itself. The CLI keeps the
sign-in in your macOS Keychain and `~/.gemini`, and every agy on this Mac
account shares it, including the managed Runtime. Until you sign in, sessions
and the model list report that sign-in is required.

The agy CLI always uses the OS account's `~/.gemini`. An Agent HOME chosen in
Gian does not change where agy reads its settings or sign-in. Keep `HOME` set
to the OS account home. The Proxy never copies credentials.

agy processes that Gian starts do not update themselves, so the managed
Runtime stays at the verified version. Your terminal `agy` keeps updating; a
version newer than 1.5.16 still runs and is shown as unverified until a later
Proxy verifies it.

A user-selected standalone `agy_acp_server.par` still works with its
`localharness_external` sibling, but it keeps a login separate from the CLI.

Never paste account tokens, OAuth callback URLs or credential files into a
conversation or diagnostic report.
