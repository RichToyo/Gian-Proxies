# Setup

Gian installs the signed Catalog combination for darwin-arm64: this Proxy
with its managed ZCode CLI Runtime, built by Gian from the pinned open-source
ZCode source (App-source v3.18.2, commit `fec9759`, CLI 0.17.1). ZCode.app is
not required and is never used as a Runtime; Gian never downloads or changes
ZCode.app.

Configure a model Provider before the first session. Two ways work:

- Z.ai or BigModel account: run `zcode login` (a ZCode CLI 0.17.1 or later,
  or the login action Gian offers for the Agent). Only these two accounts can
  sign in this way.
- Any API-key Provider (OpenAI, Anthropic, DeepSeek, Kimi, Qwen, OpenRouter
  and the other built-in templates, or a custom OpenAI-compatible endpoint):
  add it in the ZCode TUI or ZCode Desktop, or write
  `<ZCode HOME>/.zcode/v2/provider_config.json` yourself (keep it `0600`).

The default Agent uses `~/.zcode` and shares the sign-in and Providers of the
ZCode CLI, TUI and Desktop on this Mac account. A Gian-managed Agent HOME has
its own configuration.

Since ZCode 3.18, sign-in tokens in `credentials.json` are encrypted with a
key kept in the macOS Keychain ("ZCode Credential Encryption"). The first
time Gian's ZCode Runtime reads a sign-in that ZCode Desktop or the CLI
created, macOS asks whether to allow access; choose Always Allow to avoid a
prompt for every Runtime start. API-key Providers never touch the Keychain.
