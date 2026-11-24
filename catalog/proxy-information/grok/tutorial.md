# Grok Build

## 1. What it does in Gian

Grok Build Integration runs coding sessions through the official Grok CLI ACP stdio interface. Gian owns Sessions, messages, approvals and history presentation; the Grok Runtime owns model execution and native sessions.

## 2. Capabilities and limitations

The combination supports text, local files, images, tool approval, reasoning, usage and replay. Steer, Rename, Fork, Side Chat and native deletion use Grok's native methods once the Runtime confirms them in the current session; unsupported operations remain unavailable. Model and reasoning effort come from the session's own config options in CLI 1.0.92 and change through the standard `session/set_config_option`; when Grok switches a session's model itself, Gian shows the new model. Turn usage is reported per turn and context usage separately. Real image and Provider turns remain separate acceptance checks.

## 3. Runtime architecture

```text
Gian Host -> Grok Proxy -> grok agent --no-leader stdio -> Grok service
```

The session-scoped Proxy starts Grok with the `workspace` sandbox profile by default; a session can instead request `read-only`, `strict` or an explicit `off`, and the profile is fixed for that process. Gian reports the requested profile, not a confirmed effective sandbox. One Grok process serves the session and its Side Chats; it stops after ten idle minutes and the next message resumes the native session in a new process. Agent HOME directories and login state remain isolated.

## 4. Installation and dependencies

Install from Agent Integrations. Gian downloads Proxy 0.4.0 and the official Grok CLI 1.0.92 from the signed Catalog, then verifies URL, size, SHA-256, version, Manifest and installation receipt before activation.

## 5. First use

After installation, create a Grok Agent and run `grok login` in that Agent's maintenance terminal. A custom model with its own API key in the Agent HOME's `config.toml` also lets sessions start without signing in. Return to Gian, choose a model and reasoning effort from the current Runtime catalog, and begin with a small message/tool-approval task.

## 6. HOME and isolation

Grok authentication, configuration, caches and native history live in the managed Agent HOME. An existing `~/.grok` is not copied automatically and should not be shared to bypass isolation.

## 7. Reverse proxies and custom endpoints

Use authentication and endpoint configuration supported by the Grok CLI: custom models (`[model.<name>]` with `base_url`, `api_backend` and `api_key` or `env_key`) live in the Agent HOME's `config.toml` and appear in the model list. Never place API keys in task messages, Catalog data or Proxy configuration, and do not change the Gian Host address to select a model endpoint.

## 8. Operational notes

- Gian disables independent Runtime auto-update; upgrades use a newly certified Catalog combination.
- Tool decisions must be returned while the Turn is active.
- Interrupt sends a native cancel; if the Turn has not stopped ten seconds later, Gian stops the Grok process and the next message resumes the session.
- After an unexpected Grok exit the session shows as stale with Grok's own error output; the next message resumes it.
- Sign-in problems are reported only when Grok answers with its authentication error code; other errors keep Grok's text and code.
- A Method-not-found result narrows capability; it is never reported as success.
- Finish active Turns before update or removal. Closing UI does not prove model/tool processes stopped.

## 9. Troubleshooting

| Symptom | Check | Next step |
| --- | --- | --- |
| Grok is absent from Catalog | Catalog sequence includes the Grok release | Sync again; do not substitute local source |
| Installation fails | GitHub/x.ai network, digests and receipt | Keep the previous activation and follow the exact error |
| Authentication fails | The selected Agent HOME | Run `grok login` again in that Agent's maintenance terminal, or configure a keyed custom model |
| Steer, Rename or Fork is absent | The Runtime has not confirmed the native method in this session | Use supported actions; do not fabricate extensions |
| A session shows stale | The error text from Grok's error output | Send the next message to resume it; check the Agent HOME's `config.toml` if Grok exits at startup |
| A tool waits indefinitely | An interaction.requested event is pending | Approve in Gian or interrupt the Turn |
