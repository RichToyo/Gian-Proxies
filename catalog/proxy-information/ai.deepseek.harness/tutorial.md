# DeepSeek Harness

## 1. What it does in Gian

DeepSeek Harness Integration connects the DSH Agent runtime to Gian. It is not a thin chat client calling a model endpoint: the Proxy, Bridge, DSH program and profile work together.

You choose a workspace and task settings in Gian; DSH executes through its own Agent/Provider model. Provider, Model, Reasoning and Agent Preset have distinct meanings and are not one ambiguous model-name setting.

## 2. Capabilities and limitations

- Supports text tasks, native-state replay, configuration resolution, reasoning, usage, Step and Request events.
- Trusted existing Gian sessions can resume with binding proof. This is not permission to import arbitrary external native DSH session IDs.
- Permission interactions are available only when the Bridge declares them and can round-trip native requests. Permission presets retain DSH semantics.
- Image and file attachments, skill invocation, steering, fork (head or at a turn), Side Chat and listing native sessions are supported when the connected Bridge reports the native boundary; image input also needs a model that accepts images. Native-history deletion and renaming are not declared. Internal methods are not automatically public Host capabilities.
- Interrupts and approvals never wait behind another session's work: each Gian session has its own request lane in the Proxy and the Bridge.
- Failures show DSH's own error text. A missing or rejected credential is reported as sign-in/credential required with the file to edit; rate limits and transient server errors are marked retryable; quota exhaustion and content refusals are not.
- Usage counts cached prompt tokens inside input tokens and reports context occupancy against the model's advertised window.
- Customization inventory distinguishes readable, partially visible and upstream-unsupported data. Unsupported does not mean absent.

Do not treat all tool activity as successful or claim complete question/MCP integration without Bridge evidence.

## 3. Runtime architecture

```text
Gian Host
  -> DSH Proxy (gian.proxy)
      -> gian profile in the DSH process
          -> @gian/dsh-bridge (gian.dsh.bridge/1.0)
              -> native DSH sessions, Agents, Providers and model service
```

The Proxy has shared scope. The Bridge runs in the DSH profile, converts native behavior to the explicit bridge protocol, and the Proxy converts that to Gian's protocol. The Bridge is not a network reverse proxy or another user-selected CLI path.

Processes, binding proofs and native-session ownership constrain restoration. Do not take over another active owner. Closing a Gian session must not implicitly delete vendor history.

## 4. Installation and dependencies

The complete installation needs Gian's Node environment, managed DSH Runtime, DSH Proxy and matching Bridge/profile. The new-repository DSH Proxy bundles its Bridge rather than waiting for an App release to supply it.

```text
<dataDir>/runtimes/deepseek-harness/<runtime-version>/<artifact-sha256>/
  node_modules/@deepseek-ai/dsh/lib/bin.js

<verified DSH Proxy directory>/
  proxy.mjs
  bridge/
```

These are program components, not account settings. Install the complete signed Catalog archive and plan; do not run npm update inside managed directories or replace the Bridge independently. An unchanged component version still needs to belong to the current combination.

Before actual startup, the Proxy prepares/checks its `gian-<hash>` profile in DSH_HOME so the Bridge resolves. This controlled profile is distinct from the user's model-service configuration.

Every DSH the Proxy starts runs with `DSH_TELEMETRY_DISABLED=1` (no OpenTelemetry export) and with the DeepSeek Session-log upload (`session-log-deepseek`, the `dsh_session_log` field DSH otherwise adds to official DeepSeek API requests) disabled. The upload switch is a `--patch` overlay the Proxy writes as `gian-launch.patch.yml` in its profile, so it outranks `$DSH_HOME/cordis.patch.yml`. Other DSH instances you run yourself keep their own settings.

## 5. First use

