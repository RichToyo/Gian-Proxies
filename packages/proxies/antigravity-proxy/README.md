# @gian/antigravity-proxy

Gian adapter for Google's official Antigravity ACP Server. Sessions use ACP,
not `agy --print`.

The Proxy uses `gian.proxy/2.2` or `2.3` toward Host and ACP 1 toward the
official server. One Proxy/ACP connection serves one Agent/Runtime binding;
upstream owns a separate local harness for each native session. Only native
Gemini model choices are offered. Unsupported capabilities are not advertised.

## Runtime

The recommended Runtime is the `agy` CLI, version 1.5.9 or later, launched as
`agy acp` (its built-in ACP server; see the
[official ACP guide](https://antigravity.google/docs/ide/extensions/acp/)).
The official installer puts it at `~/.local/bin/agy`:

```sh
curl -fsSL https://antigravity.google/cli/install.sh | bash
node dist/src/cli/spawn.js --antigravity-bin /absolute/path/to/agy
```

The binary's file name decides how it starts: `agy` (`agy.exe` on Windows)
runs as `agy acp` with no harness file. Any other name is the legacy
standalone server: keep `agy_acp_server.par` and `localharness_external` from
the same official archive together, and the Proxy verifies that companion and
passes it as `ANTIGRAVITY_HARNESS_PATH`.

```sh
node dist/src/cli/spawn.js --antigravity-bin /absolute/runtime/agy_acp_server.par
```

Discovery offers `agy` from `~/.local/bin` and `PATH` first, then extracted
server pairs. The probe sends one ACP `initialize`: `agy acp` must report
`Antigravity ACP Server` at 1.5.9 or later (older CLIs are rejected with an
update hint), and the legacy server must report `antigravity-acp`.

The standard `GIAN_RUNTIME_BIN` exact launch binding is also accepted.

`agy acp` uses the credentials cached by an interactive `agy` session, so the
CLI login is the session login. The agy CLI has no Gemini home override: it
always reads the OS account's `~/.gemini` and Keychain sign-in. For an `agy`
Runtime the Proxy therefore does not map `GIAN_AGENT_HOME` or `GEMINI_HOME`
onto the child (it removes `GEMINI_HOME`), and the probe reports `~/.gemini`
as the config home, whatever Agent HOME the Host bound. Every `agy` the Proxy
starts gets `AGY_CLI_DISABLE_AUTO_UPDATE=true`, so the CLI never replaces its
own binary under a running Proxy; a user's terminal `agy` keeps updating.

For the legacy `.par` server, an explicit `GIAN_AGENT_HOME` maps to the
Gemini root, otherwise `GEMINI_HOME` and then the official `~/.gemini` default
apply. Do not use the nested `antigravity-acp` directory as the Gemini root.
The legacy server keeps its own ACP credential namespace; CLI credentials are
never copied into it. On macOS, Keychain credentials are not isolated merely
by changing the filesystem HOME.

The installed `agy --output-format json models` query supplies the cold
Gemini catalog only when `HOME` is the OS account home. When the Runtime is
`agy`, that same binary answers the query, so it always describes the
session's account and an Agent HOME does not block it. For a legacy `.par`
Runtime the helper is `~/.local/bin/agy`, then `/opt/homebrew/bin/agy`, then
`/usr/local/bin/agy`, and the effective Gemini root must also be the user's
default `~/.gemini`: a managed `GIAN_AGENT_HOME` or `GEMINI_HOME` is rejected
before the CLI starts, because that server may hold a different login. The
Proxy does not point the CLI at another account and does not read CLI
credential files. A missing CLI is an unavailable catalog, not an empty one.
The query does not create an ACP session or send a prompt.

## Account quota

On `gian.proxy/2.3`, `account.quota.read` reads the separately signed-in
official CLI account with `agy -p /usage --output-format json`. This is a
native read-only command, not a model turn or the session Runtime. It uses
the same default-HOME and helper-discovery boundaries as the cold catalog.
With an `agy` Runtime the helper is that binary; a legacy `.par` Runtime
alone does not supply the separate `agy` helper.

Metadata preflight rejects unknown versions and CLI releases older than
1.1.11 before sending a print command. The supported family is 1.x. Queries
force slash-command handling on, close stdin, use an isolated working directory,
cap output and execution time, and stop the owned helper on sign-in requests.
They never answer a login prompt, copy credentials or alter account settings.

Responses carry `source: "cli"` and no invented account identity. The menu says
`CLI account`, because a legacy `.par` Runtime may be signed into a different
account than the CLI.
Failed refreshes discard old CLI values; account changes are not monitored
continuously. Missing fractions stay unknown, and G1 credits are not presented
as money. This query does not contribute to Gian's local Token statistics.

[Official read-only print-mode release notes](https://www.antigravity.google/docs/changelog/#v1111).

## Authentication

With the `agy` Runtime, sign in with the CLI once, in a terminal:

```sh
agy              # interactive session; sign in, then exit
agy acp --login  # or: sign in with Google by pasting a code, then exit
```

Without cached credentials, ACP requests fail with `Authentication required`
(code `-32000`). The Proxy reports that as `RUNTIME_AUTH_REQUIRED` with the
sign-in hint above, and does not resend the prompt.

The legacy `.par` server does not see the CLI login. Explicit personal
login through ACP `authenticate` (`oauth-personal`) works with either binary:

```sh
node dist/src/cli/spawn.js --antigravity-bin /absolute/path/to/agy --authenticate
node dist/src/cli/spawn.js --antigravity-bin /absolute/runtime/agy_acp_server.par --authenticate
```

This command invokes the official OAuth flow and may open the system browser.
It is never run by discovery, catalog inspection or the bootstrap probe.
Those checks establish executable/protocol readiness, not successful login.

## Boundaries

- Same-session turns are serialized; separate sessions and pending approvals
  do not block each other.
- Cancellation uses ACP `session/cancel`; uncertain interrupted/crashed turns
  are never blindly resubmitted.
- Local session close detaches rather than claiming native history deletion.
  The shared server can be stopped once no live session depends on it.
- Host HTTP MCP descriptors are passed per session. The official server also
  merges user-global MCP settings; this is not a host-only customization claim.
- Initial input is text-only. Native advertised multimedia capabilities do
  not by themselves enable Gian attachments, Fork, Side Chat or history replay.
- Initial configuration exposes advertised string selects only; typed boolean
  ACP setters are not coerced into strings or offered as working controls.
- ACP 1.3.0 reports context occupancy through `usage_update.used/size`;
  conversation billing-token totals are unavailable and are not synthesized.
- Proxy 0.0.1 with upstream ACP Runtime 1.3.0 is published (Catalog 29);
  Proxy 0.0.5 with Runtime 1.4.3 is published (Catalog 41);
  Proxy 0.0.6 with Runtime 1.4.4 is published (Catalog 47).
  Proxy 0.0.8 (2026-11-13) and 0.0.9 (2026-11-17) are published with the ACP
  registry Runtime 1.5.0 pair.
  Proxy 0.1.0 with the official Antigravity CLI 1.5.14 as its managed Runtime
  is published (Catalog 73). Proxy 0.1.1 targets agy 1.5.16; publication
  requires successful independent hosted qualification and an exact signed
  Catalog combination.
  `scripts/build-antigravity-runtime.mjs` pins Google's darwin-arm64 release
  archive (the one the official installer's release manifest names) by size,
  SHA-256 and SHA-512, checks that it holds exactly the pinned `antigravity`
  binary, and repacks those bytes as `agy` in a deterministic tar.gz; Dev
  preparation bundles the verified asset for offline installation. Formal
  standalone qualification stages those actual bytes with their computed
  digest at the immutable RichToyo/Gian-Proxies Proxy release coordinate. No
  fabricated asset hash, certificate or published history is stored in the
  source Catalog. Other Runtime product platforms are not part of this
  recipe.
- Dev coordinates select the generic Proxy bootstrap version probe, using the
  exact branch/bundled Proxy entry and an isolated configuration directory.
  The upstream version comes from ACP initialize, never an assumed
  `--version` flag. This does not establish authenticated model readiness.

Architecture: `docs/proposals/0.6.7-antigravity-proxy.md` in GianDev.
Task: <https://github.com/RichLogic/Gian-Dev/issues/179>.

## Branding

`assets/logo.png` is the unmodified Antigravity site favicon retrieved from
Google's favicon service on 2026-10-12. It identifies the upstream product;
the Proxy itself is maintained by Gian, not Google.
