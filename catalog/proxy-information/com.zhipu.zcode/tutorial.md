# ZCode

## 1. What it does in Gian

ZCode Integration brings ZCode CLI coding sessions, model configuration and activity into Gian. Version 0.5.0 uses the pinned and verified ZCode CLI 0.17.1, built from the open-source ZCode App-source v3.18.2 (commit `fec9759`) and shipped with the Proxy release. It does not use the Runtime embedded in ZCode.app.

## 2. Capabilities and limitations

It supports session creation and resume, history replay, model/configuration snapshots, tool activity, permission interactions, MCP form questions with free-text and optional fields, attachments, renaming, forks, current-turn Steer, subagent activity and per-session Gian MCP injection. Available choices come from actual Runtime snapshots. Native history deletion is unsupported; ordinary closure only detaches Gian ownership. Real Provider requests require separate acceptance: installation alone does not certify a model turn.

## 3. Runtime architecture

```text
Gian Host → ZCode Proxy → workspace-isolated ZCode CLI 0.17.1 Runtime → Provider
```

The inner connection uses structured ZCode Protocol over stdio, and the outer connection uses Gian Proxy protocol. A shared Proxy manages one Runtime process per workspace; requests for different sessions run side by side. A Runtime idle for 10 minutes stops and restarts with the next request, with the same sessions. Closing a Gian session detaches it without deleting native history.

## 4. Installation and dependencies

Install ZCode Integration from Gian's official Catalog. Gian verifies and prepares both the Proxy and its pinned CLI Runtime. ZCode.app is not required, and Gian does not extract a Runtime from the desktop app. Arbitrary executable paths cannot bypass version and digest verification.

## 5. First use

1. Install and prepare ZCode Integration in Gian; confirm Proxy 0.5.0 and CLI 0.17.1 verification.
2. Configure a Provider. `zcode login` signs in a Z.ai or BigModel account only. For an API-key Provider (OpenAI, Anthropic, DeepSeek, Kimi, Qwen, OpenRouter and other built-in templates, or a custom OpenAI-compatible endpoint), add it in the ZCode TUI or Desktop, or write `.zcode/v2/provider_config.json` under the Agent's HOME (a `providerRules` entry with `templateId` and `access: {"type": "api-key", "apiKey": "…"}`, mode `0600`).
3. Select a model and workspace for the Agent, then try a small text task. Other capabilities depend on the actual model and Provider.

This guide does not claim that a real model request has succeeded on the current machine.

## 6. HOME and isolation

ZCode CLI user configuration normally lives at `~/.zcode/v2/provider_config.json`; the CLI can import legacy `~/.zcode/cli/config.json`. The Runtime uses the Agent's selected HOME: the default Agent shares `~/.zcode` with the ZCode CLI, TUI and Desktop. Since ZCode 3.18, sign-in tokens in `credentials.json` are encrypted with a key in the macOS Keychain; the first read of a sign-in created by another ZCode app asks for Keychain access (choose Always Allow). API-key Providers do not use the Keychain. Accounts and configuration from different HOME directories are not interchangeable. Do not copy tokens or clear native history as a repair step.

## 7. Reverse proxies and custom endpoints

Use only endpoints and authentication supported by official ZCode Provider configuration. Gian Proxy, ZCode Provider settings and model reverse proxy are separate layers; endpoint settings cannot repair a Runtime version or protocol mismatch. The Runtime inherits Gian's environment, including `HTTPS_PROXY`, `NO_PROXY`, `SHELL` and `PATH`.

## 8. Operational notes

- Pinned version and digest are compatibility boundaries; upgrades need a new release and verification.
- Model choices come from actual Runtime snapshots, not guesses parsed from config files. Like the ZCode CLI, the Runtime refreshes ZCode's built-in Provider list from Z.ai about once an hour while it runs, so built-in models can change without a new release.
- Close, cancel and native deletion are different actions; do not delete session data for troubleshooting.
- Real Provider requests may incur charges and should be accepted separately.

## 9. Troubleshooting

| Symptom | Check | Next step |
| --- | --- | --- |
| Runtime fails to start | The Runtime's own startup output in the error, installation digest, CLI version | Reprepare the official release and retain diagnostics |
| No models | Official Provider login and configuration | Run `zcode login` (Z.ai/BigModel) or add an API-key Provider under the selected HOME |
| Turn fails with sign-in required | Login, API key, or Keychain access | Sign in again, fix the API key, or allow "ZCode Credential Encryption" in the Keychain prompt |
| Config missing after login | Whether Agent and login HOME match | Log in under the correct HOME |
| Attachments or forks fail | Actual model capabilities and Runtime error | Do not assume a capability absent from the Runtime |
| Concern about history after closure | Whether Gian only detached | Check with the official CLI; do not additionally delete data |