1. Install DeepSeek Harness Integration and wait for the Proxy, DSH Runtime and dependencies to pass checks and activate.
2. Add an Agent. The default HOME is `~/.dsh`; choose a new managed HOME for isolation.
3. Give that HOME a Provider credential. DSH lists a Provider's models only once its key resolves; until then Gian reports that a credential is required and names the file. For DeepSeek, put the key in `<HOME>/.credentials.yaml`:

   ```yaml
   version: 1
   refs:
     DEEPSEEK_API_KEY: sk-...
   ```

   Other Providers (for example OpenAI through DSH's pi-ai adapter) also need a route in `<HOME>/cordis.patch.yml`, which every profile of that HOME reads:

   ```yaml
   - id: llm-pi-ai
     config:
       providers:
         openai:
           apiKeyEnv: OPENAI_API_KEY
   - id: agent-default-model
     config:
       provider: openai
       model: gpt-5.4-mini
   ```

   with `OPENAI_API_KEY` under `refs:` in `.credentials.yaml`. DSH Web (`DSH_HOME=<HOME> dsh web`) can save keys, because keys go to the shared `.credentials.yaml`, but its other settings (Provider routes, default model) are saved into the `web` profile and are not seen by Gian's profile.
4. Check the Provider, Model, Reasoning and Agent Preset options actually returned by DSH/Bridge.
5. Try a small workspace task and inspect tools, permission presets and completion. Program installation does not complete Provider account setup.

On Bridge/profile failure, preserve diagnostics and directory state, repair dependencies and retry. Do not disguise an empty new native session as recovery.

## 6. HOME and isolation

DSH_HOME points to the Agent's state directory. It defaults to `~/.dsh`; a separate managed HOME lives at:

```text
<dataDir>/homes/ai.deepseek.harness/<agentId>/
  .credentials.yaml
  cordis.patch.yml
  profiles/gian-<hash>/
    package.json
    gian-launch.patch.yml
```

The Proxy maps Gian's Agent HOME to `DSH_HOME` itself. The `<hash>` follows the Gian data directory, Runtime and Proxy paths, so each update or a side-by-side development install gets its own profile; on launch the Proxy removes earlier `gian-<hash>` profiles whose Bridge link points at a removed install, and leaves live and foreign profiles alone. Credentials, `cordis.patch.yml` and sessions stay in the HOME, not in the profile.

`~/.agents` (global `AGENTS.md` and skills) is shared by every HOME on purpose: it is your cross-tool instruction root and holds no credentials or sessions. Set `DSH_AGENTS_HOME` in the environment Gian starts from if a HOME must not see it.

DSH manages configuration, authentication and sessions in its HOME/profile; exact files depend on the DSH version. The Bridge in the Proxy archive is program code. Do not mix these locations or copy them over one another as a dependency repair.

Choose a separate managed HOME for another account or configuration. Gian does not clear custom HOME directories; the CLI and controlled profile preparation may normally read/write them. HOME isolation does not replace workspace permissions or DSH execution policy.

## 7. Reverse proxies and custom endpoints

Custom endpoints belong to DSH Provider configuration. Configure them in the selected HOME's `cordis.patch.yml` (for example a `baseURL` on an `llm-pi-ai` provider route) using the current DSH format, and verify the model's association with that Provider.

The Bridge stdio channel and Gian Catalog URL are not model Base URLs. DSH has its own Provider and Agent Preset layers; another CLI's environment-variable names are not automatically equivalent.

Verify DSH can read the Provider configuration before diagnosing the Bridge/Proxy. Keep credentials in vendor configuration, not Catalog data, Manifests or distribution archives.

## 8. Operational notes

- Update the coordinated component set, not a single npm package. Mixing Bridge versions can break protocols or configuration.
- Do not edit session IDs, binding proofs or profile links to seize another process's session.
- Respect the scopes of Provider, Model, Reasoning and session-bound Agent Preset; changing one can require resolving the others again.
- Do not infer permission semantics from labels such as Full access. Use the native preset and actual requests returned by DSH.
- Logs should identify failure stages and component versions, without complete Provider settings, account files or HMAC material.

## 9. Troubleshooting

| Symptom | Check | Next step |
| --- | --- | --- |
| @gian/dsh-bridge missing | Complete published Proxy package | Restore/reinstall the complete Integration, not an unknown Bridge copy |
| gian profile will not start | Profile completeness and matched components | Repair through normal installation/startup; retain HOME |
| Credential required / empty models | `<HOME>/.credentials.yaml` and `<HOME>/cordis.patch.yml` of the Agent's HOME | Add the key (and route) there; settings saved in DSH Web's `web` profile do not reach Gian's profile |
| Native restoration rejected | Active owner and Gian binding proof | End the old owner normally; do not bypass binding proof |
| Attachments, forks or Side Chat unavailable | Capabilities the connected Bridge declared; image input also needs an image-capable model | Update to the certified Proxy/Runtime combination; do not silently discard attachments |
| DSH fails to start | The error text, which ends with DSH's own stderr | Fix the reported profile/Runtime problem, then retry |
| Permission interaction missing | Bridge declaration and native round trip | Report redacted protocol/version evidence, not invented permission labels |
| Node/program startup fails | Gian Node, DSH and Bridge integrity | Restore the certified combination for the failed stage, not the machine-wide Node installation |
