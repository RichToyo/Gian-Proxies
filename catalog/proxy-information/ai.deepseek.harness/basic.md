# DeepSeek Harness: basic information review

The basic-information body is three fixed lines. The notes and status samples below are for review. They are not all shown as extra UI fields.

## Display order and source

| Order | Field | Where the value comes from |
| --- | --- | --- |
| 1 | Runtime path | The Host's current activation receipt. When it is not installed, the planned location returned by the Host |
| 2 | Runtime version | The checked version of the Runtime that is actually current. Do not fill in the latest version when there is no install or valid discovery |
| 3 | Proxy version | The active Proxy, or a source Proxy explicitly labeled as a development source. Otherwise show not installed |

The name and icon stay in the title. Install and update actions and progress come after the three lines. HOME belongs to the Agent. It is not part of Proxy Basic, and it does not enter the signed Catalog.

## Current release-target snapshot

This is the 2026-09-20 Catalog 1.7.0 target, not this machine's install state: Proxy **0.3.1**, Runtime **0.1.1-rc.2**. That distribution from the newer repository bundles Bridge 0.1.3. The Bridge is covered by the whole Proxy archive digest. The dependency is explained in the tutorial. It does not add a fourth Basic line.

Example path shape (Runtime 0.2.0-rc.2 as pinned by current source; `<artifact-sha256>` comes from that version's signed artifact):

```text
<dataDir>/runtimes/deepseek-harness/0.2.0-rc.2/<artifact-sha256>/node_modules/@deepseek-ai/dsh/lib/bin.js
```

`<dataDir>` comes from the running environment. `<artifact-sha256>` comes from the current signed combination. The UI should consume the Host install plan. The Web does not assemble the path itself. Full coordinates are in ../evidence/current-combinations.json.

## Status samples

| State | Runtime path | Runtime version | Proxy version | Action or note |
| --- | --- | --- | --- | --- |
| Nothing prepared | Install location: the planned location returned by the Host | Not installed | Not installed | Install the full integration |
| Source Proxy present, no Runtime | Install location: the planned location returned by the Host | Not installed | 0.3.1, labeled as a development source | Source on disk is not an active certified combination |
| Prepared, user configuration unfinished | Path checked by the Host | Host's current value | Host's current value | Configuration and sign-in are a separate checkpoint. Do not report Ready |
| Update in progress | Keep the old active path | Keep the old current version | Keep the old current version | Target changes and progress appear in the action area |
| Verification failed | A known path may be used for diagnosis, but it is not marked executable | Do not pretend it is compatible | Current known value | State the failure. Do not overwrite current state with latest |

## Do not confuse these

- DeepSeek Harness's Proxy version, Runtime version, and Gian App version are not the same number.
- The latest published version is not the installed version. An installed program is not a finished account or endpoint configuration.
- HOME isolation is not an operating-system sandbox. Choosing an existing HOME shares that vendor's state.

Sources: [contract](../CONTRACT.md), [current combination evidence](../evidence/current-combinations.json), [tutorial](tutorial.md).
