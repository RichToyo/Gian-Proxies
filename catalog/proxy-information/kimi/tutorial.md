# Kimi Code

## 1. What it does in Gian

Kimi Code Integration connects coding sessions through Kimi Code's local server API. Gian displays messages, plans, tools and interactions; the Kimi Runtime owns model work and native sessions. It does not control the Kimi website or parse terminal screens for responses.

The Runtime supplies model and thinking choices. Supporting multiple releases in one Proxy does not make every upstream release interchangeable in a managed installation.

## 2. Capabilities and limitations

- Supports text, local files, images, renaming, native-session discovery and history replay.
- Supports questions, permissions, reasoning, plans and usage. Plans, tool activity and independent Diff events are different capabilities.
- Supports Sidechat and head forks through native server session children. Available actions also depend on session state; turn-boundary forks are not declared.
- Protocol 2.3 exposes read-only customization inventory. Partial visibility or upstream lack of support is not evidence of absent user configuration.
- Supports turn.steer and guarded native-history deletion. Host MCP injection is not declared because the server session-create API does not accept inline MCP servers.

Workspace and permission boundaries remain in effect. File input does not authorize arbitrary paths.

## 3. Runtime architecture

```text
Gian Host
  -> reusable Kimi Proxy
      -> supervised kimi web --no-open process (loopback HTTP + WebSocket)
          -> native sessions and model service
```

The shared-scope Proxy supervises its own loopback server, uses REST requests and a WebSocket event stream, and maps durable native session identities. Shared programs/connections do not authorize mixing Agent HOME directories.

The Runtime owns tool execution. Gian maps interrupt requests to native prompt cancellation and keeps ordinary session closure separate from explicit native-history deletion. A Runtime failure is surfaced as an error. The Agent's login terminal is for Workbench maintenance.

## 4. Installation and dependencies

Install Kimi Code from Agent Integrations. The current target is Proxy 0.4.13 with Runtime 2.3.2. Gian verifies the signed Catalog's exact Runtime archive, Proxy, digests, installation plan, extraction result and actual version before activation.

```text
<dataDir>/runtimes/kimi/<runtime-version>/<artifact-sha256>/kimi
```

Do not substitute another Kimi from PATH. Historical Kimi CLI and later Kimi Code releases must be identified by their actual artifacts. The Manifest compatibility list, Catalog target and local installed version are different facts.

Program installation does not reuse login credentials or require an account-populated Agent HOME. Configure HOME after installation.

## 5. First use

1. Install the Integration and wait for activation, resolving download, digest, extraction and version-check failures first.
2. Add a Kimi Agent. The default HOME is `~/.kimi-code` unless KIMI_CODE_HOME is configured; choose a new managed HOME for independent configuration.
3. Click Log in in that Agent's details to run the CLI login command with its selected HOME. Never send authentication keys as task messages.
4. Check readiness and create a session in an authorized workspace.
5. Try a small task and inspect plans, permissions and completion. Confirm actual Runtime support before using forks or Sidechat.

If restoration fails, preserve the native session and HOME. Clearing history and opening a new session must not be presented as successful restoration.

## 6. HOME and isolation

KIMI_CODE_HOME points to the Agent's state directory. Without an override it defaults to `~/.kimi-code`; a separate managed HOME lives at:

```text
<dataDir>/homes/kimi/<agentId>/
```

It holds CLI configuration, authentication, sessions, caches and logs. Choose a separate managed HOME for another account or history.

HOME is neither the program directory nor a project sandbox. Do not unpack Runtime archives into it or move it to rewrite existing session bindings. Gian does not automatically import or clear custom HOME directories; normal CLI upgrades may still update their data.

## 7. Reverse proxies and custom endpoints

Use the current Kimi Runtime's official Provider/model/endpoint configuration in the selected HOME. Do not copy Claude or Codex settings unchanged, or change the Gian Web/Host address to select a model service.

Check the CLI in that Agent's maintenance terminal before investigating server-API mapping. A plain-text response does not prove compatible tools, images, reasoning or usage semantics.

Use separate Agent HOME directories for different endpoints/accounts. Avoid machine-wide environment changes and never upload authentication, native history or complete HOME configuration to an Issue.

## 8. Operational notes

- Managed updates use the Catalog's complete combination, not an independent CLI auto-update channel.
- A starting CLI does not prove older history is restorable. Report restoration errors and preserve data.
- If another native client occupies a session, wait until it is idle. A stale-history conflict requires reviewing refreshed history before retrying; the Proxy does not retry automatically.
- Usage comes from structured Runtime events or supported queries, not invented values extracted from arbitrary terminal wording.
- Finish this Proxy type's active Turns and maintenance terminals before updating. Hiding a terminal does not stop it.

## 9. Troubleshooting

| Symptom | Check | Next step |
| --- | --- | --- |
| Target differs from a remembered CLI version | Catalog artifact and Manifest compatibility list | Use the certified target, not an arbitrary old/new version |
| No models or authentication failure | This Agent's KIMI_CODE_HOME | Configure it in its own maintenance terminal |
| Fork/Sidechat unavailable | Native session-child support and session state | Use available actions; do not fabricate a fork |
| Restoration times out or becomes invalid | Native session existence and retryability | Preserve history and follow recovery diagnostics |
| Interrupt or Runtime shutdown fails | Native prompt state and process exit | Preserve history and inspect the reported failure |
| File/image input rejected | Current capabilities and path authorization | Use supported, authorized inputs |
| Usage remains unchanged | Runtime version, events and query results | Report redacted versions and stages, not just one terminal line |
